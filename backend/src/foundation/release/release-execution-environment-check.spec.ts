import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
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
 * Post-incident review of release 1.1.4 (HTTP 503 right after the swap). A release validates its OWN configuration schema at boot and exits when the host's
 * environment is missing something it requires; v1.1.4 newly required DATABASE_CREDENTIAL_ENCRYPTION_KEY in production. The engine now validates the CANDIDATE's schema
 * against the host environment BEFORE the swap and refuses with the exact variable names (ACTIVE untouched, no migration run) instead of a 503 after the swap.
 */
describe('ReleaseExecutionService — pre-swap environment check of the candidate', () => {
  const realSchemaRoot = process.cwd(); // backend/ — dist/foundation/configuration/configuration.schema.js is the REAL 1.1.x schema
  let tmp: string;
  let savedEnv: NodeJS.ProcessEnv;
  let releases: Map<string, Release>;
  let auditCalls: Array<{ action: string; result: string; after?: Record<string, unknown> }>;
  let activate: jest.Mock;
  let runMigrations: jest.SpyInstance;

  const strong = 'x'.repeat(40);
  /** everything v1.1.2 required in production — i.e. a host configured for the PREVIOUS release */
  const host112 = { NODE_ENV: 'production', DB_HOST: 'h', DB_USER: 'u', DB_NAME: 'n', DB_PASSWORD: 'prod-password-not-the-default-1234', JWT_ACCESS_SECRET: strong, JWT_REFRESH_SECRET: strong, INTEGRATION_ENCRYPTION_KEY: strong };
  const setEnv = (vars: Record<string, string>) => {
    process.env = { ...savedEnv };
    for (const k of ['NODE_ENV', 'DB_HOST', 'DB_USER', 'DB_NAME', 'DB_PASSWORD', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'INTEGRATION_ENCRYPTION_KEY', 'DATABASE_CREDENTIAL_ENCRYPTION_KEY']) delete process.env[k];
    Object.assign(process.env, vars);
  };

  function build(candidatePath: string): ReleaseExecutionService {
    const releaseRepo = {
      findOne: jest.fn(async ({ where }: { where: { id: string } }) => releases.get(where.id) ?? null),
      save: jest.fn(async (r: Release) => (releases.set(r.id, r), r)),
    };
    const dataSource = { getRepository: jest.fn((e: unknown) => (e === Release ? releaseRepo : { find: jest.fn(async () => []), save: jest.fn(async (x: unknown) => x) })), query: jest.fn(async () => []) } as never;
    const config = {
      releaseExecution: { appRoot: 'C:/fake-app-root', stagingPath: tmp, frontendRuntimePath: 'C:/fake-frontend', passengerRestartFile: 'C:/fake-restart.txt' },
      releaseDeploy: {
        deployRoot: 'C:/fake', activeDirname: 'backend', manifestsPath: 'C:/fake-manifests', slotRetention: 3, lkgHistoryDepth: 5, healthBaseUrl: 'http://localhost:3000',
        healthEndpoints: [], smokeGetEndpoints: [], smokeSuite: null, migrationDatasource: 'x', expandContractEnforce: true, dependencyChangePolicy: 'block', notifyWebhook: null,
        stagedActivation: true, readinessUrl: null, readinessTimeoutSeconds: 1,
      },
      releaseBuild: { nodeBin: process.execPath, npmBin: 'npm', maxThreads: 1 },
      database: { host: 'localhost', port: 5432, username: 'x', password: 'x', database: 'x' },
      entitlement: { mode: 'unlicensed-full', publicKeys: [], clockToleranceMinutes: 10 },
    } as never;
    activate = jest.fn(async () => ({ previousPath: 'C:/prev', activePath: 'C:/fake-app-root' }));
    auditCalls = [];
    const audit = { record: jest.fn(async (r: { action: string; result: string; after?: Record<string, unknown> }) => void auditCalls.push({ action: r.action, result: r.result, after: r.after })) };
    const svc = new ReleaseExecutionService(
      dataSource, config, {} as never, { checkDeploymentGate: jest.fn(async () => ({ allowed: true, backupRunId: 'b' })) } as never, { check: jest.fn(async () => ({ ok: true, detail: {} })) } as never,
      {} as never, { runPreflight: jest.fn(async () => ({ ok: true, checks: [] })) } as never,
      { buildCandidate: jest.fn(async () => candidatePath), verifyCandidate: jest.fn(async () => ({ ok: true, checks: [] })), activate, pruneSlots: jest.fn(), rollbackSwap: jest.fn() } as never,
      { isSeeded: jest.fn(async () => true), seed: jest.fn(), commit: jest.fn() } as never, audit as never,
    );
    const priv = svc as unknown as { scanDeltaMigrations: () => Promise<unknown[]>; runReleaseMigrations: () => Promise<void>; triggerPassengerRestart: () => Promise<void> };
    jest.spyOn(priv, 'scanDeltaMigrations').mockResolvedValue([]);
    runMigrations = jest.spyOn(priv, 'runReleaseMigrations').mockResolvedValue(undefined);
    jest.spyOn(priv, 'triggerPassengerRestart').mockResolvedValue(undefined);
    return svc;
  }
  const check = (svc: ReleaseExecutionService, path: string) => (svc as unknown as { verifyCandidateEnvironment: (p: string) => Promise<{ status: string; errors: string[] }> }).verifyCandidateEnvironment(path);
  function seedRelease(): void {
    releases.set('r1', { id: 'r1', version: '1.1.5-test', packageType: 'full', baseVersion: null, manifest: { version: '1.1.5-test', files: [], migrations: [] }, manifestChecksum: 'x', status: 'backup_verified', uploadedByUserId: 'a', uploadedAt: new Date(), backupRunId: 'b', completedAt: null, errorMessage: null } as unknown as Release);
  }

  beforeEach(() => {
    savedEnv = process.env;
    tmp = mkdtempSync(join(tmpdir(), 'env-check-spec-'));
    mkdirSync(join(tmp, 'r1'), { recursive: true });
    releases = new Map();
    jest.clearAllMocks();
    (buildMigrationPreflight as jest.Mock).mockResolvedValue({ current: null, target: null, required: [], pending: [], order: [], tagsInScope: [], tagDriftIssues: [], manifestDriftIssues: [], dependencyIssues: [], compatibility: { ok: true, reason: 'n/a' }, decision: 'READY_TO_ACTIVATE', blockedReasons: [] });
    (MigrationExecutor as unknown as jest.Mock).mockImplementation(() => ({ getPendingMigrations: jest.fn(async () => []) }));
    (verifyArtifactIntegrity as jest.Mock).mockResolvedValue({ releaseId: 'r1', ok: true, violations: [] });
  });
  afterEach(() => {
    process.env = savedEnv;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('THE INCIDENT, with the real 1.1.x schema: a host configured for v1.1.2 lacks exactly DATABASE_CREDENTIAL_ENCRYPTION_KEY => invalid, naming it', async () => {
    setEnv(host112);
    const r = await check(build(realSchemaRoot), realSchemaRoot);
    expect(r.status).toBe('invalid');
    expect(r.errors).toEqual(['"DATABASE_CREDENTIAL_ENCRYPTION_KEY" is required']);
  });

  it('the same host once the variable is set => valid', async () => {
    setEnv({ ...host112, DATABASE_CREDENTIAL_ENCRYPTION_KEY: strong });
    expect((await check(build(realSchemaRoot), realSchemaRoot)).status).toBe('valid');
  });

  it('a key that is present but too short is refused too (the schema itself is the judge, not a hand-kept list)', async () => {
    setEnv({ ...host112, DATABASE_CREDENTIAL_ENCRYPTION_KEY: 'short' });
    const r = await check(build(realSchemaRoot), realSchemaRoot);
    expect(r.status).toBe('invalid');
    expect(r.errors.join(' ')).toContain('DATABASE_CREDENTIAL_ENCRYPTION_KEY');
  });

  it('development defaults still start: no production-only requirements are imposed outside production', async () => {
    setEnv({ NODE_ENV: 'development', DB_HOST: 'h', DB_USER: 'u', DB_NAME: 'n', DB_PASSWORD: 'dev' });
    expect((await check(build(realSchemaRoot), realSchemaRoot)).status).toBe('valid');
  });

  it('a candidate without a schema file is `skipped` (reported, never silently passed)', async () => {
    const r = await check(build(tmp), tmp);
    expect(r.status).toBe('skipped');
  });

  it('a candidate whose schema cannot even be evaluated fails closed (not passed)', async () => {
    const broken = join(tmp, 'broken');
    mkdirSync(join(broken, 'dist', 'foundation', 'configuration'), { recursive: true });
    writeFileSync(join(broken, 'dist', 'foundation', 'configuration', 'configuration.schema.js'), 'throw new Error("boom at require");');
    const r = await check(build(broken), broken);
    expect(r.status).toBe('invalid');
    expect(r.errors[0]).toContain('could not be evaluated');
    expect((r as { evaluationFailed?: boolean }).evaluationFailed).toBe(true); // a failure of the CHECK, reported as such (not as a bad host environment)
  });

  it('a genuine missing variable is NOT flagged as an evaluation failure', async () => {
    setEnv(host112);
    const r = await check(build(realSchemaRoot), realSchemaRoot);
    expect(r.status).toBe('invalid');
    expect((r as { evaluationFailed?: boolean }).evaluationFailed).toBeUndefined();
  });

  it('IN THE DEPLOY: an invalid candidate environment aborts PRE-SWAP — no migration, no swap, ACTIVE untouched — with the variable named; classified DEPLOYMENT_FAILED', async () => {
    const cand = join(tmp, 'cand');
    mkdirSync(join(cand, 'dist', 'foundation', 'configuration'), { recursive: true });
    writeFileSync(join(cand, 'dist', 'foundation', 'configuration', 'configuration.schema.js'), `exports.configurationValidationSchema = { validate: (env) => ({ error: env.NEEDED_BY_NEW_RELEASE ? undefined : { details: [{ message: '"NEEDED_BY_NEW_RELEASE" is required' }] } }) };`);
    setEnv({});
    const svc = build(cand);
    seedRelease();
    const result = await svc.deployRelease('r1', 'admin');
    expect(result.status).toBe('failed');
    expect(result.errorMessage).toContain('ENVIRONMENT_INVALID');
    expect(result.errorMessage).toContain('NEEDED_BY_NEW_RELEASE');
    expect(runMigrations).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
    const rec = auditCalls.find((c) => c.action === 'release.deploy.environment_check');
    expect(rec?.result).toBe('denied');
    expect(auditCalls.find((c) => c.action === 'release.deploy.failed')?.after?.outcome).toBe('DEPLOYMENT_FAILED');
  });

  it('IN THE DEPLOY: with the variable present the same candidate proceeds to the swap', async () => {
    const cand = join(tmp, 'cand2');
    mkdirSync(join(cand, 'dist', 'foundation', 'configuration'), { recursive: true });
    writeFileSync(join(cand, 'dist', 'foundation', 'configuration', 'configuration.schema.js'), `exports.configurationValidationSchema = { validate: (env) => ({ error: env.NEEDED_BY_NEW_RELEASE ? undefined : { details: [{ message: '"NEEDED_BY_NEW_RELEASE" is required' }] } }) };`);
    setEnv({ NEEDED_BY_NEW_RELEASE: 'yes' });
    const svc = build(cand);
    seedRelease();
    const result = await svc.deployRelease('r1', 'admin');
    expect(result.status).toBe('succeeded');
    expect(activate).toHaveBeenCalledTimes(1);
    expect(auditCalls.find((c) => c.action === 'release.deploy.environment_check')?.result).toBe('success');
  });
});
