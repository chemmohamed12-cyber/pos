import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { AuditService } from './audit.service';
import { AuditRecord } from './audit-record.entity';

/**
 * daii_dev evidence: seq 13 and seq 14 of `audit_records` carry the SAME prevHash (two writers read the same chain head), so `verifyChain` reports the chain broken at
 * seq 14 with no tampering. Real PostgreSQL, isolated instance only: many concurrent writers must still produce one linear, verifiable chain.
 */
const HOST = process.env.DB_HOST ?? '127.0.0.1';
const PORT = process.env.DB_PORT ? Number(process.env.DB_PORT) : 0;
const USER = process.env.DB_USER ?? '';
const PW = process.env.DB_PASSWORD ?? '';
const describeIsolated = PORT && PORT !== 5433 && USER ? describe : describe.skip;

describeIsolated('AuditService.record — concurrent writers keep one linear chain (real Postgres, isolated instance only)', () => {
  jest.setTimeout(120_000);
  const dbName = `daii_test_${process.env.DAII_TEST_DB_NS ?? ''}auditchain_${randomUUID().slice(0, 8)}`;
  let admin: DataSource;
  let ds: DataSource;

  beforeAll(async () => {
    admin = new DataSource({ type: 'postgres', host: HOST, port: PORT, username: USER, password: PW, database: 'postgres' });
    await admin.initialize();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    ds = new DataSource({ type: 'postgres', host: HOST, port: PORT, username: USER, password: PW, database: dbName, entities: [AuditRecord], synchronize: true, extra: { max: 20 } });
    await ds.initialize();
  });
  afterAll(async () => {
    await ds?.destroy();
    await admin?.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin?.destroy();
  });

  it('40 simultaneous records => 40 distinct seqs, every prevHash is the previous record\'s hash, verifyChain is valid', async () => {
    const audit = new AuditService(ds);
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        audit.record({ actorUserId: null, organizationId: null, action: 'test.concurrent', resource: 'x', resourceId: String(i), result: 'success', correlationId: null, after: { i } }),
      ),
    );
    const rows: Array<{ seq: number; hash: string; prevHash: string }> = await ds.query('SELECT seq, hash, "prevHash" FROM audit_records ORDER BY seq');
    expect(rows).toHaveLength(40);
    for (let i = 1; i < rows.length; i++) expect(rows[i].prevHash).toBe(rows[i - 1].hash);
    expect(await audit.verifyChain()).toEqual({ valid: true, brokenAtSeq: null });
  });
});
