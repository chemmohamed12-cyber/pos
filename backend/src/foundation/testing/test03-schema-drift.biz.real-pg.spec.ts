import { DataSource } from 'typeorm';
import { BizEnv, abortBiz, finishBiz, record, result, setUpBiz } from './biz-support';
import { COMPANY_ENTITY_REGISTRY } from '../database-registry/company-entity-registry';

/**
 * TEST-03 / axis 2 — READ-ONLY schema-drift check (no product code is changed; the database is a disposable `daii_test_biz_t18_*`).
 * A fresh Company database is migrated with EVERY Company tag (the same migrations a new Company receives), then TypeORM's schema builder is asked — without executing
 * anything (`log()`) — which statements would be needed to make the database match the entity metadata (COMPANY_ENTITY_REGISTRY). Any statement returned is a drift between
 * the entities the code expects and what the migrations create (the class of defect seen earlier with `roles.type`). The reverse direction (tables/columns that exist in the
 * database but no entity maps) is reported too. Both lists are recorded as evidence; non-empty lists are FINDINGS (FAIL-DEFECT), not harness errors.
 */
describe('TEST-03 — entity metadata vs migrated Company schema', () => {
  jest.setTimeout(900_000);
  let env: (BizEnv & { warehouseId: string }) | undefined;
  let failure: unknown;
  afterAll(async () => {
    if (env) await abortBiz(env, failure);
  });

  it('reports drift in both directions', async () => {
    try {
      const ALL_TAGS = ['sales', 'inventory', 'finance', 'procurement', 'accounting', 'logistics', 'manufacturing', 'hr', 'attendance', 'commission', 'payroll', 'targets'];
      env = await setUpBiz('T-18', 'biz_t18', { tags: ALL_TAGS });
      const e = env;
      const dbName = e.databases.find((d) => d.endsWith('_company_a'))!;
      const o: any = e.dsA.options;
      const ds = new DataSource({ type: 'postgres', host: o.host, port: o.port, username: o.username, password: o.password, database: dbName, entities: COMPANY_ENTITY_REGISTRY as never, synchronize: false, logging: false });
      await ds.initialize();
      try {
        // entity -> schema: what would the schema builder have to do?
        const sqlInMemory = await ds.driver.createSchemaBuilder().log();
        const statements = sqlInMemory.upQueries.map((q) => q.query.replace(/\s+/g, ' ').slice(0, 300));
        // schema -> entity: tables / columns present in the database with no entity mapping
        const mappedTables = new Set(ds.entityMetadatas.map((m) => m.tableName));
        const dbTables: Array<{ table_name: string }> = await ds.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`);
        const infra = new Set(['typeorm_migrations', 'migrations', 'schema_migrations']);
        const unmappedTables = dbTables.map((t) => t.table_name).filter((t) => !mappedTables.has(t) && !infra.has(t)).sort();
        const dbCols: Array<{ table_name: string; column_name: string }> = await ds.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`);
        const mappedCols = new Map(ds.entityMetadatas.map((m) => [m.tableName, new Set(m.columns.map((c) => c.databaseName))]));
        const unmappedColumns = dbCols.filter((c) => mappedCols.has(c.table_name) && !mappedCols.get(c.table_name)!.has(c.column_name)).map((c) => `${c.table_name}.${c.column_name}`).sort();
        record(e, 'T-18-schema-drift.json', { entityCount: ds.entityMetadatas.length, tablesInDatabase: dbTables.length, entityToSchemaStatements: statements, tablesWithoutEntity: unmappedTables, columnsWithoutEntityProperty: unmappedColumns });
        result(e, 'T-18-entity-to-schema', statements.length === 0 ? 'PASS' : 'FAIL-DEFECT', `${statements.length} statement(s) the schema builder would need; first: ${statements[0] ?? '-'}`);
        result(e, 'T-18-schema-to-entity-tables', unmappedTables.length === 0 ? 'PASS' : 'FAIL-DEFECT', `${unmappedTables.length} table(s) without an entity: ${unmappedTables.slice(0, 12).join(', ')}`);
        result(e, 'T-18-schema-to-entity-columns', unmappedColumns.length === 0 ? 'PASS' : 'FAIL-DEFECT', `${unmappedColumns.length} column(s) without an entity property: ${unmappedColumns.slice(0, 12).join(', ')}`);
      } finally {
        await ds.destroy();
      }
      // ---- control-plane database vs the platform entities (every *.entity.ts that is not a Company entity) ----
      const cpName = e.databases.find((d) => d.endsWith('_control_plane'))!;
      const company = new Set(COMPANY_ENTITY_REGISTRY as unknown[]);
      const cp = new DataSource({ type: 'postgres', host: o.host, port: o.port, username: o.username, password: o.password, database: cpName, entities: [process.cwd() + '/src/**/*.entity.ts'], synchronize: false, logging: false });
      await cp.initialize();
      try {
        const platformMeta = cp.entityMetadatas.filter((m) => !company.has(m.target));
        const cp2 = new DataSource({ type: 'postgres', host: o.host, port: o.port, username: o.username, password: o.password, database: cpName, entities: platformMeta.map((m) => m.target) as never, synchronize: false, logging: false });
        await cp2.initialize();
        try {
          const up = (await cp2.driver.createSchemaBuilder().log()).upQueries.map((q) => q.query.replace(/\s+/g, ' ').slice(0, 300));
          const structural = up.filter((q) => /ADD COLUMN|DROP COLUMN|CREATE TABLE|DROP TABLE|ALTER COLUMN/.test(q));
          record(e, 'T-18-control-plane-drift.json', { platformEntities: platformMeta.length, statements: up.length, structural, all: up });
          result(e, 'T-18-control-plane-structural', structural.length === 0 ? 'PASS' : 'FAIL-DEFECT', `${platformMeta.length} platform entities; ${up.length} statement(s), ${structural.length} structural: ${structural.slice(0, 6).join(' | ')}`);
        } finally { await cp2.destroy(); }
      } finally { await cp.destroy(); }
      await finishBiz(e);
    } catch (err) {
      failure = err;
      throw err;
    }
  });
});
