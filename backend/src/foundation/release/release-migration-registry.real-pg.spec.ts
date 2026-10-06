import { generateKeyPairSync, randomUUID, sign } from 'crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { ReleaseExecutionService } from './release-execution.service';
import { Release } from './release.entity';
import { ReleaseMigrationRun } from './release-migration-run.entity';
import { buildMigrationPreflight } from './migration-preflight';
import { createMigrationDataSource, discoverMigrationTags } from './migration-datasource';
import { MIGRATION_TAGS, tagsForModules } from '../../database/enabled-modules';
import { canonicalize } from '../entitlement/canonicalize';
import { computeInstallationFingerprint } from '../entitlement/installation-fingerprint';
import { assertIsolatedInstance, createDisposableDatabase, dbConfig, dropDisposableDatabase } from '../testing/saas-characterization.helpers';

/**
 * H3 Verification + Deployment Safety Gate (2026-10-06). Executes the REAL Release Engine
 * migration primitives (`ReleaseExecutionService.resolveEntitlementTags` / `runReleaseMigrations`
 * / `verifyMigrationsComplete` / `undoReleaseMigrations`, the real `buildMigrationPreflight`,
 * the real `createMigrationDataSource`) against REAL disposable PostgreSQL databases on the
 * ISOLATED instance (127.0.0.1:5544 — `assertIsolatedInstance()` refuses anything else), over
 * COPIES of the compiled `dist/database/migrations` tree (`npm run build` first).
 *
 * The two D3 migrations (1789860000000 / 1789870000000) are unapproved: they are never copied
 * into any test tree, so this spec can never apply them. Remove `HELD_MIGRATION_IDS` once D3 is approved.
 *
 * Not covered here (cannot run without a hosting host): the atomic slot swap, Passenger restart,
 * live health/smoke endpoints — those remain covered only by the mocked staged-activation /
 * release-execution-gates specs and the code trace in
 * `docs/acceptance/H3_DEPLOYMENT_SAFETY_GATE_2026-10-06.md`.
 */
const HELD_MIGRATION_IDS = ['1789860000000', '1789870000000'];
const DIST_MIGRATIONS = join(process.cwd(), 'dist', 'database', 'migrations');
const PREFIX = `daii_test_h3reg_${Date.now() % 100000}`;

/** Migrations added by "Release N+1" relative to "Release N" (accounting + manufacturing). */
const N1_ONLY_IDS = ['1789733000000', '1789760000000', '1790000100000', '1790000200000'];
const N1_ONLY_NAMES = [
  'CreateWipReconciliationTable1789733000000',
  'AddTransientDatabaseErrorClosingExceptionCategory1789760000000',
  'CreateRoutingAndWorkCenterTables1790000100000',
  'SeedManufacturingMasterDataTerminology1790000200000',
];

const roots: string[] = [];
const databases: string[] = [];

function nameOf(file: string): string | null {
  const m = /^(\d+)-(.+)\.js$/.exec(file);
  return m ? `${m[2]}${m[1]}` : null;
}

/** A copy of the compiled migration tree — minus held D3 migrations and anything `exclude` rejects — plus a dependency-free package.json (preflight probes it). */
function buildTree(exclude: (file: string) => boolean = () => false): string {
  const root = mkdtempSync(join(tmpdir(), 'h3reg-'));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'h3-tree', version: '0.0.0', dependencies: {} }));
  for (const tag of readdirSync(DIST_MIGRATIONS, { withFileTypes: true }).filter((e) => e.isDirectory())) {
    const out = join(root, 'dist', 'database', 'migrations', tag.name);
    mkdirSync(out, { recursive: true });
    for (const f of readdirSync(join(DIST_MIGRATIONS, tag.name))) {
      if (!/^\d+-.+\.js$/.test(f)) continue;
      if (HELD_MIGRATION_IDS.some((id) => f.startsWith(`${id}-`))) continue;
      if (exclude(f)) continue;
      cpSync(join(DIST_MIGRATIONS, tag.name, f), join(out, f));
    }
  }
  return root;
}

const isN1Only = (f: string): boolean => N1_ONLY_IDS.some((id) => f.startsWith(`${id}-`));

function namesOnDisk(root: string, tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const tag of tags) {
    const dir = join(root, 'dist', 'database', 'migrations', tag);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      const n = nameOf(f);
      if (n) out.push(n);
    }
  }
  return out.sort();
}

