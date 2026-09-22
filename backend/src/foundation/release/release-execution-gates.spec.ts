import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MigrationExecutor } from 'typeorm';
import { ReleaseExecutionService } from './release-execution.service';
import { Release } from './release.entity';
import { ReleaseManifest } from './release-manifest';
import { buildMigrationPreflight } from './migration-preflight';
import { verifyArtifactIntegrity } from './artifact-integrity';

jest.mock('./migration-preflight', () => ({
  buildMigrationPreflight: jest.fn(),
  formatMigrationPreflight: jest.fn(() => ''),
}));

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
 * Regression coverage for the 2026-09-22 RCA (v1.1.1 permission-migration
 * incident): production's audit trail for release 395ca725 showed
 * `expand_contract_violation` recorded DENIED immediately followed by
 * `deploy.swapped SUCCESS` — i.e. a denied gate did not stop the deploy.
 * Root cause traced to `deployReleaseStaged` (release-execution.service.ts):
 * an expand/contract violation only throws (aborts pre-swap) when
 * `config.releaseDeploy.expandContractEnforce` is true; otherwise it is
 * logged as a warning and the deploy proceeds. This file asserts the two
 * invariants the CTO's investigation required before any corrective release:
 * a denied gate (both expand/contract, with enforcement on — the schema
 * default — and Migration Preflight, which has no off-switch) must produce
 * NO SWAP / NO RESTART / NO SUCCEEDED, full stop. A third test documents
 * the enforce=false behavior explicitly, since that is the exact
 * configuration state that would reproduce production's observed sequence.
 */
