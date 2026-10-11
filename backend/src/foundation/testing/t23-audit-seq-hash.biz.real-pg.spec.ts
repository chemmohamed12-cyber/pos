import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { BizEnv, abortBiz, attempt, finishBiz, record, result, setUpBiz, widePool } from './biz-support';
import { computeAuditHash, GENESIS_HASH } from '../audit/audit-hash';

/**
 * T-23 — F-AUD-003 regression: the audit hash must commit to the seq that is actually STORED, so the chain stays verifiable after rollbacks, concurrency and mixed
 * commit/rollback load, without changing the hash format or touching existing records. Run BEFORE the fix it reproduces the stored-seq/hashed-seq mismatch (baseline).
 * Cases: R1 rollback then append (also repeated); R2 a rolled-back transaction with several audit writes; C1 concurrent appends; C2 concurrent appends where half roll back;
 * H golden vector (hash format unchanged); P1 an existing healthy chain keeps verifying and continues; P2 an existing BROKEN chain is preserved byte-for-byte (not repaired,
 * not rehashed, not deleted) and is still reported as broken. Disposable databases `daii_test_biz_t23_*` only (P1/P2 use the second Company database).
 */
describe('T-23 — audit hash commits to the stored seq (F-AUD-003)', () => {
  jest.setTimeout(900_000);
  let env: (BizEnv & { warehouseId: string }) | undefined;
  let failure: unknown;
  afterAll(async () => {
    if (env) await abortBiz(env, failure);
  });

  it('chain stays verifiable after rollbacks and concurrency; history is never rewritten', async () => {
    try {
      env = await setUpBiz('T-23', 'biz_t23');
      const e = env;
      const wide = await widePool(e, 40);
      const input = (tag: string, i: number) => ({ actorUserId: null, organizationId: null, action: `t23.${tag}`, resource: 'x', resourceId: String(i), result: 'success' as const, correlationId: null, after: { tag, i } });
      const verify = async (m = e.manager) => e.audit.verifyCompanyChain(m);
      const seqs = async (ds: DataSource) => (await ds.query(`SELECT seq FROM audit_records ORDER BY seq`)).map((r: { seq: number }) => Number(r.seq));
      const rollback = async (n: number, tag: string) => {
        const out = await attempt(() => wide.manager.transaction(async (tx) => { for (let i = 0; i < n; i += 1) await e.audit.record(input(tag, i), tx); throw new Error('forced rollback'); }));
        return !out.ok;
      };
      const detail: Record<string, unknown> = {};

      // ---- R1: rollback then append, repeated ----
      await e.audit.record(input('base', 0), e.manager);
      const rolled = [await rollback(1, 'r1a'), await rollback(1, 'r1b'), await rollback(1, 'r1c')];
      await e.audit.record(input('after-rollbacks', 1), e.manager);
      await e.audit.record(input('after-rollbacks', 2), e.manager);
      const v1 = await verify();
      detail.R1 = { rolled, chainValid: v1.valid, brokenAtSeq: v1.brokenAtSeq, storedSeqs: await seqs(e.dsA) };
      result(e, 'R1-rollback-then-append', rolled.every(Boolean) && v1.valid ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail.R1));

      // ---- R2: a rolled-back transaction with several audit writes ----
      const rolled2 = await rollback(5, 'r2');
      await e.audit.record(input('after-r2', 1), e.manager);
      const v2 = await verify();
      detail.R2 = { rolled: rolled2, chainValid: v2.valid, brokenAtSeq: v2.brokenAtSeq };
      result(e, 'R2-multi-write-rollback-then-append', rolled2 && v2.valid ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail.R2));

      // ---- C1: concurrent appends (plain manager, as controllers pass it) ----
      const before1 = (await seqs(e.dsA)).length;
      const c1 = await Promise.all(Array.from({ length: 40 }, (_, i) => attempt(() => e.audit.record(input('c1', i), wide.manager))));
      const v3 = await verify();
      const forks = Number((await e.dsA.query(`SELECT count(*)::int AS n FROM (SELECT "prevHash" FROM audit_records GROUP BY "prevHash" HAVING count(*) > 1) x`))[0].n);
      const added = (await seqs(e.dsA)).length - before1;
      detail.C1 = { ok: c1.filter((o) => o.ok).length, added, chainValid: v3.valid, forks };
      result(e, 'C1-concurrent-appends', c1.every((o) => o.ok) && added === 40 && v3.valid && forks === 0 ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail.C1));

      // ---- C2: concurrent appends, half committed and half rolled back ----
      const before2 = (await seqs(e.dsA)).length;
      const c2 = await Promise.all(Array.from({ length: 40 }, (_, i) => attempt(() => wide.manager.transaction(async (tx) => {
        await e.audit.record(input('c2', i), tx);
        if (i % 2 === 1) throw new Error('forced rollback');
      }))));
      const v4 = await verify();
      const forks2 = Number((await e.dsA.query(`SELECT count(*)::int AS n FROM (SELECT "prevHash" FROM audit_records GROUP BY "prevHash" HAVING count(*) > 1) x`))[0].n);
      const added2 = (await seqs(e.dsA)).length - before2;
      detail.C2 = { committed: c2.filter((o) => o.ok).length, rolledBack: c2.filter((o) => !o.ok).length, added: added2, chainValid: v4.valid, brokenAtSeq: v4.brokenAtSeq, forks: forks2 };
      result(e, 'C2-concurrent-mixed-commit-rollback', c2.filter((o) => o.ok).length === 20 && added2 === 20 && v4.valid && forks2 === 0 ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail.C2));

      // ---- H: golden vector — the hash format is unchanged ----
      const golden = computeAuditHash({ seq: 7, timestamp: '2026-10-11T00:00:00.000Z', actorUserId: '00000000-0000-4000-8000-000000000001', organizationId: null, action: 'golden.vector', resource: 'audit', resourceId: 'g-1', result: 'success', correlationId: null, before: null, after: { b: 2, a: 1, nested: { z: 1, y: [3, 2, 1] } }, prevHash: GENESIS_HASH });
      result(e, 'H-hash-format-golden-vector', golden === '677576fc26084b086de877950f5c0c44fb7d82654b3db445b6e509e4998cd3fe' ? 'PASS' : 'FAIL-DEFECT', golden);

      // ---- P1 / P2 on the second Company database: pre-existing chains ----
      const dsB = await e.h.connections.getDataSource(e.h.companyBId);
      const legacyRow = async (seq: number, hashedSeq: number, prevHash: string, i: number) => {
        const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, i));
        const after = { legacy: i };
        const hash = computeAuditHash({ seq: hashedSeq, timestamp: ts.toISOString(), actorUserId: null, organizationId: null, action: 'legacy.row', resource: 'x', resourceId: String(i), result: 'success', correlationId: null, before: null, after, prevHash });
        await dsB.query(`INSERT INTO audit_records (seq, "timestamp", "actorUserId", "organizationId", action, resource, "resourceId", result, "correlationId", "before", "after", "prevHash", hash) VALUES ($1,$2,NULL,NULL,'legacy.row','x',$3,'success',NULL,NULL,$4::jsonb,$5,$6)`, [seq, ts, String(i), JSON.stringify(after), prevHash, hash]);
        return hash;
      };
      // P1: three healthy legacy rows (stored seq == hashed seq, contiguous) then new appends
      let ph = GENESIS_HASH;
      for (let i = 1; i <= 3; i += 1) ph = await legacyRow(i, i, ph, i);
      await dsB.query(`SELECT setval(pg_get_serial_sequence('audit_records','seq'), 3)`);
      const p1before = await verify(dsB.manager);
      await e.audit.record(input('p1-new', 1), dsB.manager);
      await e.audit.record(input('p1-new', 2), dsB.manager);
      const p1after = await verify(dsB.manager);
      detail.P1 = { before: p1before, after: p1after };
      result(e, 'P1-existing-healthy-chain-continues', p1before.valid && p1after.valid ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail.P1));

      // P2: a legacy BROKEN chain (a record stored as seq 7 but hashed as 6) must be preserved and still reported, never repaired
      const lastHash = (await dsB.query(`SELECT hash FROM audit_records ORDER BY seq DESC LIMIT 1`))[0].hash as string;
      const brokenHash = await legacyRow(7, 6, lastHash, 7); // stored 7, hashed 6 => the F-AUD-003 signature
      await dsB.query(`SELECT setval(pg_get_serial_sequence('audit_records','seq'), 7)`);
      const snapshotHistory = JSON.stringify(await dsB.query(`SELECT seq, hash, "prevHash", "timestamp" FROM audit_records WHERE seq <= 7 ORDER BY seq`));
      const p2before = await verify(dsB.manager);
      await e.audit.record(input('p2-new', 1), dsB.manager);
      await e.audit.record(input('p2-new', 2), dsB.manager);
      const p2after = await verify(dsB.manager);
      const historyAfter = JSON.stringify(await dsB.query(`SELECT seq, hash, "prevHash", "timestamp" FROM audit_records WHERE seq <= 7 ORDER BY seq`));
      const stillBroken = !p2before.valid && p2before.brokenAtSeq === 7 && !p2after.valid && p2after.brokenAtSeq === 7;
      const newRowsLinkToBrokenTail = (await dsB.query(`SELECT "prevHash" FROM audit_records WHERE seq = (SELECT min(seq) FROM audit_records WHERE seq > 7)`))[0].prevHash === brokenHash;
      detail.P2 = { before: p2before, after: p2after, historyUnchanged: snapshotHistory === historyAfter, newRowsLinkToBrokenTail };
      result(e, 'P2-existing-broken-chain-preserved-not-repaired', stillBroken && snapshotHistory === historyAfter && newRowsLinkToBrokenTail ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail.P2));

      record(e, 'T-23-detail.json', detail);
      void randomUUID;
      await finishBiz(e);
    } catch (err) {
      failure = err;
      throw err;
    }
  });
});