/** Writes a signed entitlement manifest next to the tree (the deploy's pre-swap step does exactly this) and returns the matching public keys. */
const KEY_PAIR = generateKeyPairSync('ed25519');
const KEYS = [{ kid: 'h3', spki_b64: KEY_PAIR.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }];

function writeEntitlement(root: string, moduleCodes: string[]) {
  const { privateKey } = KEY_PAIR;
  const manifest = {
    schema_version: 1,
    installation_id: 'h3-test',
    customer_name: 'H3 Test',
    edition_code: 'H3_TEST',
    edition_version: '1.0.0',
    module_codes: moduleCodes,
    feature_codes: [],
    limits: {},
    issued_at: new Date().toISOString(),
    license_id: 'h3-license',
    license_version: 1,
    kid: 'h3',
    installation_fingerprint: computeInstallationFingerprint(),
  };
  const canonical = canonicalize(manifest);
  writeFileSync(join(root, 'entitlement.manifest.json'), canonical, 'utf8');
  writeFileSync(join(root, 'entitlement.manifest.json.sig'), sign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('base64'), 'utf8');
  return KEYS;
}

interface Env {
  name: string;
  ds: DataSource;
}

let coreRoot: string | undefined;

/** A fresh disposable database already holding the platform `core` schema (so `releases` / `release_migration_runs` exist, as on any live installation). */
async function newEnv(suffix: string): Promise<Env> {
  const name = `${PREFIX}_${suffix}`;
  await createDisposableDatabase(name);
  databases.push(name);
  coreRoot ??= buildTree();
  const boot = createMigrationDataSource(coreRoot, dbConfig(name), ['core']);
  await boot.initialize();
  try {
    await boot.runMigrations();
  } finally {
    await boot.destroy();
  }
  const ds = new DataSource({ type: 'postgres', ...dbConfig(name), entities: [Release, ReleaseMigrationRun], synchronize: false, logging: false });
  await ds.initialize();
  return { name, ds };
}

interface ServiceOverrides {
  stagedActivation?: unknown;
  healthCheck?: unknown;
  lkg?: unknown;
}

function makeService(env: Env, appRoot: string, publicKeys: Array<{ kid: string; spki_b64: string }> = [], restore: { preflight: jest.Mock } = { preflight: jest.fn(async () => ({ status: 'failed' })) }, overrides: ServiceOverrides = {}) {
  const config = {
    releaseExecution: { appRoot, stagingPath: appRoot, passengerRestartFile: join(appRoot, 'restart.txt') },
    releaseDeploy: { manifestsPath: join(appRoot, 'manifests'), notifyWebhook: null },
    database: dbConfig(env.name),
    entitlement: { mode: 'unlicensed-full', publicKeys, clockToleranceMinutes: 10 },
  } as never;
  const audit = { record: jest.fn(async () => undefined) };
  const svc = new ReleaseExecutionService(
    env.ds,
    config,
    {} as never,
    {} as never,
    (overrides.healthCheck ?? {}) as never,
    restore as never,
    {} as never,
    (overrides.stagedActivation ?? {}) as never,
    (overrides.lkg ?? {}) as never,
    audit as never,
  );
  // private engine methods under test — called directly: the full deploy needs a hosting host (slot swap, Passenger, health).
  const priv = svc as unknown as {
    resolveEntitlementTags(appRoot: string): Promise<string[]>;
    runReleaseMigrations(release: unknown, appRoot: string, tags?: readonly string[]): Promise<void>;
    verifyMigrationsComplete(release: unknown, candidatePath: string, tags?: readonly string[]): Promise<string[]>;
    undoReleaseMigrations(release: unknown, actorUserId: string, head: string | null, migrationTreePath?: string): Promise<void>;
    rollbackAfterSwap(release: unknown, actorUserId: string, head: string | null, failedGate: string, entitlementPrevText?: string | null): Promise<{ status: string }>;
  };
  return { priv, svc, restore, audit };
}

