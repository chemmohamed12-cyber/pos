import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { Company } from './company.entity';
import { User } from '../identity/user.entity';
import { UsersService } from '../identity/users.service';
import { DatabaseRegistryUniqueDatabaseName1790011000000 } from '../../database/migrations/core/1790011000000-DatabaseRegistryUniqueDatabaseName';

/**
 * Passenger may run several Node workers. N SEPARATE OS processes (not N async calls in one process) create Companies at the same instant over one control-plane
 * database and a pool smaller than N: the database alone must keep every pooled database single-owner, and no Company row may be left behind by the losers.
 */
const HOST = process.env.DB_HOST ?? '127.0.0.1';
const PORT = process.env.DB_PORT ? Number(process.env.DB_PORT) : 0;
const ADMIN = process.env.DB_USER ?? '';
const ADMIN_PW = process.env.DB_PASSWORD ?? '';
const describeIsolated = PORT && PORT !== 5433 && ADMIN ? describe : describe.skip;
const tag = randomUUID().slice(0, 6);
const CP = `daii_test_mp_cp_${tag}`;

describeIsolated('Company database pool — several OS processes at once (real Postgres, isolated instance only)', () => {
  jest.setTimeout(900_000);
  const toDrop: string[] = [CP];
  let cp: DataSource;
  let adminUserId: string;
  const adminCfg = { type: 'postgres' as const, host: HOST, port: PORT, username: ADMIN, password: ADMIN_PW, database: 'postgres' };
  const withAdmin = async <T>(fn: (ds: DataSource) => Promise<T>): Promise<T> => {
    const ds = new DataSource(adminCfg);
    await ds.initialize();
    try { return await fn(ds); } finally { await ds.destroy(); }
  };

  const runWorker = (pool: string[], name: string) =>
    new Promise<{ ok: boolean; companyId?: string; code?: string | null; message?: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', join(process.cwd(), 'src/foundation/testing/company-pool-worker.ts')], {
        env: { ...process.env, TS_NODE_PROJECT: join(process.cwd(), 'tsconfig.json'), WORKER_CP_DB: CP, WORKER_POOL: JSON.stringify(pool), WORKER_NAME: name, WORKER_ADMIN: adminUserId },
        cwd: process.cwd(),
      });
      let out = '', err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('close', () => {
        const line = out.split('\n').find((l) => l.startsWith('RESULT '));
        if (line) resolve(JSON.parse(line.slice(7)));
        else reject(new Error(`worker produced no result: ${err.slice(-800)}`));
      });
    });

  beforeAll(async () => {
    await withAdmin((ds) => ds.query(`CREATE DATABASE "${CP}"`));
    const { runMigrationsForDatabase } = await import('../release-orchestration/company-migration-runner');
    const migrated = await runMigrationsForDatabase(process.cwd(), { host: HOST, port: PORT, username: ADMIN, password: ADMIN_PW, database: CP }, ['core']);
    if (!migrated.success) throw new Error(`control-plane migration failed: ${migrated.error}`);
    cp = new DataSource({ type: 'postgres', host: HOST, port: PORT, username: ADMIN, password: ADMIN_PW, database: CP, entities: [Company, User], synchronize: false });
    await cp.initialize();
    await cp.query(`INSERT INTO "installation" ("id","installationId","customerName","editionCode","editionVersion","entitlementManifest") VALUES ('installation','test-installation','Test','DAII_STANDARD','1.0.0','{}')`);
    adminUserId = (await new UsersService(cp.getRepository(User)).create({ fullName: 'MP Admin', email: `mp-admin-${tag}@test.local` })).id;
  });
  afterAll(async () => {
    await cp?.destroy();
    await withAdmin(async (ds) => { for (const d of toDrop) await ds.query(`DROP DATABASE IF EXISTS "${d}" WITH (FORCE)`); });
  });

  it('the migration created the unique index, and the database itself refuses a second registration of a database name', async () => {
    expect((await cp.query(`SELECT 1 FROM pg_indexes WHERE indexname='UQ_database_registries_databaseName'`)).length).toBe(1);
    const c1 = (await cp.query(`INSERT INTO companies ("installationId", name, status) VALUES ('installation','u1','PROVISIONING') RETURNING id`))[0].id;
    const c2 = (await cp.query(`INSERT INTO companies ("installationId", name, status) VALUES ('installation','u2','PROVISIONING') RETURNING id`))[0].id;
    await cp.query(`INSERT INTO database_registries ("companyId", host, port, "databaseName", status) VALUES ($1,'h',1,'dup_db','PROVISIONING')`, [c1]);
    await expect(cp.query(`INSERT INTO database_registries ("companyId", host, port, "databaseName", status) VALUES ($1,'h',1,'dup_db','PROVISIONING')`, [c2])).rejects.toThrow(/UQ_database_registries_databaseName/);
    await cp.query(`DELETE FROM database_registries WHERE "databaseName"='dup_db'`);
    await cp.query(`DELETE FROM companies WHERE id IN ($1,$2)`, [c1, c2]);
  });

  it('the migration refuses (and changes nothing) when duplicates already exist, naming them', async () => {
    const c1 = (await cp.query(`INSERT INTO companies ("installationId", name, status) VALUES ('installation','d1','PROVISIONING') RETURNING id`))[0].id;
    const c2 = (await cp.query(`INSERT INTO companies ("installationId", name, status) VALUES ('installation','d2','PROVISIONING') RETURNING id`))[0].id;
    await cp.query(`DROP INDEX "UQ_database_registries_databaseName"`);
    await cp.query(`INSERT INTO database_registries ("companyId", host, port, "databaseName", status) VALUES ($1,'h',1,'same_db','FAILED'), ($2,'h',1,'same_db','FAILED')`, [c1, c2]);
    const qr = cp.createQueryRunner();
    await expect(new DatabaseRegistryUniqueDatabaseName1790011000000().up(qr)).rejects.toThrow(/same_db x2/);
    expect((await cp.query(`SELECT count(*)::int n FROM database_registries WHERE "databaseName"='same_db'`))[0].n).toBe(2); // untouched
    await qr.release();
    await cp.query(`DELETE FROM database_registries WHERE "databaseName"='same_db'`);
    await cp.query(`DELETE FROM companies WHERE id IN ($1,$2)`, [c1, c2]);
    await new DatabaseRegistryUniqueDatabaseName1790011000000().up(cp.createQueryRunner());
    expect((await cp.query(`SELECT 1 FROM pg_indexes WHERE indexname='UQ_database_registries_databaseName'`)).length).toBe(1);
  });

  it('6 separate processes, 3 pooled databases: exactly 3 Companies are created, every database has ONE owner, and the losers leave no Company behind', async () => {
    const pool = ['mp_a', 'mp_b', 'mp_c'].map((n) => `${n}_${tag}`);
    for (const d of pool) { toDrop.push(d); await withAdmin((ds) => ds.query(`CREATE DATABASE "${d}"`)); }
    const before = (await cp.query(`SELECT count(*)::int n FROM companies`))[0].n;

    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => runWorker(pool, `W${i}`)));

    const ok = results.filter((r) => r.ok);
    const refused = results.filter((r) => !r.ok);
    expect(refused.map((r) => r.code)).toEqual(Array(3).fill('COMPANY_DATABASE_POOL_EXHAUSTED'));
    expect(ok).toHaveLength(3);
    const regs: Array<{ databaseName: string; status: string; companyId: string }> = await cp.query(`SELECT "databaseName", status, "companyId" FROM database_registries WHERE "databaseName" = ANY($1)`, [pool]);
    expect(regs.map((r) => r.databaseName).sort()).toEqual([...pool].sort()); // each pooled database registered exactly once
    expect(regs.every((r) => r.status === 'ACTIVE')).toBe(true);
    expect((await cp.query(`SELECT count(*)::int n FROM companies`))[0].n).toBe(before + 3); // no orphan Company from the losers
    expect((await cp.query(`SELECT count(*)::int n FROM companies WHERE status='PROVISIONING'`))[0].n).toBe(0);
  });
});
