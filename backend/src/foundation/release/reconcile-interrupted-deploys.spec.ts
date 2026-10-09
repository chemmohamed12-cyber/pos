import { ReleaseExecutionService } from './release-execution.service';
import { Release } from './release.entity';
import { ReleaseManifest } from './release-manifest';
import { readAppVersion } from './app-version';

jest.mock('./app-version', () => ({ readAppVersion: jest.fn() }));
const readAppVersionMock = readAppVersion as jest.Mock;

/**
 * Production Incident 2026-09-22 — `deployReleaseStaged()`'s post-swap
 * sequence triggers a Passenger restart BEFORE running the health check
 * and final LKG commit / status write that same in-flight function is
 * still meant to perform. If Passenger recycles the worker at that exact
 * point, the deploy is functionally complete (swap done, new code is what's
 * running) but the release row is permanently stuck at `health_checking` —
 * confirmed live in production (SHA-verified corrected artifact deployed,
 * app confirmed serving v1.1.2, yet the release row never reached
 * `succeeded`). `reconcileInterruptedDeploys()` runs once at boot and
 * self-heals exactly this class of stuck row, conservatively.
 */
describe('ReleaseExecutionService.reconcileInterruptedDeploys', () => {
  let releases: Map<string, Release>;
  let auditCalls: Array<{ action: string; result: string; actorUserId?: string | null; after?: Record<string, unknown> }>;
  let stagedActivationMock: { pruneSlots: jest.Mock };
  let lkgMock: { read: jest.Mock; isSeeded: jest.Mock; seed: jest.Mock; commit: jest.Mock };
  let healthCheckMock: { check: jest.Mock };
  let service: ReleaseExecutionService;

  function validManifest(overrides: Partial<ReleaseManifest> = {}): ReleaseManifest {
    return { version: '1.1.2', packageType: 'full', files: [], migrations: [], ...overrides };
  }

  function seedRelease(id: string, overrides: Partial<Release> = {}): Release {
    const release: Release = {
      id,
      version: '1.1.2',
      packageType: 'full',
      baseVersion: null,
      manifest: validManifest(),
      manifestChecksum: 'x',
      status: 'health_checking',
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

  function buildService(): ReleaseExecutionService {
    // Deliberately doesn't inspect TypeORM's In() FindOperator internals —
    // reconcileInterruptedDeploys() only ever queries for these three
    // interrupted-deploy statuses, so a fixed set here is exactly as
    // faithful as parsing the operator, without depending on its private
    // shape.
    const STUCK_STATUSES = new Set(['health_checking', 'migrating', 'deploying']);
    const releaseRepoMock = {
      find: jest.fn(async () => [...releases.values()].filter((r) => STUCK_STATUSES.has(r.status))),
      save: jest.fn(async (r: Release) => {
        releases.set(r.id, r);
        return r;
      }),
    };
    const dataSourceMock = {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === Release) return releaseRepoMock;
        return { find: jest.fn(async () => []), save: jest.fn(async (x: unknown) => x) };
      }),
    } as never;

    const configMock = {
      releaseExecution: { appRoot: 'C:/fake-app-root', stagingPath: 'C:/fake-staging', frontendRuntimePath: 'C:/fake-frontend', passengerRestartFile: 'C:/fake-restart.txt' },
      releaseDeploy: { deployRoot: 'C:/fake-deploy-root', activeDirname: 'backend', manifestsPath: 'C:/fake-manifests', slotRetention: 3, lkgHistoryDepth: 5, stagedActivation: true },
      releaseBuild: { nodeBin: 'node', npmBin: 'npm', maxThreads: 1 },
      database: { host: 'localhost', port: 5432, username: 'x', password: 'x', database: 'x' },
      entitlement: { mode: 'unlicensed-full', publicKeys: [], clockToleranceMinutes: 10 },
    } as never;

    stagedActivationMock = { pruneSlots: jest.fn(async () => undefined) };
    lkgMock = {
      read: jest.fn(async () => null), // not seeded by default — forces a commit attempt
      isSeeded: jest.fn(async () => true),
      seed: jest.fn(async () => undefined),
      commit: jest.fn(async () => undefined),
    };
    healthCheckMock = { check: jest.fn(async () => ({ ok: true, detail: {} })) };
    const releaseManagerMock = {};
    const restoreManagerMock = {};
    const preflightMock = {};
    auditCalls = [];
    const auditMock = {
      record: jest.fn(async (rec: { action: string; result: string; actorUserId?: string | null; after?: Record<string, unknown> }) => {
        auditCalls.push({ action: rec.action, result: rec.result, actorUserId: rec.actorUserId, after: rec.after });
      }),
    };
    const packageValidatorMock = {};

    return new ReleaseExecutionService(
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
  }

  beforeEach(() => {
    releases = new Map();
    jest.clearAllMocks();
    readAppVersionMock.mockReturnValue('1.1.2');
    service = buildService();
  });

  it('reconciles a release stuck at health_checking whose version matches this process and reports healthy right now', async () => {
    seedRelease('release-a', { status: 'health_checking', version: '1.1.2' });

    await service.reconcileInterruptedDeploys('system');

    const updated = releases.get('release-a')!;
    expect(updated.status).toBe('succeeded');
    expect(updated.completedAt).not.toBeNull();
    expect(lkgMock.commit).toHaveBeenCalledTimes(1);
    expect(stagedActivationMock.pruneSlots).toHaveBeenCalledWith(['release-a']);
    const rec = auditCalls.find((c) => c.action === 'release.deploy.reconciled');
    expect(rec?.result).toBe('success');
    expect(rec?.after?.previousStatus).toBe('health_checking');
  });

  it('called at boot with no actor, the audit record carries a NULL actor — never the string "system" (audit_records.actorUserId is a uuid; production logged `invalid input syntax for type uuid: "system"`)', async () => {
    seedRelease('release-a', { status: 'health_checking', version: '1.1.2' });

    await service.reconcileInterruptedDeploys();

    const rec = auditCalls.find((c) => c.action === 'release.deploy.reconciled');
    expect(rec).toBeDefined();
    expect(rec?.actorUserId).toBeNull();
  });

  it('also reconciles "migrating" and "deploying" statuses — the same interruption can land mid-migration or mid-deploy, not only mid-health-check', async () => {
    seedRelease('release-migrating', { status: 'migrating', version: '1.1.2' });
    seedRelease('release-deploying', { status: 'deploying', version: '1.1.2' });

    await service.reconcileInterruptedDeploys('system');

    expect(releases.get('release-migrating')!.status).toBe('succeeded');
    expect(releases.get('release-deploying')!.status).toBe('succeeded');
  });

  it('does NOT touch a stuck release whose version does not match this running process', async () => {
    seedRelease('release-other-version', { status: 'health_checking', version: '1.1.1' });

    await service.reconcileInterruptedDeploys('system');

    const untouched = releases.get('release-other-version')!;
    expect(untouched.status).toBe('health_checking'); // unchanged
    expect(lkgMock.commit).not.toHaveBeenCalled();
    expect(stagedActivationMock.pruneSlots).not.toHaveBeenCalled();
    expect(auditCalls.find((c) => c.action === 'release.deploy.reconciled')).toBeUndefined();
  });

  it('does NOT touch a stuck release whose version matches but the health check fails right now — never guesses', async () => {
    seedRelease('release-unhealthy', { status: 'health_checking', version: '1.1.2' });
    healthCheckMock.check.mockResolvedValue({ ok: false, detail: { db: 'unreachable' } });

    await service.reconcileInterruptedDeploys('system');

    const untouched = releases.get('release-unhealthy')!;
    expect(untouched.status).toBe('health_checking');
    expect(lkgMock.commit).not.toHaveBeenCalled();
    expect(auditCalls.find((c) => c.action === 'release.deploy.reconciled')).toBeUndefined();
  });

  it('does NOT double-commit the LKG if it already names this release (a partial interruption AFTER the commit step) — only the status/completedAt gap is closed', async () => {
    seedRelease('release-already-committed', { status: 'health_checking', version: '1.1.2' });
    lkgMock.read.mockResolvedValue({ current: { release_id: 'release-already-committed', version: '1.1.2' }, history: [] });

    await service.reconcileInterruptedDeploys('system');

    expect(releases.get('release-already-committed')!.status).toBe('succeeded');
    expect(lkgMock.commit).not.toHaveBeenCalled();
    expect(stagedActivationMock.pruneSlots).not.toHaveBeenCalled();
  });

  it('a no-op when nothing is stuck', async () => {
    seedRelease('release-fine', { status: 'succeeded', version: '1.1.2' });

    await service.reconcileInterruptedDeploys('system');

    expect(releases.get('release-fine')!.status).toBe('succeeded');
    expect(healthCheckMock.check).not.toHaveBeenCalled();
    expect(auditCalls).toEqual([]);
  });

  it('one release failing to reconcile (an unexpected error) does not prevent another from being reconciled', async () => {
    seedRelease('release-b1', { status: 'health_checking', version: '1.1.2' });
    seedRelease('release-b2', { status: 'health_checking', version: '1.1.2' });
    let calls = 0;
    healthCheckMock.check.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error('transient failure');
      return { ok: true, detail: {} };
    });

    await expect(service.reconcileInterruptedDeploys('system')).resolves.toBeUndefined();

    const statuses = [...releases.values()].map((r) => r.status).sort();
    expect(statuses).toEqual(['health_checking', 'succeeded']); // one left alone, one reconciled
  });
});