/** A real `releases` row (release_migration_runs.releaseId has an FK to it). */
async function mkRelease(env: Env, files: string[] = [], backupRunId: string | null = null) {
  const manifest = { version: '9.9.9', files: files.map((path) => ({ path, action: 'add', checksum: 'x' })), migrations: [] };
  const repo = env.ds.getRepository(Release);
  const saved = await repo.save(
    repo.create({
      version: `9.9.9-h3-${randomUUID().slice(0, 8)}`,
      packageType: 'full',
      baseVersion: null,
      manifest: manifest as never,
      manifestChecksum: 'x',
      status: 'validated',
      uploadedByUserId: '00000000-0000-0000-0000-000000000000',
      backupRunId: null,
      completedAt: null,
      errorMessage: null,
    }),
  );
  // the engine only READS `release.backupRunId` (fallbackFullRestore) — kept in memory, not persisted (FK to backup_runs)
  return Object.assign(saved, { backupRunId });
}
const migFile = (tag: string, file: string) => `dist/database/migrations/${tag}/${file}`;

const executedNames = async (ds: DataSource): Promise<string[]> => ((await ds.query('SELECT name FROM migrations ORDER BY id')) as Array<{ name: string }>).map((r) => r.name);
const tableExists = async (ds: DataSource, t: string): Promise<boolean> => (await ds.query(`SELECT to_regclass('public.${t}') AS r`))[0].r !== null;

function filesFor(root: string, ids: string[]): string[] {
  const out: string[] = [];
  for (const tag of readdirSync(join(root, 'dist', 'database', 'migrations'))) {
    for (const f of readdirSync(join(root, 'dist', 'database', 'migrations', tag))) {
      if (ids.some((id) => f.startsWith(`${id}-`)) && /\.js$/.test(f)) out.push(migFile(tag, f));
    }
  }
  return out;
}

const OLD_REGISTRY = ['core', 'sales', 'inventory', 'logistics', 'finance', 'hr'];
/** Emulates the pre-fix 6-tag registry (negative control) for the duration of `fn`. */
async function withOldRegistry<T>(fn: () => Promise<T>): Promise<T> {
  const arr = MIGRATION_TAGS as unknown as string[];
  const saved = [...arr];
  arr.splice(0, arr.length, ...OLD_REGISTRY);
  try {
    return await fn();
  } finally {
    arr.splice(0, arr.length, ...saved);
  }
}

