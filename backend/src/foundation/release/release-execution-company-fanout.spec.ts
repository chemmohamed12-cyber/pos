import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MigrationExecutor } from 'typeorm';
import { ConflictException } from '@nestjs/common';
import { ReleaseExecutionService } from './release-execution.service';
import { Release } from './release.entity';
import { CompanyFanoutBlockedError, CompanyFanoutPlan, CompanyFanoutResult } from './company-fanout.service';
import { CompanySchemaCheckResult } from './company-schema-check';
import { buildMigrationPreflight } from './migration-preflight';
import { verifyArtifactIntegrity } from './artifact-integrity';

jest.mock('./migration-preflight', () => ({ buildMigrationPreflight: jest.fn(), formatMigrationPreflight: jest.fn(() => '') }));
jest.mock('./artifact-integrity', () => ({
  verifyArtifactIntegrity: jest.fn(),
  formatArtifactIntegrityViolations: jest.requireActual('./artifact-integrity').formatArtifactIntegrityViolations,
}));
jest.mock('./migration-datasource', () => ({
  createMigrationDataSource: jest.fn(() => ({ initialize: jest.fn(async () => undefined), destroy: jest.fn(async () => undefined), migrations: [] })),
  discoverMigrationTags: jest.fn(() => []),
}));
jest.mock('typeorm', () => ({ ...jest.requireActual('typeorm'), MigrationExecutor: jest.fn() }));

/**
 * CTO 2026-10-08 (fan-out) + CTO 2026-10-21 (Company Migration Reliability & Recovery). These specs pin the ORDERING and the ABORT semantics of the Company migration
 * gate inside the staged deploy (the fan-out service itself is proven against real Postgres in `company-fanout.real-pg.spec.ts`, the gate rules in
 * `company-migration-gate.spec.ts`):
 *   plan (read-only, ALWAYS) -> gate -> [backup gate] -> Platform migrations -> Company migrations -> Company verification (pending + schema) -> SWAP
 * and that every failure on that path happens PRE-SWAP (no swap, no restart, no `succeeded`).
 *
 * The rule under test: a release is never swapped in or reported successful while an in-scope Company database still needs migrations, has schema drift, cannot be
 * evaluated, or is outside the plan - whatever RELEASE_COMPANY_MIGRATIONS says.
 */
