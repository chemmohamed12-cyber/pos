import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { runMigrationsForDatabase } from '../release-orchestration/company-migration-runner';
import { applyCompanyAuthorizationSchemaAdjustment } from '../company/company-authorization-schema-adjustment';
import { seedCompanyAdminRole, seedCompanyRoleTemplates } from '../company/company-role-seeding';
import {
  APP_ROOT,
  Recorder,
  assertIsolatedInstance,
  createDisposableDatabase,
  dbConfig,
  dropDisposableDatabase,
  hashFile,
  hashTree,
  residueOf,
  tableExists,
} from '../testing/saas-characterization.helpers';

/**
 * WP-0.5a — TEST-ONLY characterization (CTO-authorized, 2026-10-05).
 * Question (Dossier F-11, previously NOT VERIFIED): can an EXISTING Company database
 * gain a module's migrations and role templates after it was provisioned, with its
 * existing data intact — and what does "removing" a module do?
 *
 * Disposable databases on the isolated instance only. No production code changed.
 * Known outcomes are asserted; outcomes not known in advance are RECORDED, not
 * asserted (they become findings, never fixes).
 */
describe('WP-0.5a characterization — adding / removing a module on an existing Company database (real-Postgres, isolated instance)', () => {
  jest.setTimeout(900_000);
  const rec = new Recorder();
  const MAIN = 'daii_test_wp05a_main';
  const PROBE = 'daii_test_wp05a_probe';
  const sources = ['src/foundation/release-orchestration/company-migration-runner.ts', 'src/foundation/company/company-role-seeding.ts', 'src/foundation/company/company-authorization-schema-adjustment.ts', 'src/foundation/release/migration-datasource.ts'];
  let ds: DataSource;
  let before: Record<string, string>;
  let migrationsTreeBefore: string;

  const count = async (table: string) => Number((await ds.query(`SELECT count(*)::int AS n FROM "${table}"`))[0].n);

  beforeAll(async () => {
    assertIsolatedInstance();
    before = Object.fromEntries(sources.map((s) => [s, hashFile(s)]));
    migrationsTreeBefore = hashTree('src/database/migrations');
    await createDisposableDatabase(MAIN);
    await createDisposableDatabase(PROBE);
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    await dropDisposableDatabase(MAIN);
    await dropDisposableDatabase(PROBE);
    rec.record('sourceHashesBefore', before);
    rec.record('sourceHashesAfter', Object.fromEntries(sources.map((s) => [s, hashFile(s)])));
    rec.record('migrationsTreeBefore', migrationsTreeBefore);
    rec.record('migrationsTreeAfter', hashTree('src/database/migrations'));
    rec.record('residue', await residueOf('daii_test_wp05a'));
    rec.flush('wp05a');
    expect(await residueOf('daii_test_wp05a')).toEqual([]);
  });

  it('BASELINE — provisioned like a core-only Company: core tables exist, module tables do not', async () => {
    const cfg = dbConfig(MAIN);
    const coreRun = await runMigrationsForDatabase(APP_ROOT, cfg, ['core']);
    expect(coreRun.success).toBe(true);
    await applyCompanyAuthorizationSchemaAdjustment(cfg);
    await seedCompanyRoleTemplates(cfg, []);
    await seedCompanyAdminRole(cfg, []);
    ds = new DataSource({ type: 'postgres', ...cfg, synchronize: false, logging: false });
    await ds.initialize();
    expect(await tableExists(ds, 'roles')).toBe(true);
    expect(await tableExists(ds, 'customers')).toBe(false);
    expect(await tableExists(ds, 'sales_orders')).toBe(false);
    rec.record('coreMigrationsRan', coreRun.ranMigrationNames.length);

    // "existing data": a user + admin role grant that must survive the later module add
    const adminRole = (await ds.query(`SELECT id FROM "roles" WHERE "key" = 'admin'`))[0];
    const userId = randomUUID();
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,'Existing Admin',$2)`, [userId, `existing-${userId}@test.local`]);
    await ds.query(`INSERT INTO "user_roles" ("id","userId","roleId") VALUES ($1,$2,$3)`, [randomUUID(), userId, adminRole.id]);
    rec.record('baseline', { roles: await count('roles'), rolePermissions: await count('role_permissions'), users: await count('users'), userRoles: await count('user_roles') });
  });

  it('ADD — running the migration pipeline again with an additional tag adds ONLY that tag\'s tables; existing data is untouched; a re-run is a no-op', async () => {
    const baseline = rec.data.baseline as Record<string, number>;
    const add = await runMigrationsForDatabase(APP_ROOT, dbConfig(MAIN), ['core', 'sales']);
    expect(add.success).toBe(true);
    expect(add.ranMigrationNames.length).toBeGreaterThan(0);
    expect(await tableExists(ds, 'customers')).toBe(true);
    expect(await tableExists(ds, 'sales_orders')).toBe(true);
    expect({ roles: await count('roles'), rolePermissions: await count('role_permissions'), users: await count('users'), userRoles: await count('user_roles') }).toEqual(baseline);
    rec.record('addSalesRan', add.ranMigrationNames.length);

    const again = await runMigrationsForDatabase(APP_ROOT, dbConfig(MAIN), ['core', 'sales']);
    expect(again.success).toBe(true);
    expect(again.ranMigrationNames).toEqual([]);
  });

  it('ROLE TEMPLATES — seeding the added module onto the existing Company works and gives the existing admin role the module root node (RECORDED)', async () => {
    const cfg = dbConfig(MAIN);
    const adminId = (await ds.query(`SELECT id FROM "roles" WHERE "key" = 'admin'`))[0].id;
    const nodesBefore = (await ds.query(`SELECT "nodeKey" FROM "role_permissions" WHERE "roleId" = $1`, [adminId])).map((r: { nodeKey: string }) => r.nodeKey).sort();
    const templates = await seedCompanyRoleTemplates(cfg, ['sales']);
    const adminGrants = await seedCompanyAdminRole(cfg, ['sales']);
    const nodesAfter = (await ds.query(`SELECT "nodeKey" FROM "role_permissions" WHERE "roleId" = $1`, [adminId])).map((r: { nodeKey: string }) => r.nodeKey).sort();
    rec.record('roleTemplates', { templates, adminGrants, adminNodesBefore: nodesBefore, adminNodesAfter: nodesAfter, adminAlreadyHadSalesRootBeforeSeeding: nodesBefore.includes('sales') });
    // Finding (not assumed): the core migrations already seed module root nodes onto the Company `admin` role,
    // so the seeding call is expected to be a no-op for the admin role; what it adds is the module role templates.
    expect(nodesAfter).toContain('sales');
    expect(templates.roles).toBeGreaterThanOrEqual(0);
  });

  it('REMOVE — running with a smaller tag set is a no-op: nothing is reverted, tables and data remain (data retained)', async () => {
    const tablesBefore = (await ds.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`))[0].n;
    const run = await runMigrationsForDatabase(APP_ROOT, dbConfig(MAIN), ['core']);
    expect(run.success).toBe(true);
    expect(run.ranMigrationNames).toEqual([]);
    expect((await ds.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`))[0].n).toBe(tablesBefore);
    expect(await tableExists(ds, 'customers')).toBe(true);
  });

  it('PROBE (RECORDED, not asserted) — adding a dependent module tag without its dependencies on a core-only database', async () => {
    const cfg = dbConfig(PROBE);
    const core = await runMigrationsForDatabase(APP_ROOT, cfg, ['core']);
    expect(core.success).toBe(true);
    const probe = await runMigrationsForDatabase(APP_ROOT, cfg, ['core', 'accounting']);
    rec.record('accountingWithoutDependencies', { success: probe.success, ran: probe.ranMigrationNames.length, error: probe.error ? probe.error.slice(0, 300) : null });
    expect(typeof probe.success).toBe('boolean');
  });
});
