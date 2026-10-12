import { BizEnv, abortBiz, attempt, finishBiz, record, result, setUpBiz, widePool } from './biz-support';

/**
 * T-28 — WP-AUD-08 acceptance tests for Option B (DEC-01b, CTO ruling 2026-10-12): the audit writer FAILS CLOSED when the audit sequence is not ahead of the stored tail.
 * It replaces T-27 (Option A, not approved) as the acceptance test; T-26 stays the unchanged pre-guard baseline. Same L1/L2 shapes as T-26, re-measured against the corrected writer.
 *  B0 healthy path unchanged · B8a/B8b the writer never issues setval (healthy and refusing) · B1 L1 refused with the identifiable error, no 23505, nothing written, sequence unchanged ·
 *  B3 10 repeated refusals, no drift · B4 20 concurrent writers all refused · B6 refusal inside an outer transaction · B5 operator realignment then 20 concurrent writers succeed ·
 *  B2 L2 refused before an out-of-order row exists · B5b realign then append · B7 an already-broken chain is not changed by refusals.
 * Disposable databases `daii_test_biz_t28_*` only. The operator realignment is performed by the test itself, exactly as the runbook describes it; the product never does it.
 */
describe('T-28 — audit sequence lag fails closed (WP-AUD-08, Option B)', () => {
  jest.setTimeout(900_000);
  let env: (BizEnv & { warehouseId: string }) | undefined;
  let failure: unknown;
  afterAll(async () => {
    if (env) await abortBiz(env, failure);
  });

  it('refuses, never realigns, never touches history', async () => {
    try {
      env = await setUpBiz('T-28', 'biz_t28');
      const e = env;
      const wide = await widePool(e, 40);
      const input = (tag: string, i: number) => ({ actorUserId: null, organizationId: null, action: `t28.${tag}`, resource: 'x', resourceId: String(i), result: 'success' as const, correlationId: null, after: { tag, i } });
      const seqName = (await e.dsA.query(`SELECT pg_get_serial_sequence('audit_records','seq') AS s`))[0].s as string;
      const rows = () => e.dsA.query(`SELECT seq::int AS seq, "prevHash", hash, action FROM audit_records ORDER BY seq`);
      const seqState = async () => { const r = (await e.dsA.query(`SELECT last_value::int AS last, is_called AS called FROM ${seqName}`))[0]; return `${r.last}/${r.called}`; };
      const valid = async () => (await e.audit.verifyCompanyChain(e.manager)).valid;
      const isLag = (o: { ok: boolean; kind: string; message?: string; pgCode?: string }) => !o.ok && o.kind === 'AuditSequenceLagError' && /AUDIT_SEQUENCE_LAG/.test(o.message ?? '') && o.pgCode !== '23505';
      /** runs `fn` on a transaction whose statements are recorded; returns the outcome and the SQL text seen */
      const spied = async (tag: string) => {
        const sql: string[] = [];
        const out = await attempt(() => e.dsA.transaction(async (tx) => {
          const spy = new Proxy(tx, {
            get(target, prop, recv) {
              if (prop === 'query') return async (text: string, params?: unknown[]) => { sql.push(text); return target.query(text, params); };
              const v = Reflect.get(target, prop, recv);
              return typeof v === 'function' ? v.bind(target) : v;
            },
          });
          await e.audit.record(input(tag, 0), spy as never);
        }));
        return { out, sql };
      };
      const detail: Record<string, unknown> = {};
      // exactly the runbook §5 template: advisory lock (same key as the writer) + setval to max(seq), one transaction
      const operatorRealign = () => e.dsA.transaction(async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(7419203511)');
        await tx.query(`SELECT setval('${seqName}', (SELECT max(seq) FROM audit_records), true)`);
      });

      // ---- B0: healthy path ----
      for (let i = 0; i < 5; i += 1) await e.audit.record(input('healthy', i), e.manager);
      detail.b0 = { rows: (await rows()).length, chainValid: await valid() };
      result(e, 'B0-healthy-path-unchanged', (detail.b0 as { rows: number }).rows === 5 && (await valid()) ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail.b0));

      // ---- B8a: healthy append issues no setval ----
      const h = await spied('spy-healthy');
      detail.b8a = { ok: h.out.ok, setvalStatements: h.sql.filter((q) => /setval/i.test(q)).length, statements: h.sql.length };
      result(e, 'B8a-healthy-append-issues-no-setval', h.out.ok && (detail.b8a as { setvalStatements: number }).setvalStatements === 0 ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail.b8a));

      // ---- B1 (L1 shape): sequence set back below the stored maximum ----
      const base1 = await rows();
      await e.dsA.query(`SELECT setval('${seqName}', 1, true)`);
      const s1 = await seqState();
      const l1 = await spied('l1');
      const after1 = await rows();
      detail.b1 = { append: l1.out, rowsBefore: base1.length, rowsAfter: after1.length, sequenceBefore: s1, sequenceAfter: await seqState(), chainValid: await valid(), setvalStatements: l1.sql.filter((q) => /setval/i.test(q)).length };
      result(e, 'B1-L1-refused-identifiable-error-nothing-written-sequence-unchanged', isLag(l1.out) && after1.length === base1.length && s1 === (detail.b1 as { sequenceAfter: string }).sequenceAfter && (await valid()) ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail.b1));
      result(e, 'B8b-refusing-append-issues-no-setval', (detail.b1 as { setvalStatements: number }).setvalStatements === 0 ? 'PASS' : 'FAIL-DEFECT', JSON.stringify({ setvalStatements: (detail.b1 as { setvalStatements: number }).setvalStatements }));

      // ---- B3: 10 repeated attempts, no drift ----
      const rep: Awaited<ReturnType<typeof attempt>>[] = [];
      for (let i = 0; i < 10; i += 1) rep.push(await attempt(() => e.audit.record(input('rep', i), e.manager)));
      detail.b3 = { allRefused: rep.every(isLag), sequenceBefore: s1, sequenceAfter: await seqState(), rows: (await rows()).length };
      result(e, 'B3-ten-repeated-refusals-no-drift', (detail.b3 as { allRefused: boolean }).allRefused && (detail.b3 as { sequenceAfter: string }).sequenceAfter === s1 && (detail.b3 as { rows: number }).rows === base1.length ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail.b3));

      // ---- B4: 20 concurrent writers under lag ----
      const outs = await Promise.all(Array.from({ length: 20 }, (_, i) => attempt(() => e.audit.record(input('c4', i), wide.manager))));
      const rs4 = await rows();
      detail.b4 = { refused: outs.filter(isLag).length, other: outs.filter((o) => !isLag(o)).map((o) => ({ kind: o.kind, pgCode: o.pgCode })), rows: rs4.length, sequenceAfter: await seqState() };
      result(e, 'B4-twenty-concurrent-writers-all-refused', outs.every(isLag) && rs4.length === base1.length && (detail.b4 as { sequenceAfter: string }).sequenceAfter === s1 ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail.b4));

      // ---- B6: refusal inside an outer transaction that would otherwise commit ----
      const outer = await attempt(() => wide.manager.transaction(async (tx) => { await e.audit.record(input('outer', 0), tx); }));
      detail.b6 = { outer, rows: (await rows()).length, sequenceAfter: await seqState() };
      result(e, 'B6-refusal-inside-outer-transaction', isLag(outer) && (detail.b6 as { rows: number }).rows === base1.length && (detail.b6 as { sequenceAfter: string }).sequenceAfter === s1 ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail.b6));

      // ---- B5: the operator realigns (as in the runbook), then 20 concurrent writers succeed ----
      await operatorRealign();
      const outs5 = await Promise.all(Array.from({ length: 20 }, (_, i) => attempt(() => e.audit.record(input('c5', i), wide.manager))));
      const rs5 = await rows();
      const uniq5 = rs5.length === new Set(rs5.map((r: { seq: number }) => r.seq)).size;
      detail.b5 = { ok: outs5.filter((o) => o.ok).length, rows: rs5.length, uniqueSeq: uniq5, chainValid: await valid() };
      result(e, 'B5-after-operator-realignment-20-concurrent-writers-succeed', outs5.every((o) => o.ok) && rs5.length === base1.length + 20 && uniq5 && (await valid()) ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail.b5));

      // ---- B2 (L2 shape): a valid-hash row with a far higher explicit seq, sequence left behind ----
      const before2 = await rows();
      const tail = before2[before2.length - 1];
      const { computeAuditHash } = await import('../audit/audit-hash');
      const bigSeq = Number(tail.seq) + 100;
      const importedHash = computeAuditHash({ seq: bigSeq, prevHash: tail.hash, timestamp: '2026-10-12T00:00:00.000Z', actorUserId: null, organizationId: null, action: 't28.imported', resource: 'x', resourceId: 'imp', result: 'success', correlationId: null, before: null, after: null });
      await e.dsA.query(
        `INSERT INTO audit_records (seq,"prevHash",hash,"timestamp","actorUserId","organizationId",action,resource,"resourceId",result,"correlationId","before","after") VALUES ($1,$2,$3,$4,NULL,NULL,'t28.imported','x','imp','success',NULL,NULL,NULL)`,
        [bigSeq, tail.hash, importedHash, '2026-10-12T00:00:00.000Z'],
      );
      const pre2 = await rows();
      const s2 = await seqState();
      const l2 = await attempt(() => e.audit.record(input('l2', 0), e.manager));
      const l2rep: Awaited<ReturnType<typeof attempt>>[] = [];
      for (let i = 0; i < 10; i += 1) l2rep.push(await attempt(() => e.audit.record(input('l2rep', i), e.manager)));
      const post2 = await rows();
      detail.b2 = { importedSeq: bigSeq, chainValidBefore: await valid(), append: l2, repeatedAllRefused: l2rep.every(isLag), rowsBefore: pre2.length, rowsAfter: post2.length, importedRowUntouched: JSON.stringify(post2) === JSON.stringify(pre2), sequenceBefore: s2, sequenceAfter: await seqState() };
      result(e, 'B2-L2-refused-before-an-out-of-order-row-exists', isLag(l2) && (detail.b2 as { repeatedAllRefused: boolean }).repeatedAllRefused && (detail.b2 as { importedRowUntouched: boolean }).importedRowUntouched && (detail.b2 as { sequenceAfter: string }).sequenceAfter === s2 && (await valid()) ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail.b2));

      // ---- B5b: operator realigns above the imported row, the next append is valid ----
      await operatorRealign();
      const ok5b = await attempt(() => e.audit.record(input('after-l2', 0), e.manager));
      const rs5b = await rows();
      detail.b5b = { append: ok5b, newSeq: rs5b[rs5b.length - 1].seq, chainValid: await valid() };
      result(e, 'B5b-after-operator-realignment-append-valid', ok5b.ok && (rs5b[rs5b.length - 1].seq as number) > bigSeq && (await valid()) ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail.b5b));

      // ---- B7: an already-broken chain is neither changed nor repaired by refusals ----
      await e.dsA.query(`UPDATE audit_records SET hash = repeat('a',64) WHERE seq = (SELECT min(seq) FROM audit_records)`); // disposable DB: simulate pre-existing damage
      await e.dsA.query(`SELECT setval('${seqName}', 1, true)`);
      const damaged = JSON.stringify(await rows());
      const sBroken = await seqState();
      const b7 = await attempt(() => e.audit.record(input('on-broken', 0), e.manager));
      detail.b7 = { append: b7, rowsIdentical: JSON.stringify(await rows()) === damaged, stillBroken: !(await valid()), sequenceUnchanged: (await seqState()) === sBroken };
      result(e, 'B7-broken-chain-not-changed-by-refusal', isLag(b7) && (detail.b7 as { rowsIdentical: boolean }).rowsIdentical && (detail.b7 as { stillBroken: boolean }).stillBroken && (detail.b7 as { sequenceUnchanged: boolean }).sequenceUnchanged ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail.b7));

      // ---- B9: the pre-check arithmetic (next = is_called ? last+1 : last) is only valid for a plain increment-1, cache-1 sequence (design G-11) ----
      const sq = (await e.dsA.query(`SELECT increment_by::int AS inc, cache_size::int AS cache FROM pg_sequences WHERE schemaname || '.' || sequencename = $1 OR sequencename = regexp_replace($1, '^.*\\.', '')`, [seqName.replace(/"/g, '')]))[0];
      detail.b9 = sq;
      result(e, 'B9-audit-sequence-is-increment-1-cache-1', sq && sq.inc === 1 && sq.cache === 1 ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(sq ?? null));

      record(e, 'T-28-detail.json', detail);
      await finishBiz(e);
    } catch (err) {
      failure = err;
      throw err;
    }
  });
});
