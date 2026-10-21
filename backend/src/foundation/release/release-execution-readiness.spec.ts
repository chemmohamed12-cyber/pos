import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { currentCompanyFanoutMock } from './company-gate-test-fixtures';
import { tmpdir } from 'os';
import { join } from 'path';
import { MigrationExecutor } from 'typeorm';
import { ReleaseExecutionService } from './release-execution.service';
import { Release } from './release.entity';
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
 * Post-incident review of release 1.1.4 (2026-10-09): the engine used to call a deploy `succeeded` after DATABASE-only checks, so a restarted application that
 * failed to boot (HTTP 503 under Passenger) was never noticed, and an uninitialised platform (no installation row) was never noticed either. These specs pin the
 * three layers — files / application startup / functional readiness — and the classified outcome of each way of failing, with the automatic rollback taking over.
 */
describe('ReleaseExecutionService — post-swap application readiness (startup + functional) and classified outcomes', () => {
  let releases: Map<string, Release>;
  let stagingRoot: string;
  let auditCalls: Array<{ action: string; result: string; after?: Record<string, unknown> }>;
  let rollbackSpy: jest.SpyInstance;
  let fetchSpy: jest.SpyInstance;
  let installationRows: unknown[][]; // successive answers of `SELECT 1 FROM "installation"`: [before, after]

  function seedRelease(): Release {
    const release = {
      id: 'release-under-test',
      version: '1.1.5-test',
      packageType: 'full',
      baseVersion: null,
      manifest: { version: '1.1.5-test', files: [{ path: 'dist/database/migrations/core/9999999999999-Test.js', action: 'modify', checksum: 'x' }], migrations: [] },
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

  function buildService(opts: { readinessUrl?: string | null; mode?: 'unlicensed-full' | 'enforced'; timeoutSeconds?: number } = {}): ReleaseExecutionService {
    const { readinessUrl = null, mode = 'unlicensed-full', timeoutSeconds = 1 } = opts;
    const releaseRepoMock = {
      findOne: jest.fn(async ({ where }: { where: { id: string } }) => releases.get(where.id) ?? null),
      save: jest.fn(async (r: Release) => {
        releases.set(r.id, r);
        return r;
      }),
    };
    const dataSourceMock = {
      getRepository: jest.fn((entity: unknown) => (entity === Release ? releaseRepoMock : { find: jest.fn(async () => []), save: jest.fn(async (x: unknown) => x) })),
      query: jest.fn(async (sql: string) => {
        if (/FROM "installation"/.test(sql)) return installationRows.length > 1 ? installationRows.shift()! : installationRows[0];
        return [];
      }),
    } as never;
    const configMock = {
      releaseExecution: { appRoot: 'C:/fake-app-root', stagingPath: stagingRoot, frontendRuntimePath: 'C:/fake-frontend', passengerRestartFile: 'C:/fake-restart.txt' },
      releaseDeploy: {
        deployRoot: 'C:/fake-deploy-root', activeDirname: 'backend', manifestsPath: 'C:/fake-manifests', slotRetention: 3, lkgHistoryDepth: 5, healthBaseUrl: 'http://localhost:3000',
        healthEndpoints: ['/api/health', '/api/health/deep'], smokeGetEndpoints: [], smokeSuite: null, migrationDatasource: 'dist/database/data-source.js', expandContractEnforce: true,
        dependencyChangePolicy: 'block', notifyWebhook: null, stagedActivation: true, readinessUrl, readinessTimeoutSeconds: timeoutSeconds,
      },
      releaseBuild: { nodeBin: 'node', npmBin: 'npm', maxThreads: 1 },
      database: { host: 'localhost', port: 5432, username: 'x', password: 'x', database: 'x' },
      entitlement: { mode, publicKeys: [], clockToleranceMinutes: 10 },
    } as never;
    const stagedActivationMock = {
      buildCandidate: jest.fn(async () => 'C:/fake-candidate'),
      verifyCandidate: jest.fn(async () => ({ ok: true, checks: [] })),
      activate: jest.fn(async () => ({ previousPath: 'C:/fake-previous', activePath: 'C:/fake-app-root' })),
      pruneSlots: jest.fn(async () => undefined),
      rollbackSwap: jest.fn(async () => undefined),
    };
    auditCalls = [];
    const auditMock = { record: jest.fn(async (rec: { action: string; result: string; after?: Record<string, unknown> }) => void auditCalls.push({ action: rec.action, result: rec.result, after: rec.after })) };
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
      currentCompanyFanoutMock() as never,
    );
    const priv = svc as unknown as {
      scanDeltaMigrations: () => Promise<unknown[]>;
      runReleaseMigrations: () => Promise<void>;
      triggerPassengerRestart: () => Promise<void>;
      rollbackAfterSwap: (...a: unknown[]) => Promise<Release>;
    };
    jest.spyOn(priv, 'scanDeltaMigrations').mockResolvedValue([]);
    jest.spyOn(priv, 'runReleaseMigrations').mockResolvedValue(undefined);
    jest.spyOn(priv, 'triggerPassengerRestart').mockResolvedValue(undefined);
    rollbackSpy = jest.spyOn(priv, 'rollbackAfterSwap').mockImplementation(async (release: unknown) => {
      const r = release as Release;
      r.status = 'rolled_back';
      return r;
    });
    return svc;
  }

  const actions = () => auditCalls.map((c) => c.action);
  const evidence = () => auditCalls.find((c) => c.action === 'release.deploy.evidence')?.after as { outcome: string; layers: Record<string, unknown> } | undefined;
  const failedOutcome = () => auditCalls.find((c) => c.action === 'release.deploy.failed')?.after?.outcome;
  const respond = (status: number) => ({ ok: status >= 200 && status < 300, status } as Response);

  beforeEach(() => {
    releases = new Map();
    stagingRoot = mkdtempSync(join(tmpdir(), 'release-readiness-spec-'));
    mkdirSync(join(stagingRoot, 'release-under-test'), { recursive: true });
    jest.clearAllMocks();
    installationRows = [[{ '?column?': 1 }]]; // present before and after
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(respond(200));
    (buildMigrationPreflight as jest.Mock).mockResolvedValue({
      current: null, target: null, required: [], pending: [], order: [], tagsInScope: ['core'], tagDriftIssues: [], manifestDriftIssues: [], dependencyIssues: [],
      compatibility: { ok: true, reason: 'n/a' }, decision: 'READY_TO_ACTIVATE', blockedReasons: [],
    });
    (MigrationExecutor as unknown as jest.Mock).mockImplementation(() => ({ getPendingMigrations: jest.fn(async () => []) }));
    (verifyArtifactIntegrity as jest.Mock).mockResolvedValue({ releaseId: 'release-under-test', ok: true, violations: [] });
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    rmSync(stagingRoot, { recursive: true, force: true });
  });

  it('URL configured and the restarted application answers 2xx on every health endpoint => DEPLOYMENT_VERIFIED, with the three layers in the evidence', async () => {
    const svc = buildService({ readinessUrl: 'https://daii.example.test/' });
    seedRelease();
    const result = await svc.deployRelease('release-under-test', 'admin-1');
    expect(result.status).toBe('succeeded');
    expect(fetchSpy.mock.calls.map((c) => c[0])).toEqual(['https://daii.example.test/api/health', 'https://daii.example.test/api/health/deep']); // trailing slash handled, each endpoint probed
    expect(evidence()?.outcome).toBe('DEPLOYMENT_VERIFIED');
    expect(evidence()?.layers.applicationStartup).toMatchObject({ status: 'verified' });
    expect(evidence()?.layers.functionalReadiness).toMatchObject({ status: 'ok' });
    expect(rollbackSpy).not.toHaveBeenCalled();
  });

  it('URL configured and the application does NOT answer (HTTP 503 — the incident) => APPLICATION_STARTUP_FAILED, automatic rollback, never `succeeded`', async () => {
    const svc = buildService({ readinessUrl: 'https://daii.example.test', timeoutSeconds: 1 });
    fetchSpy.mockResolvedValue(respond(503));
    seedRelease();
    const result = await svc.deployRelease('release-under-test', 'admin-1');
    expect(result.status).toBe('rolled_back');
    expect(rollbackSpy).toHaveBeenCalledTimes(1);
    expect(failedOutcome()).toBe('APPLICATION_STARTUP_FAILED');
    expect(auditCalls.find((c) => c.action === 'release.deploy.failed')?.after?.error).toContain('HTTP 503');
    expect(actions()).not.toContain('release.deploy.succeeded');
    expect(actions()).not.toContain('release.deploy.evidence');
  });

  it('the application is unreachable (connection refused) => the same classified failure and rollback', async () => {
    const svc = buildService({ readinessUrl: 'https://daii.example.test', timeoutSeconds: 1 });
    fetchSpy.mockRejectedValue(new Error('connect ECONNREFUSED'));
    seedRelease();
    const result = await svc.deployRelease('release-under-test', 'admin-1');
    expect(result.status).toBe('rolled_back');
    expect(failedOutcome()).toBe('APPLICATION_STARTUP_FAILED');
    expect(auditCalls.find((c) => c.action === 'release.deploy.failed')?.after?.error).toContain('ECONNREFUSED');
  });

  it('a slow boot is tolerated: 503 first, then 200 within the timeout => verified (Passenger starts the process on the first request)', async () => {
    const svc = buildService({ readinessUrl: 'https://daii.example.test', timeoutSeconds: 30 });
    fetchSpy.mockResolvedValueOnce(respond(503)).mockResolvedValue(respond(200));
    seedRelease();
    const result = await svc.deployRelease('release-under-test', 'admin-1');
    expect(result.status).toBe('succeeded');
    expect(evidence()?.outcome).toBe('DEPLOYMENT_VERIFIED');
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('application answers but the platform is NOT initialised (no installation row, unlicensed-full) => INITIALIZATION_FAILED and rollback', async () => {
    const svc = buildService({ readinessUrl: 'https://daii.example.test', mode: 'unlicensed-full' });
    installationRows = [[], []]; // missing before and after
    seedRelease();
    const result = await svc.deployRelease('release-under-test', 'admin-1');
    expect(result.status).toBe('rolled_back');
    expect(failedOutcome()).toBe('INITIALIZATION_FAILED');
    expect(auditCalls.find((c) => c.action === 'release.deploy.failed')?.after?.error).toContain('Companies cannot be created');
  });

  it('enforced mode with no licence applied BEFORE the deploy is a licensing state, not a deploy defect: verified, with a warning in the evidence (no rollback)', async () => {
    const svc = buildService({ readinessUrl: 'https://daii.example.test', mode: 'enforced' });
    installationRows = [[], []];
    seedRelease();
    const result = await svc.deployRelease('release-under-test', 'admin-1');
    expect(result.status).toBe('succeeded');
    expect(evidence()?.layers.functionalReadiness).toMatchObject({ status: 'warning' });
    expect(rollbackSpy).not.toHaveBeenCalled();
  });

  it('enforced mode where the installation row EXISTED before and is gone after the deploy => INITIALIZATION_FAILED and rollback', async () => {
    const svc = buildService({ readinessUrl: 'https://daii.example.test', mode: 'enforced' });
    installationRows = [[{ '?column?': 1 }], []];
    seedRelease();
    const result = await svc.deployRelease('release-under-test', 'admin-1');
    expect(result.status).toBe('rolled_back');
    expect(failedOutcome()).toBe('INITIALIZATION_FAILED');
  });

  it('URL NOT configured => the engine cannot know the application started: the deploy is DEPLOYED_UNVERIFIED (never reported as verified), no HTTP probe, no functional check', async () => {
    const svc = buildService({ readinessUrl: null });
    seedRelease();
    const result = await svc.deployRelease('release-under-test', 'admin-1');
    expect(result.status).toBe('succeeded');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(evidence()?.outcome).toBe('DEPLOYED_UNVERIFIED');
    expect(evidence()?.layers.applicationStartup).toMatchObject({ status: 'UNVERIFIED', reason: 'RELEASE_READINESS_URL not configured' });
    expect(evidence()?.layers.functionalReadiness).toMatchObject({ status: 'skipped' });
  });

  it('a pre-swap failure is classified DEPLOYMENT_FAILED (not a startup failure)', async () => {
    const svc = buildService({ readinessUrl: 'https://daii.example.test' });
    (verifyArtifactIntegrity as jest.Mock).mockResolvedValue({ releaseId: 'release-under-test', ok: false, violations: [{ kind: 'file_checksum_mismatch', path: 'x', expected: 'a', actual: 'b' }] });
    seedRelease();
    const result = await svc.deployRelease('release-under-test', 'admin-1');
    expect(result.status).toBe('failed');
    expect(failedOutcome()).toBe('DEPLOYMENT_FAILED');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