describe('ReleaseExecutionService — pre-swap gate integrity (I-2)', () => {
  let releases: Map<string, Release>;
  let stagingRoot: string;
  let auditCalls: Array<{ action: string; result: string; after?: Record<string, unknown> }>;
  let stagedActivationMock: {
    buildCandidate: jest.Mock;
    verifyCandidate: jest.Mock;
    activate: jest.Mock;
    pruneSlots: jest.Mock;
    rollbackSwap: jest.Mock;
  };
  let service: ReleaseExecutionService;
  let scanDeltaMigrationsSpy: jest.SpyInstance;
  let runReleaseMigrationsSpy: jest.SpyInstance;
  let triggerPassengerRestartSpy: jest.SpyInstance;

  function validManifest(overrides: Partial<ReleaseManifest> = {}): ReleaseManifest {
    return {
      version: '1.1.2-test',
      files: [{ path: 'dist/database/migrations/core/9999999999999-Test.js', action: 'modify', checksum: 'x' }],
      migrations: [],
      ...overrides,
    };
  }

  function seedRelease(overrides: Partial<Release> = {}): Release {
    const release: Release = {
      id: 'release-under-test',
      version: '1.1.2-test',
      packageType: 'full',
      baseVersion: null,
      manifest: validManifest(),
      manifestChecksum: 'x',
      status: 'backup_verified',
      uploadedByUserId: 'admin-1',
      uploadedAt: new Date(),
      backupRunId: 'backup-1',
      completedAt: null,
      errorMessage: null,
      ...overrides,
    };
    releases.set(release.id, release);
    return release;
  }

  function buildService(expandContractEnforce: boolean): ReleaseExecutionService {
    const releaseRepoMock = {
      findOne: jest.fn(async ({ where }: { where: { id: string } }) => releases.get(where.id) ?? null),
      findOneOrFail: jest.fn(async ({ where }: { where: { id: string } }) => {
        const r = releases.get(where.id);
        if (!r) throw new Error('not found');
        return r;
      }),
      save: jest.fn(async (r: Release) => {
        releases.set(r.id, r);
        return r;
      }),
      getRepository: jest.fn(),
    };
    const dataSourceMock = {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === Release) return releaseRepoMock;
        return { find: jest.fn(async () => []), save: jest.fn(async (x: unknown) => x) };
      }),
    } as never;

    const configMock = {
      releaseExecution: { appRoot: 'C:/fake-app-root', stagingPath: stagingRoot, frontendRuntimePath: 'C:/fake-frontend', passengerRestartFile: 'C:/fake-restart.txt' },
      releaseDeploy: {
        deployRoot: 'C:/fake-deploy-root',
        activeDirname: 'backend',
        manifestsPath: 'C:/fake-manifests',
        slotRetention: 3,
        lkgHistoryDepth: 5,
        healthBaseUrl: 'http://localhost:3000',
        healthEndpoints: [],
        smokeGetEndpoints: [],
        smokeSuite: null,
        migrationDatasource: 'dist/database/data-source.js',
        expandContractEnforce,
        dependencyChangePolicy: 'block',
        notifyWebhook: null,
        stagedActivation: true,
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

    const releaseManagerMock = { checkDeploymentGate: jest.fn(async () => ({ allowed: true, backupRunId: 'backup-1' })) };
    const healthCheckMock = { check: jest.fn(async () => ({ ok: true, detail: {} })) };
    const restoreManagerMock = {};
    const preflightMock = { runPreflight: jest.fn(async () => ({ ok: true, checks: [] })) };
    const lkgMock = { isSeeded: jest.fn(async () => true), seed: jest.fn(async () => undefined), commit: jest.fn(async () => undefined) };
    auditCalls = [];
    const auditMock = {
      record: jest.fn(async (rec: { action: string; result: string; after?: Record<string, unknown> }) => {
        auditCalls.push({ action: rec.action, result: rec.result, after: rec.after });
      }),
    };
    const packageValidatorMock = {};

    const svc = new ReleaseExecutionService(
      dataSourceMock,
      configMock,
      packageValidatorMock as never,
      releaseManagerMock as never,
      healthCheckMock as never,
      restoreManagerMock as never,
      preflightMock as never,
      stagedActivationMock as never,
      lkgMock as never,
      auditMock as never,
      undefined,
    );

    // Sidestep real Postgres/filesystem for the two collaborators that are
    // not the subject of this test: the expand/contract scan itself
    // (READY-state override per test) and migration execution (never
    // reached in any scenario here, since every scenario aborts pre-swap).
    scanDeltaMigrationsSpy = jest.spyOn(svc as any, 'scanDeltaMigrations').mockResolvedValue([]);
    runReleaseMigrationsSpy = jest.spyOn(svc as any, 'runReleaseMigrations').mockResolvedValue(undefined);
    triggerPassengerRestartSpy = jest.spyOn(svc as any, 'triggerPassengerRestart').mockResolvedValue(undefined);

    return svc;
  }

  beforeEach(() => {
    releases = new Map();
    stagingRoot = mkdtempSync(join(tmpdir(), 'release-gates-spec-'));
    mkdirSync(join(stagingRoot, 'release-under-test'), { recursive: true });
    jest.clearAllMocks();
    (buildMigrationPreflight as jest.Mock).mockResolvedValue({
      current: null,
      target: null,
      required: [],
      pending: [],
      order: [],
      tagsInScope: ['core'],
      tagDriftIssues: [],
      manifestDriftIssues: [],
      dependencyIssues: [],
      compatibility: { ok: true, reason: 'n/a' },
      decision: 'READY_TO_ACTIVATE',
      blockedReasons: [],
    });
    (MigrationExecutor as unknown as jest.Mock).mockImplementation(() => ({
      getPendingMigrations: jest.fn(async () => []),
    }));
    (verifyArtifactIntegrity as jest.Mock).mockResolvedValue({ releaseId: 'release-under-test', ok: true, violations: [] });
  });

  afterEach(() => {
    rmSync(stagingRoot, { recursive: true, force: true });
  });

  it('expand_contract_violation (enforced, the schema default) => NO SWAP, NO RESTART, NO SUCCEEDED', async () => {
    service = buildService(/* expandContractEnforce */ true);
    scanDeltaMigrationsSpy.mockResolvedValue([{ file: 'core/9999999999999-Test.ts', rule: 'no-drop-column', statement: 'ALTER TABLE x DROP COLUMN y' }]);
    seedRelease();

    const result = await service.deployRelease('release-under-test', 'admin-1');

    expect(result.status).toBe('failed');
    expect(stagedActivationMock.activate).not.toHaveBeenCalled();
    expect(triggerPassengerRestartSpy).not.toHaveBeenCalled();
    const actions = auditCalls.map((c) => c.action);
    expect(actions).toContain('release.deploy.expand_contract_violation');
    expect(actions).not.toContain('release.deploy.swapped');
    expect(actions).not.toContain('release.deploy.succeeded');
    const violationRecord = auditCalls.find((c) => c.action === 'release.deploy.expand_contract_violation');
    expect(violationRecord?.result).toBe('denied');
  });

  it('migration_preflight BLOCKED => NO SWAP, NO RESTART, NO SUCCEEDED, and the expand/contract scan is never reached', async () => {
    service = buildService(/* expandContractEnforce */ true);
    (buildMigrationPreflight as jest.Mock).mockResolvedValue({
      current: 'SomeOlderMigration123',
      target: 'SomeNewerMigration456',
      required: ['SomeOlderMigration123', 'SomeNewerMigration456'],
      pending: ['SomeNewerMigration456'],
      order: ['SomeNewerMigration456'],
      tagsInScope: ['core'],
      tagDriftIssues: ['dist/database/migrations/core/9999999999999-Test.js: derived migration name was not found by the migration loader'],
      manifestDriftIssues: [],
      dependencyIssues: [],
      compatibility: { ok: true, reason: 'n/a' },
      decision: 'BLOCKED',
      blockedReasons: ['Tag/migration drift: dist/database/migrations/core/9999999999999-Test.js not found by the loader'],
    });
    seedRelease();

    const result = await service.deployRelease('release-under-test', 'admin-1');

    expect(result.status).toBe('failed');
    expect(stagedActivationMock.activate).not.toHaveBeenCalled();
    expect(triggerPassengerRestartSpy).not.toHaveBeenCalled();
    expect(scanDeltaMigrationsSpy).not.toHaveBeenCalled();
    expect(runReleaseMigrationsSpy).not.toHaveBeenCalled();
    const actions = auditCalls.map((c) => c.action);
    expect(actions).not.toContain('release.deploy.swapped');
    expect(actions).not.toContain('release.deploy.succeeded');
  });

  it('FIX VERIFICATION: expand_contract_violation aborts even with RELEASE_EXPAND_CONTRACT_ENFORCE=false — the escape hatch is gone', async () => {
    service = buildService(/* expandContractEnforce */ false);
    scanDeltaMigrationsSpy.mockResolvedValue([{ file: 'core/9999999999999-Test.ts', rule: 'no-drop-column', statement: 'ALTER TABLE x DROP COLUMN y' }]);
    seedRelease();

    const result = await service.deployRelease('release-under-test', 'admin-1');

    // Prior behavior (production incident 2026-09-22): this config value
    // let a DENIED violation fall through to swap/restart/succeeded. The
    // fix removes the config's ability to affect this decision at all —
    // this must now abort identically to the enforced case, proving there
    // is no longer any environment value that can bypass this gate.
    expect(result.status).toBe('failed');
    expect(stagedActivationMock.activate).not.toHaveBeenCalled();
    const actions = auditCalls.map((c) => c.action);
    expect(actions).toContain('release.deploy.expand_contract_violation');
    expect(actions).not.toContain('release.deploy.swapped');
    expect(actions).not.toContain('release.deploy.succeeded');
  });

  it('WORKSTREAM B: a release shipping a new migration must not swap unless that migration is actually recorded as executed afterward', async () => {
    service = buildService(/* expandContractEnforce */ true);
    // runReleaseMigrations "succeeds" (no throw) — exactly what production
    // observed for the four SeedAdminPermissionsFor* migrations: the call
    // completed without error while genuinely executing nothing for them.
    seedRelease({
      manifest: {
        version: '1.1.2-test',
        files: [{ path: 'dist/database/migrations/commission/1789751100000-SeedAdminPermissionsForCommission.js', action: 'modify', checksum: 'x' }],
        migrations: [],
      },
    });
    // The independent post-migration check re-derives pending state fresh
    // and finds this exact migration STILL pending, despite runMigrations()
    // having reported success.
    (MigrationExecutor as unknown as jest.Mock).mockImplementation(() => ({
      getPendingMigrations: jest.fn(async () => [{ name: 'SeedAdminPermissionsForCommission1789751100000' }]),
    }));

    const result = await service.deployRelease('release-under-test', 'admin-1');

    expect(result.status).toBe('failed');
    expect(stagedActivationMock.activate).not.toHaveBeenCalled();
    expect(triggerPassengerRestartSpy).not.toHaveBeenCalled();
    const actions = auditCalls.map((c) => c.action);
    expect(actions).toContain('release.deploy.migration_verification_failed');
    expect(actions).not.toContain('release.deploy.swapped');
    expect(actions).not.toContain('release.deploy.succeeded');
    const verificationRecord = auditCalls.find((c) => c.action === 'release.deploy.migration_verification_failed');
    expect(verificationRecord?.after?.stillPending).toEqual(['SeedAdminPermissionsForCommission1789751100000']);
  });

  it('WORKSTREAM B (control): a release shipping a new migration DOES swap once that migration is actually recorded as executed', async () => {
    service = buildService(/* expandContractEnforce */ true);
    seedRelease({
      manifest: {
        version: '1.1.2-test',
        files: [{ path: 'dist/database/migrations/commission/1789751100000-SeedAdminPermissionsForCommission.js', action: 'modify', checksum: 'x' }],
        migrations: [],
      },
    });
    // Default beforeEach mock already returns [] pending — the migration
    // genuinely completed, so the swap must proceed normally.

    const result = await service.deployRelease('release-under-test', 'admin-1');

    expect(result.status).toBe('succeeded');
    expect(stagedActivationMock.activate).toHaveBeenCalledTimes(1);
    const actions = auditCalls.map((c) => c.action);
    expect(actions).not.toContain('release.deploy.migration_verification_failed');
    expect(actions).toContain('release.deploy.swapped');
    expect(actions).toContain('release.deploy.succeeded');
  });

  it('ARTIFACT INTEGRITY GATE: a violation (candidate bytes disagree with the manifest) => NO SWAP, NO RESTART, NO SUCCEEDED, and migration preflight/scan/execution are never reached', async () => {
    service = buildService(/* expandContractEnforce */ true);
    seedRelease();
    (verifyArtifactIntegrity as jest.Mock).mockResolvedValue({
      releaseId: 'release-under-test',
      ok: false,
      violations: [
        {
          kind: 'file_checksum_mismatch',
          path: 'dist/database/migrations/targets/1789750000000-CreateTargetsCore.js',
          expected: 'expected-checksum-abc',
          actual: 'actual-checksum-xyz',
        },
      ],
    });

    const result = await service.deployRelease('release-under-test', 'admin-1');

    expect(result.status).toBe('failed');
    expect(stagedActivationMock.activate).not.toHaveBeenCalled();
    expect(triggerPassengerRestartSpy).not.toHaveBeenCalled();
    // Gate fires BEFORE migration preflight, the expand/contract scan, and
    // migration execution — none of them ever run, so no NEW
    // release_migration_runs row could possibly be written: existing
    // migration history (from any prior attempt) is provably untouched.
    expect(buildMigrationPreflight).not.toHaveBeenCalled();
    expect(scanDeltaMigrationsSpy).not.toHaveBeenCalled();
    expect(runReleaseMigrationsSpy).not.toHaveBeenCalled();
    const actions = auditCalls.map((c) => c.action);
    expect(actions).toContain('release.deploy.artifact_integrity');
    expect(actions).not.toContain('release.deploy.swapped');
    expect(actions).not.toContain('release.deploy.succeeded');
    const integrityRecord = auditCalls.find((c) => c.action === 'release.deploy.artifact_integrity');
    expect(integrityRecord?.result).toBe('denied');
    expect(integrityRecord?.after?.violations).toEqual([
      {
        kind: 'file_checksum_mismatch',
        path: 'dist/database/migrations/targets/1789750000000-CreateTargetsCore.js',
        expected: 'expected-checksum-abc',
        actual: 'actual-checksum-xyz',
      },
    ]);
    // The release's own errorMessage names the exact release id, the
    // expected/actual checksums, and the affected file — never surfaces
    // as an opaque downstream error.
    expect(result.errorMessage).toContain('release-under-test');
    expect(result.errorMessage).toContain('expected-checksum-abc');
    expect(result.errorMessage).toContain('actual-checksum-xyz');
    expect(result.errorMessage).toContain('dist/database/migrations/targets/1789750000000-CreateTargetsCore.js');
  });

  it('ARTIFACT INTEGRITY GATE (control): a clean artifact passes the gate and deploy proceeds normally to swap', async () => {
    service = buildService(/* expandContractEnforce */ true);
    seedRelease();
    // Default beforeEach mock already returns { ok: true, violations: [] }.

    const result = await service.deployRelease('release-under-test', 'admin-1');

    expect(result.status).toBe('succeeded');
    expect(stagedActivationMock.activate).toHaveBeenCalledTimes(1);
    const actions = auditCalls.map((c) => c.action);
    expect(actions).toContain('release.deploy.artifact_integrity');
    const integrityRecord = auditCalls.find((c) => c.action === 'release.deploy.artifact_integrity');
    expect(integrityRecord?.result).toBe('success');
    expect(actions).toContain('release.deploy.swapped');
    expect(actions).toContain('release.deploy.succeeded');
    // Proves gate ORDERING: the integrity check ran before preflight/scan/migrate.
    const integrityIdx = actions.indexOf('release.deploy.artifact_integrity');
    const preflightIdx = actions.indexOf('release.deploy.migration_preflight');
    expect(integrityIdx).toBeGreaterThanOrEqual(0);
    expect(preflightIdx).toBeGreaterThan(integrityIdx);
  });
});
