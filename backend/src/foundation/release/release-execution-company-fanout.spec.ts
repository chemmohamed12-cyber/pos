import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MigrationExecutor } from 'typeorm';
import { ConflictException } from '@nestjs/common';
import { ReleaseExecutionService } from './release-execution.service';
import { Release } from './release.entity';
import { CompanyFanoutBlockedError, CompanyFanoutPlan, CompanyFanoutResult } from './company-fanout.service';
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
 * CTO 2026-10-08 — Company fan-out inside the staged deploy. These specs pin the ORDERING and the ABORT semantics of the engine integration (the fan-out service
 * itself is proven against real Postgres in `company-fanout.real-pg.spec.ts`):
 *   plan (read-only) -> [backup gate: before ANY database is migrated] -> Platform migrations -> Company migrations -> Company verification -> SWAP
 * and that every failure on that path happens PRE-SWAP (no swap, no restart, no `succeeded`).
 */
describe('ReleaseExecutionService — Company fan-out (staged deploy)', () => {
  let releases: Map<string, Release>;
  let stagingRoot: string;
  let auditCalls: Array<{ action: string; result: string; after?: Record<string, unknown> }>;
  let stagedActivationMock: { buildCandidate: jest.Mock; verifyCandidate: jest.Mock; activate: jest.Mock; pruneSlots: jest.Mock; rollbackSwap: jest.Mock };
  let runReleaseMigrationsSpy: jest.SpyInstance;
  let triggerPassengerRestartSpy: jest.SpyInstance;
  let fanout: { plan: jest.Mock; ensureBackups: jest.Mock; migrate: jest.Mock; verify: jest.Mock };

  const planOf = (over: Partial<CompanyFanoutPlan> = {}): CompanyFanoutPlan => ({
    mode: 'on',
    scope: ['core', 'sales'],
    planned: [
      { companyId: 'c-a', companyName: 'Aardvark', databaseName: 'db_a', tags: ['core'], pending: ['CoreNew1'] },
      { companyId: 'c-b', companyName: 'Badger', databaseName: 'db_b', tags: ['core', 'sales'], pending: ['CoreNew1', 'SalesNew2'] },
    ],
    skipped: [{ companyId: 'c-d', companyName: 'Dormouse', reason: 'Company status is SUSPENDED, not READY' }],
    blockers: [],
    ...over,
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

  function buildService(opts: { companyMigrations?: 'off' | 'dry-run' | 'on'; stagedActivation?: boolean; wireFanout?: boolean } = {}): ReleaseExecutionService {
    const { companyMigrations, stagedActivation = true, wireFanout = true } = opts;
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
        ...(companyMigrations ? { companyMigrations, companyBackupPolicy: 'create', companyBackupMaxAgeHours: 24 } : {}),
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

  it('DEFAULT (no setting) = off: the deploy succeeds, says in the audit that no Company database was part of it, and the fan-out service is never touched', async () => {
    const svc = buildService();
    seedRelease();
    const result = await svc.deployRelease('release-under-test', 'admin-1');
    expect(result.status).toBe('succeeded');
    expect(fanout.plan).not.toHaveBeenCalled();
    expect(fanout.ensureBackups).not.toHaveBeenCalled();
    expect(fanout.migrate).not.toHaveBeenCalled();
    const rec = auditCalls.find((c) => c.action === 'release.deploy.company_fanout');
    expect(rec?.after?.mode).toBe('off');
    expect(actions()).not.toContain('release.deploy.company_fanout_plan');
  });

  it('explicit off behaves exactly like the default', async () => {
    const svc = buildService({ companyMigrations: 'off' });
    seedRelease();
    expect((await svc.deployRelease('release-under-test', 'admin-1')).status).toBe('succeeded');
    expect(fanout.plan).not.toHaveBeenCalled();
  });

  it('dry-run: plans and reports, but takes no backup, migrates no Company, and still deploys the Platform', async () => {
    const svc = buildService({ companyMigrations: 'dry-run' });
    seedRelease();
    const result = await svc.deployRelease('release-under-test', 'admin-1');
    expect(result.status).toBe('succeeded');
    expect(fanout.plan).toHaveBeenCalledTimes(1);
    expect(fanout.ensureBackups).not.toHaveBeenCalled();
    expect(fanout.migrate).not.toHaveBeenCalled();
    expect(fanout.verify).not.toHaveBeenCalled();
    expect(actions()).toContain('release.deploy.company_fanout_plan');
    expect(auditCalls.find((c) => c.action === 'release.deploy.company_fanout')?.after?.mode).toBe('dry-run');
  });

  it('on (happy path): plan -> backups -> PLATFORM migrations -> Company migrations -> verify -> SWAP, in exactly that order', async () => {
    const svc = buildService({ companyMigrations: 'on' });
    seedRelease();
    const result = await svc.deployRelease('release-under-test', 'admin-1');
    expect(result.status).toBe('succeeded');
    const o = [order(fanout.plan), order(fanout.ensureBackups), order(runReleaseMigrationsSpy), order(fanout.migrate), order(fanout.verify), order(stagedActivationMock.activate)];
    expect(o).toEqual([...o].sort((a, b) => a - b)); // strictly increasing = that order
    expect(new Set(o).size).toBe(o.length);
    expect(fanout.migrate.mock.calls[0][4]).toEqual([{ companyId: 'c-a', backupRunId: 'bk-a', basis: 'created' }, { companyId: 'c-b', backupRunId: 'bk-b', basis: 'created' }]); // the evidence travels with the run
    expect(actions()).toEqual(expect.arrayContaining(['release.deploy.company_fanout_plan', 'release.deploy.company_backups', 'release.deploy.company_fanout', 'release.deploy.company_fanout_verified', 'release.deploy.swapped', 'release.deploy.succeeded']));
  });

  it('plan blockers (a READY Company that cannot be evaluated) => NO database migrated at all, NO swap', async () => {
    const svc = buildService({ companyMigrations: 'on' });
    fanout.plan.mockResolvedValue(planOf({ blockers: ['Company "Camel" (c-c) could not be evaluated: connect ECONNREFUSED'] }));
    seedRelease();
    const result = await svc.deployRelease('release-under-test', 'admin-1');
    expect(result.status).toBe('failed');
    expect(result.errorMessage).toContain('Camel');
    expect(runReleaseMigrationsSpy).not.toHaveBeenCalled();
    expect(fanout.ensureBackups).not.toHaveBeenCalled();
    expect(fanout.migrate).not.toHaveBeenCalled();
    expect(stagedActivationMock.activate).not.toHaveBeenCalled();
    expect(triggerPassengerRestartSpy).not.toHaveBeenCalled();
    expect(auditCalls.find((c) => c.action === 'release.deploy.company_fanout_plan')?.result).toBe('denied');
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
    expect(runReleaseMigrationsSpy).toHaveBeenCalledTimes(1); // Platform migrated before the Companies
    expect(fanout.verify).not.toHaveBeenCalled();
    expect(stagedActivationMock.activate).not.toHaveBeenCalled();
    expect(triggerPassengerRestartSpy).not.toHaveBeenCalled();
    expect(actions()).not.toContain('release.deploy.swapped');
    expect(actions()).not.toContain('release.deploy.succeeded');
    const failed = auditCalls.find((c) => c.action === 'release.deploy.failed');
    expect((failed?.after?.companyFanout as { migrated: string[] }).migrated).toEqual(['Aardvark']);
    expect(failed?.after?.swapped).toBe(false);
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

  it('fan-out configured but the legacy (non-staged) path selected => refused BEFORE anything is touched (release stays backup_verified)', async () => {
    const svc = buildService({ companyMigrations: 'on', stagedActivation: false });
    seedRelease();
    await expect(svc.deployRelease('release-under-test', 'admin-1')).rejects.toBeInstanceOf(ConflictException);
    expect(releases.get('release-under-test')?.status).toBe('backup_verified');
    expect(runReleaseMigrationsSpy).not.toHaveBeenCalled();
  });

  it('fan-out configured but no CompanyFanoutService wired => refuses LOUDLY (never silently degrades to off)', async () => {
    const svc = buildService({ companyMigrations: 'on', wireFanout: false });
    seedRelease();
    await expect(svc.deployRelease('release-under-test', 'admin-1')).rejects.toThrow(/no CompanyFanoutService is wired/);
    expect(releases.get('release-under-test')?.status).toBe('backup_verified');
  });
});