describe('H3 — Release Engine migration selection / upgrade / undo / failure safety (real PG, isolated)', () => {
  jest.setTimeout(900_000);

  beforeAll(() => {
    assertIsolatedInstance();
    if (!existsSync(DIST_MIGRATIONS)) throw new Error(`dist/database/migrations not found at ${DIST_MIGRATIONS} — run \`npm run build\` first.`);
  });

  afterAll(async () => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
    for (const d of databases) await dropDisposableDatabase(d).catch(() => undefined);
  });

  // ───────────────────────── A/B/C — forward selection per entitlement ─────────────────────────
  describe('forward: entitlement-driven selection through resolveEntitlementTags + runReleaseMigrations', () => {
    const cases: Array<{ label: string; modules: string[]; tags: string[]; has: string[]; hasNot: string[] }> = [
      {
        label: 'accounting',
        modules: ['accounting'],
        tags: ['accounting', 'core', 'finance', 'inventory', 'sales'],
        has: ['accounting_fiscal_years', 'accounting_gl_accounts'],
        hasNot: ['work_orders', 'routings'],
      },
      {
        label: 'manufacturing',
        modules: ['manufacturing'],
        tags: ['accounting', 'core', 'finance', 'inventory', 'manufacturing', 'sales'],
        has: ['work_orders', 'work_order_components', 'routings', 'work_centers', 'accounting_fiscal_years'],
        hasNot: [],
      },
      {
        label: 'sales (sales → finance → accounting chain)',
        modules: ['sales'],
        tags: ['accounting', 'core', 'finance', 'inventory', 'sales'],
        has: ['accounting_fiscal_years', 'accounting_gl_accounts'],
        hasNot: ['work_orders'],
      },
    ];

    it.each(cases)('$label: selects exactly the closure, runs every migration of it, runs nothing unrelated', async ({ label, modules, tags, has, hasNot }) => {
      const env = await newEnv(label.split(' ')[0]);
      const root = buildTree();
      const keys = writeEntitlement(root, modules);
      const { priv } = makeService(env, root, keys);

      const selected = await priv.resolveEntitlementTags(root);
      expect([...selected].sort()).toEqual(tags);

      await priv.runReleaseMigrations(await mkRelease(env), root, selected);

      expect((await executedNames(env.ds)).sort()).toEqual(namesOnDisk(root, tags)); // none omitted, none unrelated
      for (const t of has) expect(await tableExists(env.ds, t)).toBe(true);
      for (const t of hasNot) expect(await tableExists(env.ds, t)).toBe(false);
      await env.ds.destroy();
    });
  });

  // ───────────────────────── upgrade of an existing Company ─────────────────────────
  describe('upgrade: existing Company receives a newer release', () => {
    let env: Env;
    let bystander: Env;
    let rootN: string;
    let rootN1: string;
    let keys: Array<{ kid: string; spki_b64: string }>;
    let historyN: Array<{ id: number; name: string }>;
    let bystanderBefore: string[];
    let countsBefore: Record<string, number>;

    const tableCounts = async (ds: DataSource): Promise<Record<string, number>> => {
      const tables = (await ds.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('migrations','release_migration_runs','releases')`)) as Array<{ tablename: string }>;
      const out: Record<string, number> = {};
      for (const { tablename } of tables) out[tablename] = Number((await ds.query(`SELECT count(*) AS c FROM "${tablename}"`))[0].c);
      return out;
    };

    beforeAll(async () => {
      env = await newEnv('upgrade');
      bystander = await newEnv('bystander');
      rootN = buildTree(isN1Only);
      rootN1 = buildTree();
      keys = writeEntitlement(rootN, ['manufacturing']);
      writeEntitlement(rootN1, ['manufacturing']);
    });

    it('Release N provisions the Company; business data is written; a bystander Company exists', async () => {
      const { priv } = makeService(env, rootN, keys);
      const tags = await priv.resolveEntitlementTags(rootN);
      await priv.runReleaseMigrations(await mkRelease(env), rootN, tags);
      expect(await tableExists(env.ds, 'work_orders')).toBe(true);
      expect(await tableExists(env.ds, 'routings')).toBe(false); // N does not have the routing migration yet
      historyN = (await env.ds.query('SELECT id, name FROM migrations ORDER BY id')) as Array<{ id: number; name: string }>;
      expect(historyN.map((h) => h.name)).not.toEqual(expect.arrayContaining(N1_ONLY_NAMES));

      await env.ds.query(`INSERT INTO warehouses ("code","name","status","kind") VALUES ('WH-H3','H3 Warehouse','active','main')`);
      await env.ds.query(`INSERT INTO products ("sku","name","unitPrice","status") VALUES ('H3-SKU','H3 Product',12.5,'active')`);
      countsBefore = await tableCounts(env.ds);

      const bsvc = makeService(bystander, rootN, keys);
      await bsvc.priv.runReleaseMigrations(await mkRelease(env), rootN, ['core']);
      bystanderBefore = await executedNames(bystander.ds);
    });

    it('Release N+1 preflight: READY, pending == exactly the 4 new migrations, only in-scope tags', async () => {
      const report = await buildMigrationPreflight({
        candidatePath: rootN1,
        database: dbConfig(env.name),
        nodeBin: process.execPath,
        liveDataSource: env.ds,
        tags: ['accounting', 'core', 'finance', 'inventory', 'manufacturing', 'sales'],
        manifestFiles: filesFor(rootN1, N1_ONLY_IDS).map((path) => ({ path, action: 'add', checksum: 'x' })) as never,
        packageType: 'full',
        baseVersion: null,
        currentInstalledVersion: '0.0.0',
      });
      expect(report.blockedReasons).toEqual([]);
      expect(report.decision).toBe('READY_TO_ACTIVATE');
      expect([...report.pending].sort()).toEqual([...N1_ONLY_NAMES].sort());
      expect(report.tagDriftIssues).toEqual([]);
    });

    it('Release N+1 runs ONLY the pending migrations, exactly once; history and business data are preserved', async () => {
      const { priv } = makeService(env, rootN1, keys);
      const tags = await priv.resolveEntitlementTags(rootN1);
      const rel = await mkRelease(env, filesFor(rootN1, N1_ONLY_IDS));
      await priv.runReleaseMigrations(rel, rootN1, tags);

      const after = (await env.ds.query('SELECT id, name FROM migrations ORDER BY id')) as Array<{ id: number; name: string }>;
      expect(after.slice(0, historyN.length)).toEqual(historyN); // prior history byte-identical, ids unchanged
      expect(after.slice(historyN.length).map((r) => r.name).sort()).toEqual([...N1_ONLY_NAMES].sort());
      expect(after.length).toBe(historyN.length + 4);
      expect(new Set(after.map((r) => r.name)).size).toBe(after.length); // no duplicate execution
      expect((await executedNames(env.ds)).sort()).toEqual(namesOnDisk(rootN1, tags)); // nothing unrelated

      const runs = await env.ds.getRepository(ReleaseMigrationRun).find({ where: { releaseId: rel.id } });
      expect(runs.map((r) => r.migrationName).sort()).toEqual([...N1_ONLY_NAMES].sort());
      expect(runs.every((r) => r.success)).toBe(true);
      expect(await priv.verifyMigrationsComplete(rel, rootN1, tags)).toEqual([]);
      expect(await tableExists(env.ds, 'routings')).toBe(true);

      expect((await env.ds.query(`SELECT name FROM warehouses WHERE code='WH-H3'`))[0].name).toBe('H3 Warehouse');
      expect(Number((await env.ds.query(`SELECT "unitPrice" FROM products WHERE sku='H3-SKU'`))[0].unitPrice)).toBe(12.5);
      const countsAfter = await tableCounts(env.ds);
      for (const [t, c] of Object.entries(countsBefore)) {
        expect(countsAfter[t]).toBeDefined(); // no table dropped
        expect(countsAfter[t]).toBeGreaterThanOrEqual(c); // no row removed (seed migrations may only add)
      }
    });

    it('re-running the same release is a no-op (idempotent)', async () => {
      const { priv } = makeService(env, rootN1, keys);
      const tags = await priv.resolveEntitlementTags(rootN1);
      const before = await executedNames(env.ds);
      const rel = await mkRelease(env);
      await priv.runReleaseMigrations(rel, rootN1, tags);
      expect(await executedNames(env.ds)).toEqual(before);
      expect(await env.ds.getRepository(ReleaseMigrationRun).count({ where: { releaseId: rel.id } })).toBe(0);
    });

    it('a later release whose entitlement NARROWS (manufacturing dropped) removes nothing and runs nothing', async () => {
      const rootN2 = buildTree();
      const narrowKeys = writeEntitlement(rootN2, ['sales']);
      const { priv } = makeService(env, rootN2, narrowKeys);
      const tags = await priv.resolveEntitlementTags(rootN2);
      expect([...tags].sort()).toEqual(['accounting', 'core', 'finance', 'inventory', 'sales']);
      const before = await executedNames(env.ds);
      const countsBeforeNarrow = await tableCounts(env.ds);
      await priv.runReleaseMigrations(await mkRelease(env), rootN2, tags);
      expect(await executedNames(env.ds)).toEqual(before);
      expect(await tableExists(env.ds, 'work_orders')).toBe(true);
      expect(await tableExists(env.ds, 'routings')).toBe(true);
      expect(await tableCounts(env.ds)).toEqual(countsBeforeNarrow);
    });

    it("the bystander Company's database was never touched", async () => {
      expect(await executedNames(bystander.ds)).toEqual(bystanderBefore);
      expect(await tableExists(bystander.ds, 'routings')).toBe(false);
      await bystander.ds.destroy();
    });

    afterAll(async () => {
      if (env.ds.isInitialized) await env.ds.destroy();
    });
  });

  // ───────────────────────── rollback / undo ─────────────────────────
  describe('rollback: undoReleaseMigrations resolves the classes the forward deploy ran (H3 RB-1)', () => {
    let env: Env;
    let rootN: string; // the PREVIOUS release tree — what ACTIVE is after `rollbackSwap`
    let rootN1: string; // the CANDIDATE / FAILED-slot tree — holds release N+1's migration classes
    let rootFull: string; // no entitlement manifest on disk — the current production configuration
    let keysN: Array<{ kid: string; spki_b64: string }>;
    let historyN: string[];

    /** Runs release N+1's migrations from its candidate tree and records them against a fresh release row. */
    const forwardN1 = async (backupRunId: string | null = randomUUID()) => {
      const rel = await mkRelease(env, filesFor(rootN1, N1_ONLY_IDS), backupRunId);
      const { priv } = makeService(env, rootN1, keysN);
      await priv.runReleaseMigrations(rel, rootN1, await priv.resolveEntitlementTags(rootN1));
      expect((await executedNames(env.ds)).length).toBe(historyN.length + 4);
      return rel;
    };
    const expectBackAtN = async () => {
      expect(await executedNames(env.ds)).toEqual(historyN);
      expect(await tableExists(env.ds, 'routings')).toBe(false);
      expect(await tableExists(env.ds, 'work_orders')).toBe(true);
    };
    const stagedMock = (failedPath: string, appRoot: string) => ({ rollbackSwap: jest.fn(async () => ({ failedPath, activePath: appRoot })) });
    const healthy = { check: jest.fn(async () => ({ ok: true, detail: {} })) };

    beforeAll(async () => {
      env = await newEnv('undo');
      rootN = buildTree(isN1Only);
      rootN1 = buildTree();
      rootFull = buildTree();
      keysN = writeEntitlement(rootN, ['manufacturing']);
      writeEntitlement(rootN1, ['manufacturing']);
      const { priv } = makeService(env, rootN, keysN);
      await priv.runReleaseMigrations(await mkRelease(env), rootN, await priv.resolveEntitlementTags(rootN));
      historyN = await executedNames(env.ds);
    });

    afterAll(async () => {
      if (env.ds.isInitialized) await env.ds.destroy();
    });

    it('RB-1 proof: appRoot = restored PREVIOUS tree (lacks N+1 classes) + migrationTreePath = FAILED slot → undo succeeds, exactly the 4 migrations reverted, no backup restore', async () => {
      const rel = await forwardN1();
      const restore = { preflight: jest.fn(async () => ({ status: 'failed' })) };
      const undo = makeService(env, rootN, keysN, restore);
      await undo.priv.undoReleaseMigrations(rel, 'actor', null, rootN1);
      expect(restore.preflight).not.toHaveBeenCalled();
      await expectBackAtN();
    });

    it('safety fallback preserved: classes genuinely unavailable (failed-slot path lacks them) → undo rejects, backup restore is engaged, DB left exactly as migrated', async () => {
      const rel = await forwardN1();
      const restore = { preflight: jest.fn(async () => ({ status: 'failed' })) };
      const undo = makeService(env, rootN, keysN, restore);
      await expect(undo.priv.undoReleaseMigrations(rel, 'actor', null, rootN)).rejects.toThrow(/No migration .* was found in the source code/);
      expect(restore.preflight).toHaveBeenCalledTimes(1);
      expect((await executedNames(env.ds)).length).toBe(historyN.length + 4); // nothing half-undone
      await undo.priv.undoReleaseMigrations(rel, 'actor', null, rootN1); // recover to N for the next test
      await expectBackAtN();
    });

    it('legacy in-place path unchanged: no migrationTreePath → appRoot is used (appRoot = the tree holding the classes)', async () => {
      const rel = await forwardN1();
      const { priv } = makeService(env, rootN1, keysN);
      await priv.undoReleaseMigrations(rel, 'actor', null);
      await expectBackAtN();
    });

    it('WIRING rollbackAfterSwap: rollbackSwap() → failedPath → undo(failedPath) → classes resolved from the candidate slot → status rolled_back, no backup restore', async () => {
      const rel = await forwardN1(null); // the engine persists `release` here — backup_runs FK ⇒ no backup linked
      const staged = stagedMock(rootN1, rootN);
      const restore = { preflight: jest.fn(async () => ({ status: 'failed' })) };
      const { priv, audit } = makeService(env, rootN, keysN, restore, { stagedActivation: staged, healthCheck: healthy });
      const out = await priv.rollbackAfterSwap(rel, 'actor', null, 'post-swap health check failed');
      expect(staged.rollbackSwap).toHaveBeenCalledWith(rel.id);
      expect(out.status).toBe('rolled_back');
      expect(restore.preflight).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'release.rollback.completed' }));
      await expectBackAtN();
    });

    it('WIRING rollbackReleaseStaged (operator rollback of a COMMITted release): same failedPath → undo → rolled_back, LKG popped, no backup restore', async () => {
      const rel = await forwardN1();
      const staged = stagedMock(rootN1, rootN);
      const lkg = { read: jest.fn(async () => ({ current: { release_id: rel.id }, history: [{ backup_run_id: null }] })), popOnRollback: jest.fn(async () => undefined) };
      const restore = { preflight: jest.fn(async () => ({ status: 'failed' })) };
      const { svc } = makeService(env, rootN, keysN, restore, { stagedActivation: staged, healthCheck: healthy, lkg });
      const out = await svc.rollbackReleaseStaged(rel.id, 'actor');
      expect(staged.rollbackSwap).toHaveBeenCalledWith(rel.id);
      expect(out.status).toBe('rolled_back');
      expect(lkg.popOnRollback).toHaveBeenCalledTimes(1);
      expect(restore.preflight).not.toHaveBeenCalled();
      await expectBackAtN();
    });

    it('WIRING fail-safe preserved: failed slot genuinely lacks the classes and the backup restore fails → FAILED-SAFE (explicit, recoverable), DB untouched', async () => {
      const rel = await forwardN1(null); // no linked backup ⇒ fallbackFullRestore returns false (engagement itself is asserted in the unit-level fallback test)
      const staged = stagedMock(rootN, rootN); // the "failed slot" does not contain N+1's classes
      const restore = { preflight: jest.fn(async () => ({ status: 'failed' })) };
      const { priv } = makeService(env, rootN, keysN, restore, { stagedActivation: staged, healthCheck: healthy });
      const out = await priv.rollbackAfterSwap(rel, 'actor', null, 'post-swap health check failed');
      expect(out.status).toBe('failed_safe');
      expect((await executedNames(env.ds)).length).toBe(historyN.length + 4);
      const { priv: recover } = makeService(env, rootN, keysN);
      await recover.undoReleaseMigrations(rel, 'actor', null, rootN1);
      await expectBackAtN();
    });

    it('no manifest on disk (production config): undo of an accounting+manufacturing run resolves through the fixed registry', async () => {
      const rel = await mkRelease(env, filesFor(rootFull, N1_ONLY_IDS), randomUUID());
      const fwd = makeService(env, rootFull);
      await fwd.priv.runReleaseMigrations(rel, rootFull, discoverMigrationTags(rootFull)); // deploy without entitlement section → disk discovery
      const undo = makeService(env, rootFull);
      const tags = await undo.priv.resolveEntitlementTags(rootFull);
      expect([...tags].sort()).toEqual(discoverMigrationTags(rootFull).sort());
      await undo.priv.undoReleaseMigrations(rel, 'actor', null);
      expect((await executedNames(env.ds)).length).toBeLessThan(namesOnDisk(rootFull, discoverMigrationTags(rootFull)).length);
    });

    it('NEGATIVE CONTROL — the pre-fix 6-tag registry makes the same undo fail (proves this test detects the H3 registry defect)', async () => {
      const rel = await mkRelease(env, filesFor(rootFull, N1_ONLY_IDS), randomUUID());
      const fwd = makeService(env, rootFull);
      await fwd.priv.runReleaseMigrations(rel, rootFull, discoverMigrationTags(rootFull));
      const executedBeforeUndo = (await executedNames(env.ds)).length;

      const restore = { preflight: jest.fn(async () => ({ status: 'failed' })) };
      const undo = makeService(env, rootFull, [], restore);
      await withOldRegistry(async () => {
        await expect(undo.priv.undoReleaseMigrations(rel, 'actor', null)).rejects.toThrow(/No migration .* was found in the source code/);
      });
      expect(restore.preflight).toHaveBeenCalledTimes(1);
      expect((await executedNames(env.ds)).length).toBe(executedBeforeUndo);
      await undo.priv.undoReleaseMigrations(rel, 'actor', null); // the fixed registry resolves it
      expect((await executedNames(env.ds)).length).toBeLessThan(executedBeforeUndo);
    });
  });

  // ───────────────────────── failure safety ─────────────────────────
  describe('failure safety: fail closed, recoverable, no partial migration', () => {
    const FAILING = '1790999990000-H3FailingMigration.js';
    const failingSource =
      "class H3FailingMigration1790999990000 {\n  constructor() { this.name = 'H3FailingMigration1790999990000'; }\n  async up(q) { await q.query('CREATE TABLE h3_partial_marker (id int)'); throw new Error('H3 injected migration failure'); }\n  async down() {}\n}\nexports.H3FailingMigration1790999990000 = H3FailingMigration1790999990000;\n";
    let env: Env;
    let rootN: string;

    beforeAll(async () => {
      env = await newEnv('fail');
      rootN = buildTree(isN1Only);
      const { priv } = makeService(env, rootN);
      await priv.runReleaseMigrations(await mkRelease(env), rootN, ['accounting', 'core', 'finance', 'inventory', 'manufacturing', 'sales']);
    });
    afterAll(async () => {
      if (env.ds.isInitialized) await env.ds.destroy();
    });

    it('a migration that throws mid-batch rolls the WHOLE batch back and is recorded as failed', async () => {
      const root = buildTree();
      writeFileSync(join(root, 'dist', 'database', 'migrations', 'manufacturing', FAILING), failingSource);
      const before = await executedNames(env.ds);
      const rel = await mkRelease(env);
      const { priv } = makeService(env, root);
      await expect(priv.runReleaseMigrations(rel, root, ['accounting', 'core', 'finance', 'inventory', 'manufacturing', 'sales'])).rejects.toThrow(/H3 injected migration failure/);

      expect(await executedNames(env.ds)).toEqual(before); // no partial migration
      expect(await tableExists(env.ds, 'h3_partial_marker')).toBe(false);
      expect(await tableExists(env.ds, 'routings')).toBe(false); // earlier pending migrations of the same batch were rolled back too
      const runs = await env.ds.getRepository(ReleaseMigrationRun).find({ where: { releaseId: rel.id } });
      expect(runs.length).toBe(5);
      expect(runs.every((r) => !r.success && /H3 injected/.test(r.errorMessage ?? ''))).toBe(true); // explicitly reported
    });

    it('a migration the manifest ships but whose class is missing from the artifact → preflight BLOCKED (tag/migration drift)', async () => {
      const missing = '1790000200000-';
      const root = buildTree((f) => f.startsWith(missing));
      const report = await buildMigrationPreflight({
        candidatePath: root,
        database: dbConfig(env.name),
        nodeBin: process.execPath,
        liveDataSource: env.ds,
        tags: ['accounting', 'core', 'finance', 'inventory', 'manufacturing', 'sales'],
        manifestFiles: [{ path: migFile('manufacturing', '1790000200000-SeedManufacturingMasterDataTerminology.js'), action: 'add', checksum: 'x' }] as never,
        packageType: 'full',
        baseVersion: null,
        currentInstalledVersion: '0.0.0',
      });
      expect(report.decision).toBe('BLOCKED');
      expect(report.tagDriftIssues.join(' ')).toMatch(/SeedManufacturingMasterDataTerminology1790000200000/);
    });

    it('PRE-FIX registry + a release shipping a manufacturing migration → preflight was already BLOCKED (loud, not silent)', async () => {
      const root = buildTree();
      const oldTags = await withOldRegistry(async () => tagsForModules(['manufacturing']));
      expect(oldTags).not.toContain('manufacturing');
      const report = await buildMigrationPreflight({
        candidatePath: root,
        database: dbConfig(env.name),
        nodeBin: process.execPath,
        liveDataSource: env.ds,
        tags: oldTags,
        manifestFiles: filesFor(root, ['1790000100000']).map((path) => ({ path, action: 'add', checksum: 'x' })) as never,
        packageType: 'full',
        baseVersion: null,
        currentInstalledVersion: '0.0.0',
      });
      expect(report.decision).toBe('BLOCKED');
      expect(report.tagDriftIssues.length).toBeGreaterThan(0);
    });

    it('KNOWN GAP (characterization): an entitled tag whose directory is absent from the artifact and which ships no file is silently empty — not blocked', async () => {
      const root = buildTree();
      rmSync(join(root, 'dist', 'database', 'migrations', 'manufacturing'), { recursive: true, force: true });
      const report = await buildMigrationPreflight({
        candidatePath: root,
        database: dbConfig(env.name),
        nodeBin: process.execPath,
        liveDataSource: env.ds,
        tags: ['accounting', 'core', 'finance', 'inventory', 'manufacturing', 'sales'],
        manifestFiles: [], // a delta that does not mention manufacturing
        packageType: 'delta',
        baseVersion: null,
        currentInstalledVersion: '0.0.0',
      });
      expect(report.tagsInScope).toContain('manufacturing');
      expect(report.decision).toBe('READY_TO_ACTIVATE'); // documented residual gap — see H3 report
    });
  });
});