describe('ReleaseExecutionService — Company migration gate (staged deploy)', () => {
  let releases: Map<string, Release>;
  let stagingRoot: string;
  let auditCalls: Array<{ action: string; result: string; after?: Record<string, unknown> }>;
  let stagedActivationMock: { buildCandidate: jest.Mock; verifyCandidate: jest.Mock; activate: jest.Mock; pruneSlots: jest.Mock; rollbackSwap: jest.Mock };
  let runReleaseMigrationsSpy: jest.SpyInstance;
  let triggerPassengerRestartSpy: jest.SpyInstance;
  let fanout: { plan: jest.Mock; ensureBackups: jest.Mock; migrate: jest.Mock; verify: jest.Mock; verifySchema: jest.Mock };

  const cleanSchema = (): CompanySchemaCheckResult => ({ ran: true, checkedTables: 120, findings: { missingTables: [], missingColumns: {} } });
  const driftSchema = (): CompanySchemaCheckResult => ({ ran: true, checkedTables: 120, findings: { missingTables: ['cash_sessions'], missingColumns: { products: ['itemType'] } } });
  const planOf = (over: Partial<CompanyFanoutPlan> = {}): CompanyFanoutPlan => ({
    mode: 'on',
    scope: ['core', 'sales'],
    planned: [
      { companyId: 'c-a', companyName: 'Aardvark', databaseName: 'db_a', tags: ['core'], pending: ['CoreNew1'], schema: driftSchema() },
      { companyId: 'c-b', companyName: 'Badger', databaseName: 'db_b', tags: ['core', 'sales'], pending: ['CoreNew1', 'SalesNew2'], schema: driftSchema() },
    ],
    skipped: [],
    blockers: [],
    ...over,
  });
  /** Both Companies already current: nothing pending, schema clean. */
  const currentPlan = (): CompanyFanoutPlan =>
    planOf({
      planned: [
        { companyId: 'c-a', companyName: 'Aardvark', databaseName: 'db_a', tags: ['core'], pending: [], schema: cleanSchema() },
        { companyId: 'c-b', companyName: 'Badger', databaseName: 'db_b', tags: ['core', 'sales'], pending: [], schema: cleanSchema() },
      ],
    });
  const okResult = (): CompanyFanoutResult => ({
    ok: true,
    outcomes: [
      { companyId: 'c-a', companyName: 'Aardvark', status: 'migrated', executed: ['CoreNew1'], error: null, finalCompanyStatus: 'READY', durationMs: 5 },
      { companyId: 'c-b', companyName: 'Badger', status: 'migrated', executed: ['CoreNew1', 'SalesNew2'], error: null, finalCompanyStatus: 'READY', durationMs: 5 },
    ],
  });

  function seedRelease(): Release {
    const release = {
      id: 'release-under-test',
      version: '1.1.3-test',
      packageType: 'full',
      baseVersion: null,
      manifest: { version: '1.1.3-test', files: [{ path: 'dist/database/migrations/core/9999999999999-Test.js', action: 'modify', checksum: 'x' }], migrations: [] },
      manifestChecksum: 'x',
      status: 'backup_verified',
      uploadedByUserId: 'admin-1',
      uploadedAt: new Date(),
      backupRunId: 'backup-1',
      completedAt: null,
      errorMessage: null,
    } as unknown as Release;
    releases.set(release.id, release);
    return release;
  }

  function buildService(
    opts: { companyMigrations?: 'off' | 'dry-run' | 'on'; stagedActivation?: boolean; wireFanout?: boolean; skippedPolicy?: 'block' | 'allow'; schemaCheck?: 'enforce' | 'report' } = {},
  ): ReleaseExecutionService {
    const { companyMigrations = 'on', stagedActivation = true, wireFanout = true, skippedPolicy = 'block', schemaCheck = 'enforce' } = opts;
    const releaseRepoMock = {
      findOne: jest.fn(async ({ where }: { where: { id: string } }) => releases.get(where.id) ?? null),
      save: jest.fn(async (r: Release) => {
        releases.set(r.id, r);
        return r;
      }),
    };
    const dataSourceMock = {
      getRepository: jest.fn((entity: unknown) => (entity === Release ? releaseRepoMock : { find: jest.fn(async () => []), save: jest.fn(async (x: unknown) => x) })),
    } as never;
    const configMock = {
      releaseExecution: { appRoot: 'C:/fake-app-root', stagingPath: stagingRoot, frontendRuntimePath: 'C:/fake-frontend', passengerRestartFile: 'C:/fake-restart.txt' },
      releaseDeploy: {
        deployRoot: 'C:/fake-deploy-root', activeDirname: 'backend', manifestsPath: 'C:/fake-manifests', slotRetention: 3, lkgHistoryDepth: 5, healthBaseUrl: 'http://localhost:3000',
        healthEndpoints: [], smokeGetEndpoints: [], smokeSuite: null, migrationDatasource: 'dist/database/data-source.js', expandContractEnforce: true, dependencyChangePolicy: 'block',
        notifyWebhook: null, stagedActivation,
        companyMigrations, companyMigrationsExplicit: true, companySkippedPolicy: skippedPolicy, companySchemaCheck: schemaCheck, companyBackupPolicy: 'create', companyBackupMaxAgeHours: 24,
      },
      releaseBuild: { nodeBin: 'node', npmBin: 'npm', maxThreads: 1 },
      database: { host: 'localhost', port: 5432, username: 'x', password: 'x', database: 'x' },
      entitlement: { mode: 'unlicensed-full', publicKeys: [], clockToleranceMinutes: 10 },
    } as never;
    stagedActivationMock = {
      buildCandidate: jest.fn(async () => 'C:/fake-candidate'),
      verifyCandidate: jest.fn(async () => ({ ok: true, checks: [] })),
      activate: jest.fn(async () => ({ previousPath: 'C:/fake-previous', activePath: 'C:/fake-app-root' })),
      pruneSlots: jest.fn(async () => undefined),
      rollbackSwap: jest.fn(async () => undefined),
    };
    auditCalls = [];
    const auditMock = { record: jest.fn(async (rec: { action: string; result: string; after?: Record<string, unknown> }) => void auditCalls.push({ action: rec.action, result: rec.result, after: rec.after })) };
    fanout = {
      plan: jest.fn(async () => planOf()),
      ensureBackups: jest.fn(async () => [
        { companyId: 'c-a', backupRunId: 'bk-a', basis: 'created' },
        { companyId: 'c-b', backupRunId: 'bk-b', basis: 'created' },
      ]),
      migrate: jest.fn(async () => okResult()),
      verify: jest.fn(async () => ({})),
      verifySchema: jest.fn(async () => ({ Aardvark: cleanSchema(), Badger: cleanSchema() })),
    };
    const svc = new ReleaseExecutionService(
      dataSourceMock,
      configMock,
      {} as never,
      { checkDeploymentGate: jest.fn(async () => ({ allowed: true, backupRunId: 'backup-1' })) } as never,
      { check: jest.fn(async () => ({ ok: true, detail: {} })) } as never,
      {} as never,
      { runPreflight: jest.fn(async () => ({ ok: true, checks: [] })) } as never,
      stagedActivationMock as never,
      { isSeeded: jest.fn(async () => true), seed: jest.fn(async () => undefined), commit: jest.fn(async () => undefined) } as never,
      auditMock as never,
      undefined,
      wireFanout ? (fanout as never) : undefined,
    );
    // private collaborators that are not the subject here (the expand/contract scan, platform migration execution, the restart trigger)
    const priv = svc as unknown as { scanDeltaMigrations: () => Promise<unknown[]>; runReleaseMigrations: () => Promise<void>; triggerPassengerRestart: () => Promise<void> };
    jest.spyOn(priv, 'scanDeltaMigrations').mockResolvedValue([]);
    runReleaseMigrationsSpy = jest.spyOn(priv, 'runReleaseMigrations').mockResolvedValue(undefined);
    triggerPassengerRestartSpy = jest.spyOn(priv, 'triggerPassengerRestart').mockResolvedValue(undefined);
    return svc;
  }

  const actions = () => auditCalls.map((c) => c.action);
  const order = (m: jest.Mock | jest.SpyInstance) => m.mock.invocationCallOrder[0];
  const nothingChanged = () => {
    expect(runReleaseMigrationsSpy).not.toHaveBeenCalled();
    expect(fanout.ensureBackups).not.toHaveBeenCalled();
    expect(fanout.migrate).not.toHaveBeenCalled();
    expect(stagedActivationMock.activate).not.toHaveBeenCalled();
    expect(triggerPassengerRestartSpy).not.toHaveBeenCalled();
    expect(actions()).not.toContain('release.deploy.swapped');
    expect(actions()).not.toContain('release.deploy.succeeded');
  };

  beforeEach(() => {
    releases = new Map();
    stagingRoot = mkdtempSync(join(tmpdir(), 'release-fanout-spec-'));
    mkdirSync(join(stagingRoot, 'release-under-test'), { recursive: true });
    jest.clearAllMocks();
    (buildMigrationPreflight as jest.Mock).mockResolvedValue({
      current: null, target: null, required: [], pending: [], order: [], tagsInScope: ['core'], tagDriftIssues: [], manifestDriftIssues: [], dependencyIssues: [],
      compatibility: { ok: true, reason: 'n/a' }, decision: 'READY_TO_ACTIVATE', blockedReasons: [],
    });
    (MigrationExecutor as unknown as jest.Mock).mockImplementation(() => ({ getPendingMigrations: jest.fn(async () => []) }));
    (verifyArtifactIntegrity as jest.Mock).mockResolvedValue({ releaseId: 'release-under-test', ok: true, violations: [] });
  });
  afterEach(() => rmSync(stagingRoot, { recursive: true, force: true }));

  // ── the mode table ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

  it('off, every Company already current: the plan still runs (read-only), nothing is written, the audit says Companies were verified, the release succeeds', async () => {
    const svc = buildService({ companyMigrations: 'off' });
    fanout.plan.mockResolvedValue(currentPlan());
    seedRelease();
    const result = await svc.deployRelease('release-under-test', 'admin-1');
    expect(result.status).toBe('succeeded');
    expect(fanout.plan).toHaveBeenCalledTimes(1);
    expect(fanout.ensureBackups).not.toHaveBeenCalled();
    expect(fanout.migrate).not.toHaveBeenCalled();
    const rec = auditCalls.find((c) => c.action === 'release.deploy.company_fanout');
    expect(rec?.after?.mode).toBe('off');
    expect(String(rec?.after?.note)).toContain('no Company database needed migrations');
    expect(auditCalls.find((c) => c.action === 'release.deploy.company_gate')?.after?.decision).toBe('PASS');
  });

  it('off while a Company still needs migrations => the deploy is BLOCKED before anything is changed (never a silent platform-only success)', async () => {
    const svc = buildService({ companyMigrations: 'off' });
    seedRelease(); // default plan: both Companies have pending migrations
    const result = await svc.deployRelease('release-under-test', 'admin-1');
    expect(result.status).toBe('failed');
    expect(result.errorMessage).toContain('COMPANY_MIGRATIONS_REQUIRED_BUT_DISABLED');
    expect(result.errorMessage).toContain('Aardvark');
    expect(result.errorMessage).toContain('Badger');
    expect(result.errorMessage).toContain('Nothing was changed');
    nothingChanged();
    expect(auditCalls.find((c) => c.action === 'release.deploy.company_gate')?.result).toBe('denied');
  });

  it('dry-run is PLAN ONLY: reports what a real deploy would do, takes no backup, migrates nothing, swaps nothing, is NOT a failure and leaves the release deployable', async () => {
    const svc = buildService({ companyMigrations: 'dry-run' });
    seedRelease();
    const result = await svc.deployRelease('release-under-test', 'admin-1');
    expect(result.status).toBe('backup_verified'); // not succeeded, not failed: it can be deployed for real afterwards
    expect(result.errorMessage).toBeNull();
    expect(fanout.plan).toHaveBeenCalledTimes(1);
    nothingChanged();
    expect(fanout.verify).not.toHaveBeenCalled();
    expect(actions()).toContain('release.deploy.company_fanout_plan');
    expect(actions()).toContain('release.deploy.plan_only');
    expect(actions()).not.toContain('release.deploy.failed');
    expect(auditCalls.find((c) => c.action === 'release.deploy.company_fanout')?.after?.mode).toBe('dry-run');
    expect(auditCalls.find((c) => c.action === 'release.deploy.company_gate')?.after?.decision).toBe('PLAN_ONLY');
  });

  it('dry-run then on: the SAME release can be deployed for real after a dry-run (the old dry-run made the version "already deployed")', async () => {
    seedRelease();
    const dry = buildService({ companyMigrations: 'dry-run' });
    expect((await dry.deployRelease('release-under-test', 'admin-1')).status).toBe('backup_verified');
    const real = buildService({ companyMigrations: 'on' });
    expect((await real.deployRelease('release-under-test', 'admin-1')).status).toBe('succeeded');
  });

  it('on (happy path): plan -> gate -> backups -> PLATFORM migrations -> Company migrations -> verify -> schema verify -> SWAP, in exactly that order, with per-Company evidence', async () => {
    const svc = buildService({ companyMigrations: 'on' });
    seedRelease();
    const result = await svc.deployRelease('release-under-test', 'admin-1');
    expect(result.status).toBe('succeeded');
    const o = [order(fanout.plan), order(fanout.ensureBackups), order(runReleaseMigrationsSpy), order(fanout.migrate), order(fanout.verify), order(fanout.verifySchema), order(stagedActivationMock.activate)];
    expect(o).toEqual([...o].sort((a, b) => a - b)); // strictly increasing = that order
    expect(new Set(o).size).toBe(o.length);
    expect(fanout.migrate.mock.calls[0][4]).toEqual([{ companyId: 'c-a', backupRunId: 'bk-a', basis: 'created' }, { companyId: 'c-b', backupRunId: 'bk-b', basis: 'created' }]); // the evidence travels with the run
    expect(actions()).toEqual(expect.arrayContaining(['release.deploy.company_fanout_plan', 'release.deploy.company_gate', 'release.deploy.company_backups', 'release.deploy.company_fanout', 'release.deploy.company_fanout_verified', 'release.deploy.swapped', 'release.deploy.succeeded']));
    const evidence = auditCalls.find((c) => c.action === 'release.deploy.evidence')?.after as { layers: { companyMigrationGate: { evaluated: number; migrated: number; failed: number } } };
    expect(evidence.layers.companyMigrationGate).toMatchObject({ evaluated: 2, migrated: 2, failed: 0 });
  });

  // ── what blocks, before anything is changed ─────────────────────────────────────────────────────────────────────────────────────────────────

  it('plan blockers (a READY Company that cannot be evaluated) => NO database migrated at all, NO swap', async () => {
    const svc = buildService({ companyMigrations: 'on' });
    fanout.plan.mockResolvedValue(planOf({ blockers: ['Company "Camel" (c-c) could not be evaluated: connect ECONNREFUSED'] }));
    seedRelease();
    const result = await svc.deployRelease('release-under-test', 'admin-1');
    expect(result.status).toBe('failed');
    expect(result.errorMessage).toContain('Camel');
    nothingChanged();
    expect(auditCalls.find((c) => c.action === 'release.deploy.company_fanout_plan')?.result).toBe('denied');
  });

  it('a NOT-READY Company (SUSPENDED) outside the plan BLOCKS by default: it would later run the new code on the old schema', async () => {
    const svc = buildService({ companyMigrations: 'on' });
    fanout.plan.mockResolvedValue(planOf({ skipped: [{ companyId: 'c-d', companyName: 'Dormouse', reason: 'Company status is SUSPENDED, not READY', status: 'SUSPENDED', scope: 'stale' }] }));
    seedRelease();
    const result = await svc.deployRelease('release-under-test', 'admin-1');
    expect(result.status).toBe('failed');
    expect(result.errorMessage).toContain('Dormouse');
    expect(result.errorMessage).toContain('SUSPENDED');
    nothingChanged();
  });

  it('RELEASE_COMPANY_SKIPPED_POLICY=allow: the release proceeds and every stale Company is recorded in the evidence', async () => {
    const svc = buildService({ companyMigrations: 'on', skippedPolicy: 'allow' });
    fanout.plan.mockResolvedValue(planOf({ skipped: [{ companyId: 'c-d', companyName: 'Dormouse', reason: 'Company status is SUSPENDED, not READY', status: 'SUSPENDED', scope: 'stale' }] }));
    seedRelease();
    const result = await svc.deployRelease('release-under-test', 'admin-1');
    expect(result.status).toBe('succeeded');
    const evidence = auditCalls.find((c) => c.action === 'release.deploy.evidence')?.after as { layers: { companyMigrationGate: { staleCompanies: Array<{ name: string; status: string }> } } };
    expect(evidence.layers.companyMigrationGate.staleCompanies).toEqual([{ companyId: 'c-d', name: 'Dormouse', status: 'SUSPENDED' }]);
    expect(auditCalls.find((c) => c.action === 'release.deploy.succeeded')?.after?.staleCompanies).toHaveLength(1);
  });

  it('a DECOMMISSIONED Company is out of scope: it never blocks', async () => {
    const svc = buildService({ companyMigrations: 'on' });
    fanout.plan.mockResolvedValue(planOf({ skipped: [{ companyId: 'c-d', companyName: 'Dormouse', reason: 'Company status is DECOMMISSIONED, not READY', status: 'DECOMMISSIONED', scope: 'out_of_scope' }] }));
    seedRelease();
    expect((await svc.deployRelease('release-under-test', 'admin-1')).status).toBe('succeeded');
  });

  it('SCHEMA DRIFT: a Company with NOTHING pending whose schema still differs from the new code is BLOCKED before anything is changed (the list looks complete, the schema is not)', async () => {
    const svc = buildService({ companyMigrations: 'on' });
    const plan = currentPlan();
    plan.planned[1].schema = driftSchema();
    fanout.plan.mockResolvedValue(plan);
    seedRelease();
    const result = await svc.deployRelease('release-under-test', 'admin-1');
    expect(result.status).toBe('failed');
    expect(result.errorMessage).toContain('schema drift');
    expect(result.errorMessage).toContain('Badger');
    nothingChanged();
  });

  it('the schema check could not run => an unverified schema is never treated as clean (BLOCKED in enforce); recorded only in report mode', async () => {
    const unrunnable: CompanySchemaCheckResult = { ran: false, checkedTables: 0, findings: { missingTables: [], missingColumns: {} }, error: 'cannot find module' };
    const plan = currentPlan();
    plan.planned[0].schema = unrunnable;
    seedRelease();
    const enforce = buildService({ companyMigrations: 'on' });
    fanout.plan.mockResolvedValue(plan);
    const r1 = await enforce.deployRelease('release-under-test', 'admin-1');
    expect(r1.status).toBe('failed');
    expect(r1.errorMessage).toContain('could not run');
    nothingChanged();
    seedRelease();
    const report = buildService({ companyMigrations: 'on', schemaCheck: 'report' });
    fanout.plan.mockResolvedValue(plan);
    expect((await report.deployRelease('release-under-test', 'admin-1')).status).toBe('succeeded');
  });

  it('a Company without a restore point => NOT EVEN THE PLATFORM is migrated (the gate precedes every migration), NO swap', async () => {
    const svc = buildService({ companyMigrations: 'on' });
    fanout.ensureBackups.mockRejectedValue(new CompanyFanoutBlockedError(['the pre-update backup of Company "Badger" (run bk-x) did not verify']));
    seedRelease();
    const result = await svc.deployRelease('release-under-test', 'admin-1');
    expect(result.status).toBe('failed');
    expect(result.errorMessage).toContain('Badger');
    expect(runReleaseMigrationsSpy).not.toHaveBeenCalled();
    expect(fanout.migrate).not.toHaveBeenCalled();
    expect(stagedActivationMock.activate).not.toHaveBeenCalled();
    expect(auditCalls.find((c) => c.action === 'release.deploy.company_backups')?.result).toBe('denied');
  });

  // ── what happens when a step FAILS after something changed ─────────────────────────────────────────────────────────────────────────────────

  it('a Company fails => NO swap / restart / succeeded; the failure names who was migrated, who failed and who was not attempted; the Platform stays migrated (forward-only)', async () => {
    const svc = buildService({ companyMigrations: 'on' });
    fanout.migrate.mockResolvedValue({
      ok: false,
      outcomes: [
        { companyId: 'c-a', companyName: 'Aardvark', status: 'migrated', executed: ['CoreNew1'], error: null, finalCompanyStatus: 'READY', durationMs: 5 },
        { companyId: 'c-b', companyName: 'Badger', status: 'failed', executed: [], error: 'relation "x" already exists', finalCompanyStatus: 'READY', durationMs: 5 },
        { companyId: 'c-c', companyName: 'Camel', status: 'not_attempted', executed: [], error: null, finalCompanyStatus: 'READY', durationMs: 0 },
      ],
    } as CompanyFanoutResult);
    seedRelease();
    const result = await svc.deployRelease('release-under-test', 'admin-1');
    expect(result.status).toBe('failed');
    expect(result.errorMessage).toContain('migrated: [Aardvark]');
    expect(result.errorMessage).toContain('Badger');
    expect(result.errorMessage).toContain('not attempted: [Camel]');
    expect(result.errorMessage).toContain('ACTIVATION_FAILED_AFTER_MIGRATIONS'); // the Platform migrations completed: the databases are ahead of the active application
    expect(runReleaseMigrationsSpy).toHaveBeenCalledTimes(1); // Platform migrated before the Companies
    expect(fanout.verify).not.toHaveBeenCalled();
    expect(stagedActivationMock.activate).not.toHaveBeenCalled();
    expect(triggerPassengerRestartSpy).not.toHaveBeenCalled();
    expect(actions()).not.toContain('release.deploy.swapped');
    expect(actions()).not.toContain('release.deploy.succeeded');
    const failed = auditCalls.find((c) => c.action === 'release.deploy.failed');
    expect((failed?.after?.companyFanout as { migrated: string[] }).migrated).toEqual(['Aardvark']);
    expect(failed?.after?.swapped).toBe(false);
    expect(failed?.after?.databasesAheadOfActiveApplication).toBe(true);
  });

  it('Company verification finds pending migrations after a reported success => NO swap', async () => {
    const svc = buildService({ companyMigrations: 'on' });
    fanout.verify.mockResolvedValue({ Badger: ['SalesNew2'] });
    seedRelease();
    const result = await svc.deployRelease('release-under-test', 'admin-1');
    expect(result.status).toBe('failed');
    expect(result.errorMessage).toContain('SalesNew2');
    expect(stagedActivationMock.activate).not.toHaveBeenCalled();
    expect(actions()).toContain('release.deploy.company_fanout_verification_failed');
  });

  it('the Company migrations ran but a Company STILL differs from the new code => NO swap; the message says the databases are ahead and the release is re-runnable', async () => {
    const svc = buildService({ companyMigrations: 'on' });
    fanout.verifySchema.mockResolvedValue({ Aardvark: cleanSchema(), Badger: driftSchema() });
    seedRelease();
    const result = await svc.deployRelease('release-under-test', 'admin-1');
    expect(result.status).toBe('failed');
    expect(result.errorMessage).toContain('(after migration)');
    expect(result.errorMessage).toContain('Badger');
    expect(result.errorMessage).toContain('AHEAD of the active application');
    expect(stagedActivationMock.activate).not.toHaveBeenCalled();
    expect(triggerPassengerRestartSpy).not.toHaveBeenCalled();
    const gate = auditCalls.filter((c) => c.action === 'release.deploy.company_gate');
    expect(gate[gate.length - 1].result).toBe('denied');
  });

  it('migrations (Platform + Companies) succeeded but the ACTIVATION failed => reported as ACTIVATION_FAILED_AFTER_MIGRATIONS (databases ahead, active app untouched), never as a success', async () => {
    const svc = buildService({ companyMigrations: 'on' });
    stagedActivationMock.activate.mockRejectedValue(new Error("EBUSY: resource busy or locked, rename 'C:/fake-app-root' -> 'C:/fake-app-root.prev-x'"));
    seedRelease();
    const result = await svc.deployRelease('release-under-test', 'admin-1');
    expect(result.status).toBe('failed');
    expect(result.errorMessage).toMatch(/^ACTIVATION_FAILED_AFTER_MIGRATIONS/);
    expect(result.errorMessage).toContain('EBUSY');
    expect(result.errorMessage).toContain('completed migrations are not repeated');
    expect(triggerPassengerRestartSpy).not.toHaveBeenCalled();
    expect(actions()).not.toContain('release.deploy.succeeded');
    const failed = auditCalls.find((c) => c.action === 'release.deploy.failed');
    expect(failed?.after).toMatchObject({ swapped: false, migrationsCompleted: true, databasesAheadOfActiveApplication: true });
  });

  it('a failure BEFORE any migration is not labelled as "databases ahead"', async () => {
    const svc = buildService({ companyMigrations: 'off' });
    seedRelease();
    const result = await svc.deployRelease('release-under-test', 'admin-1');
    expect(result.errorMessage).not.toContain('ACTIVATION_FAILED_AFTER_MIGRATIONS');
    expect(auditCalls.find((c) => c.action === 'release.deploy.failed')?.after).toMatchObject({ migrationsCompleted: false, databasesAheadOfActiveApplication: false });
  });

  // ── configuration guards ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

  it('fan-out configured but the legacy (non-staged) path selected => refused BEFORE anything is touched (release stays backup_verified)', async () => {
    const svc = buildService({ companyMigrations: 'on', stagedActivation: false });
    seedRelease();
    await expect(svc.deployRelease('release-under-test', 'admin-1')).rejects.toBeInstanceOf(ConflictException);
    expect(releases.get('release-under-test')?.status).toBe('backup_verified');
    expect(runReleaseMigrationsSpy).not.toHaveBeenCalled();
  });

  it('no CompanyFanoutService wired => refuses LOUDLY in EVERY mode, including off (the gate cannot run, so a deploy is never allowed to proceed blind)', async () => {
    for (const mode of ['on', 'off', 'dry-run'] as const) {
      releases = new Map();
      const svc = buildService({ companyMigrations: mode, wireFanout: false });
      seedRelease();
      await expect(svc.deployRelease('release-under-test', 'admin-1')).rejects.toThrow(/no CompanyFanoutService is wired/);
      expect(releases.get('release-under-test')?.status).toBe('backup_verified');
    }
  });
});
