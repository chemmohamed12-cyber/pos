import { BizEnv, abortBiz, finishBiz, record, result, setUpBiz } from './biz-support';
import { AuditRecord } from '../audit/audit-record.entity';
import { computeAuditHash, GENESIS_HASH } from '../audit/audit-hash';
import { randomUUID } from 'crypto';

/**
 * T-29 — WP-AUD-09 / PA-43 PILOT on a DISPOSABLE experimental Company database (`daii_test_biz_t29_*`). It answers, without running the UUID repair and without any write to
 * historical data: (1) does the read-only need-check protocol (Q0–Q6, counts only, in READ ONLY transactions) work and classify a legacy-like database correctly; (2) what WOULD the
 * repair do to the hashed audit columns — computed in memory only (the repair is never called). The seeded database stands in for a legacy single-database copy: a `users` row with a
 * well-formed but non-RFC4122 id (variant nibble outside [89ab]) that audit rows reference through `actorUserId` (soft reference, listed in uuid-repair.core.ts SOFT_REFERENCES).
 * This is a PROTOCOL PILOT, not a need check of any real database (that stays blocked on an approved read-only role and database list).
 */
const RX = '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

describe('T-29 — PA-43 pilot: audit-row exposure to the UUID repair (read-only, simulated)', () => {
  jest.setTimeout(900_000);
  let env: (BizEnv & { warehouseId: string }) | undefined;
  let failure: unknown;
  afterAll(async () => {
    if (env) await abortBiz(env, failure);
  });

  it('measures exposure with counts only and shows the hash effect in memory', async () => {
    try {
      env = await setUpBiz('T-29', 'biz_t29');
      const e = env;
      const legacyUser = '11111111-1111-1111-1111-111111111111'; // valid uuid syntax, non-RFC4122 (version 1, variant 1)
      await e.dsA.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,'Legacy User','legacy-t29@test.local')`, [legacyUser]);
      const input = (tag: string, i: number, actor: string | null) => ({ actorUserId: actor, organizationId: null, action: `t29.${tag}`, resource: 'x', resourceId: String(i), result: 'success' as const, correlationId: null, after: { tag, i } });
      for (let i = 0; i < 3; i += 1) await e.audit.record(input('legacy', i, legacyUser), e.manager);
      for (let i = 0; i < 2; i += 1) await e.audit.record(input('modern', i, e.actor), e.manager);
      await e.audit.record(input('system', 0, null), e.manager);
      await e.audit.record(input('legacy-late', 3, legacyUser), e.manager);
      const detail: Record<string, unknown> = {};
      const auditFingerprint = async () => (await e.dsA.query(`SELECT md5(string_agg(t::text, '|' ORDER BY seq)) AS h, count(*)::int AS n FROM audit_records t`))[0];
      const usersFingerprint = async () => (await e.dsA.query(`SELECT md5(string_agg(t::text, '|' ORDER BY id)) AS h FROM users t`))[0].h as string;
      const before = { audit: await auditFingerprint(), users: await usersFingerprint() };

      // ---- Q0–Q6 in a READ ONLY transaction (counts only) ----
      const qr = e.dsA.createQueryRunner();
      await qr.connect();
      const q: Record<string, unknown> = {};
      let writeRefused = false;
      try {
        await qr.query('BEGIN TRANSACTION READ ONLY');
        const one = async (sql: string, params: unknown[] = []) => (await qr.query(sql, params))[0];
        q.Q0 = await one(`SELECT to_regclass('public.users') IS NOT NULL AS users, to_regclass('public.org_units') IS NOT NULL AS org_units, to_regclass('public.audit_records') IS NOT NULL AS audit_records, to_regclass('public.data_repair_runs') IS NOT NULL AS data_repair_runs`);
        q.Q1 = Number((await one(`SELECT count(*)::int AS n FROM users WHERE id::text !~* $1`, [RX])).n);
        q.Q2 = (q.Q0 as { org_units: boolean }).org_units ? Number((await one(`SELECT count(*)::int AS n FROM org_units WHERE id::text !~* $1`, [RX])).n) : null;
        q.Q3 = Number((await one(`SELECT count(*)::int AS n FROM audit_records WHERE "actorUserId"::text !~* $1 OR "organizationId"::text !~* $1`, [RX])).n);
        q.Q4 = await one(`SELECT count(*)::int AS n, min(seq)::int AS min, max(seq)::int AS max FROM audit_records`);
        q.Q5 = (q.Q0 as { data_repair_runs: boolean }).data_repair_runs ? Number((await one('SELECT count(*)::int AS n FROM data_repair_runs')).n) : null;
        q.Q6 = (q.Q0 as { data_repair_runs: boolean }).data_repair_runs ? await qr.query('SELECT status, count(*)::int AS n FROM data_repair_runs GROUP BY status') : null;
        try { await qr.query(`UPDATE audit_records SET "actorUserId" = "actorUserId" WHERE false`); } catch (err) { writeRefused = (err as { code?: string }).code === '25006'; }
      } finally {
        await qr.query('ROLLBACK').catch(() => undefined);
        await qr.release();
      }
      detail.protocol = { ...q, writeAttemptInsideReadOnlyTransactionRefused: writeRefused };
      const need = Number(q.Q1) > 0 && Number(q.Q3) > 0;
      result(e, 'P1-read-only-need-check-queries-counts-only', writeRefused && Number(q.Q1) === 1 && Number(q.Q3) === 4 && (q.Q4 as { n: number }).n === 7 && need ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail.protocol));

      // ---- simulated effect on the hashed columns (in memory; the repair is never invoked) ----
      const rows = await e.dsA.getRepository(AuditRecord).find({ order: { seq: 'ASC' } });
      const newId = randomUUID(); // what the repair would assign to the legacy user
      let expectedPrev = GENESIS_HASH;
      let firstBrokenSeq: number | null = null;
      let rowsWhoseHashInputChanges = 0;
      let rowsStoredHashStillMatches = 0;
      for (const r of rows) {
        const touched = r.actorUserId === legacyUser;
        if (touched) rowsWhoseHashInputChanges += 1;
        const recomputed = computeAuditHash({ seq: r.seq, timestamp: r.timestamp.toISOString(), actorUserId: touched ? newId : r.actorUserId, organizationId: r.organizationId, action: r.action, resource: r.resource, resourceId: r.resourceId, result: r.result, correlationId: r.correlationId, before: r.before, after: r.after, prevHash: expectedPrev });
        if (recomputed === r.hash && r.prevHash === expectedPrev) rowsStoredHashStillMatches += 1;
        else if (firstBrokenSeq === null) firstBrokenSeq = r.seq;
        expectedPrev = r.hash;
      }
      const chainNow = await e.audit.verifyCompanyChain(e.manager);
      detail.simulation = { chainValidToday: chainNow.valid, rowsWhoseHashInputWouldChange: rowsWhoseHashInputChanges, rowsThatWouldStillVerifyIndividually: rowsStoredHashStillMatches, totalRows: rows.length, chainWouldFirstBreakAtSeq: firstBrokenSeq, note: 'computed in memory; no UPDATE was issued; the stored hash/prevHash are not recomputed by the repair' };
      result(e, 'S1-simulated-repair-would-break-chain-at-first-legacy-row', chainNow.valid && rowsWhoseHashInputChanges === 4 && firstBrokenSeq === 1 && rowsStoredHashStillMatches === rows.length - rowsWhoseHashInputChanges ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail.simulation));

      // ---- nothing was written ----
      const after = { audit: await auditFingerprint(), users: await usersFingerprint() };
      detail.untouched = { before, after };
      result(e, 'N1-no-historical-row-changed', before.audit.h === after.audit.h && before.audit.n === after.audit.n && before.users === after.users && (await e.audit.verifyCompanyChain(e.manager)).valid ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail.untouched));

      record(e, 'T-29-detail.json', detail);
      await finishBiz(e);
    } catch (err) {
      failure = err;
      throw err;
    }
  });
});
