import { Logger } from '@nestjs/common';
import { BizEnv, abortBiz, attempt, finishBiz, record, result, setUpBiz, widePool } from './biz-support';

/**
 * T-27 — WP-AUD-08 acceptance tests for the audit sequence-lag guard (DEC-01b option A). Acceptance test 1 (both T-26 failure modes now succeed with a valid chain) is the T-26 spec itself,
 * run unchanged against the guarded code; this spec holds tests 2–6 (test 7 = the regression runs listed in the report). Disposable databases `daii_test_biz_t27_*` only.
 * 2 healthy path: no realignment happens; 3 a broken chain is preserved byte for byte (only the new row is added); 4 concurrent appends under lag: no fork, no duplicate;
 * 5 rollback after a realignment: sequence stays advanced, next append valid; 6 fail-closed: setval failing, or not moving the sequence, writes nothing and aborts.
 */
describe('T-27 — audit sequence-lag guard acceptance (WP-AUD-08)', () => {
  jest.setTimeout(900_000);
  let env: (BizEnv & { warehouseId: string }) | undefined;
  let failure: unknown;
  afterAll(async () => {
    if (env) await abortBiz(env, failure);
  });

  it('guard realigns the sequence only when behind, never touches history, fails closed', async () => {
    try {
      env = await setUpBiz('T-27', 'biz_t27');
      const e = env;
      const wide = await widePool(e, 40);
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const realigns = () => warn.mock.calls.filter((c) => String(c[0]).includes('realigned')).length;
      const input = (tag: string, i: number) => ({ actorUserId: null, organizationId: null, action: `t27.${tag}`, resource: 'x', resourceId: String(i), result: 'success' as const, correlationId: null, after: { tag, i } });
      const seqName = (await e.dsA.query(`SELECT pg_get_serial_sequence('audit_records','seq') AS s`))[0].s as string;
      const rows = () => e.dsA.query(`SELECT seq::int AS seq, "prevHash", hash, action FROM audit_records ORDER BY seq`);
      const valid = async () => (await e.audit.verifyCompanyChain(e.manager)).valid;
      const detail: Record<string, unknown> = {};

      // ---- 2: healthy path, no realignment ----
      for (let i = 0; i < 5; i += 1) await e.audit.record(input('healthy', i), e.manager);
      detail.t2 = { realigns: realigns(), chainValid: await valid() };
      result(e, 'AT2-healthy-path-no-realignment', realigns() === 0 && (detail.t2 as { chainValid: boolean }).chainValid ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail.t2));

      // ---- 3: broken historical chain preserved byte for byte ----
      await e.dsA.query(`UPDATE audit_records SET hash = repeat('a',64) WHERE seq = 2`); // disposable DB: simulate pre-existing damage
      const damaged = await rows();
      await e.dsA.query(`SELECT setval('${seqName}', 1, true)`); // and lag at the same time
      const a3 = await attempt(() => e.audit.record(input('on-broken', 0), e.manager));
      const after3 = await rows();
      const sameHistory = JSON.stringify(after3.slice(0, damaged.length)) === JSON.stringify(damaged);
      const added = after3.length - damaged.length;
      detail.t3 = { append: a3, sameHistory, added, stillBroken: !(await valid()) };
      result(e, 'AT3-broken-chain-preserved', a3.ok && sameHistory && added === 1 && (detail.t3 as { stillBroken: boolean }).stillBroken ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail.t3));

      // ---- 4: concurrent appends under lag ----
      const base = await rows();
      const maxSeq = base[base.length - 1].seq as number;
      const tailHash = base[base.length - 1].hash as string;
      await e.dsA.query(`SELECT setval('${seqName}', 1, true)`);
      const r4 = realigns();
      const outs = await Promise.all(Array.from({ length: 40 }, (_, i) => attempt(() => e.audit.record(input('c4', i), wide.manager))));
      const rs4 = await rows();
      const dupSeq = rs4.length - new Set(rs4.map((r: { seq: number }) => r.seq)).size;
      const forks = Number((await e.dsA.query(`SELECT count(*)::int AS n FROM (SELECT "prevHash" FROM audit_records GROUP BY "prevHash" HAVING count(*) > 1) x`))[0].n);
      const tail4 = rs4.filter((r: { seq: number }) => r.seq > maxSeq);
      const linked = tail4.every((r: { prevHash: string }, i: number) => r.prevHash === (i === 0 ? tailHash : tail4[i - 1].hash));
      detail.t4 = { ok: outs.filter((o) => o.ok).length, added: rs4.length - base.length, dupSeq, forks, tailLinked: linked, realignments: realigns() - r4 };
      result(e, 'AT4-concurrent-appends-under-lag', outs.every((o) => o.ok) && rs4.length - base.length === 40 && dupSeq === 0 && forks === 0 && linked ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail.t4));

      // ---- 5: rollback after a realignment ----
      const preRb = await rows();
      const maxBefore5 = preRb[preRb.length - 1].seq as number;
      await e.dsA.query(`SELECT setval('${seqName}', 1, true)`);
      const rolled = await attempt(() => wide.manager.transaction(async (tx) => { await e.audit.record(input('rb', 0), tx); throw new Error('forced rollback'); }));
      const seqAfterRollback = Number((await e.dsA.query(`SELECT last_value::int AS v FROM ${seqName}`))[0].v);
      const next = await attempt(() => e.audit.record(input('after-rb', 0), e.manager));
      const rs5 = await rows();
      const unique = rs5.length === new Set(rs5.map((r: { seq: number }) => r.seq)).size;
      const tailPrev = rs5[rs5.length - 1].prevHash === rs5[rs5.length - 2].hash;
      detail.t5 = { rolledBack: !rolled.ok, sequenceAfterRollback: seqAfterRollback, nextAppend: next, maxSeq: rs5[rs5.length - 1].seq, unique, tailPrev };
      result(e, 'AT5-rollback-after-realignment', !rolled.ok && next.ok && unique && tailPrev && seqAfterRollback >= maxBefore5 && (rs5[rs5.length - 1].seq as number) > maxBefore5 ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail.t5));

      // ---- 6: fail closed ----
      for (const mode of ['setval-throws', 'setval-no-op'] as const) {
        await e.dsA.query(`SELECT setval('${seqName}', 1, true)`);
        const n0 = (await rows()).length;
        const out = await attempt(() => e.dsA.transaction(async (tx) => {
          const guarded = new Proxy(tx, {
            get(target, prop, recv) {
              if (prop === 'query') {
                return async (sql: string, params?: unknown[]) => {
                  if (/setval/i.test(sql)) {
                    if (mode === 'setval-throws') throw new Error('permission denied for sequence audit_records_seq_seq');
                    return [{ setval: 1 }];
                  }
                  return target.query(sql, params);
                };
              }
              const v = Reflect.get(target, prop, recv);
              return typeof v === 'function' ? v.bind(target) : v;
            },
          });
          await e.audit.record(input(`fc-${mode}`, 0), guarded as never);
        }));
        const n1 = (await rows()).length;
        detail[`t6-${mode}`] = { call: out, rowsBefore: n0, rowsAfter: n1 };
        const typed = mode === 'setval-no-op' ? out.kind === 'AuditSequenceLagError' : /permission denied/.test(out.message ?? '');
        result(e, `AT6-fail-closed-${mode}`, !out.ok && typed && n1 === n0 ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail[`t6-${mode}`]));
      }

      warn.mockRestore();
      record(e, 'T-27-detail.json', detail);
      await finishBiz(e);
    } catch (err) {
      failure = err;
      throw err;
    }
  });
});
