import { BizEnv, abortBiz, attempt, finishBiz, record, result, setUpBiz } from './biz-support';

/**
 * T-26 — PA-33 sequence-lag BASELINE (observation only; nothing is fixed and no guard is proposed here as implemented).
 * Question: what does the CURRENT audit writer do when `audit_records.seq`'s sequence is behind the data (a restore/import that did not set the sequence, or a manual reset)?
 * Shapes (all on a disposable Company database, healthy chain first): L1 sequence set back below max(seq); L2 a row with an explicit seq far above the sequence's last value
 * (valid hash, as an import would carry), then one ordinary append. Each shape records: did the append succeed, which seq/prevHash did it get, and is the chain verifiable.
 * Disposable databases `daii_test_biz_t26_*` only. No existing audit data of any real database is read or changed.
 */
describe('T-26 — audit sequence lag baseline (PA-33 input)', () => {
  jest.setTimeout(900_000);
  let env: (BizEnv & { warehouseId: string }) | undefined;
  let failure: unknown;
  afterAll(async () => {
    if (env) await abortBiz(env, failure);
  });

  it('records how the current writer behaves when the sequence is behind the stored data', async () => {
    try {
      env = await setUpBiz('T-26', 'biz_t26');
      const e = env;
      const input = (tag: string, i: number) => ({ actorUserId: null, organizationId: null, action: `t26.${tag}`, resource: 'x', resourceId: String(i), result: 'success' as const, correlationId: null, after: { tag, i } });
      const seqName = (await e.dsA.query(`SELECT pg_get_serial_sequence('audit_records','seq') AS s`))[0].s as string;
      const state = async () => {
        const rows = await e.dsA.query(`SELECT seq::int AS seq, left("prevHash",10) AS prev10, left(hash,10) AS hash10 FROM audit_records ORDER BY seq`);
        const v = await e.audit.verifyCompanyChain(e.manager);
        const last = (await e.dsA.query(`SELECT last_value::int AS lv FROM ${seqName}`))[0].lv;
        return { rows, chainValid: v.valid, brokenAtSeq: v.brokenAtSeq, sequenceLastValue: last };
      };
      const detail: Record<string, unknown> = {};

      for (let i = 0; i < 3; i += 1) await e.audit.record(input('base', i), e.manager);
      detail.healthy = await state();
      result(e, 'L0-healthy-baseline', (detail.healthy as { chainValid: boolean }).chainValid ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail.healthy));

      // L1: sequence set back below the stored maximum (max seq 3, sequence reset to 1 => next nextval is 2, which already exists)
      await e.dsA.query(`SELECT setval('${seqName}', 1, true)`);
      const l1 = await attempt(() => e.audit.record(input('l1', 0), e.manager));
      detail.L1 = { append: l1, after: await state() };
      result(e, 'L1-sequence-behind-max-seq', l1.ok && (detail.L1 as { after: { chainValid: boolean } }).after.chainValid ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail.L1));

      // L2: realign, then insert a row with an explicit seq above the sequence (valid hash) and append once more
      await e.dsA.query(`SELECT setval('${seqName}', (SELECT max(seq) FROM audit_records), true)`);
      const tail = (await e.dsA.query(`SELECT seq::int AS seq, hash FROM audit_records ORDER BY seq DESC LIMIT 1`))[0];
      const { computeAuditHash } = await import('../audit/audit-hash');
      const bigSeq = Number(tail.seq) + 100;
      const importedHash = computeAuditHash({ seq: bigSeq, prevHash: tail.hash, timestamp: '2026-10-11T00:00:00.000Z', actorUserId: null, organizationId: null, action: 't26.imported', resource: 'x', resourceId: 'imp', result: 'success', correlationId: null, before: null, after: null });
      await e.dsA.query(
        `INSERT INTO audit_records (seq,"prevHash",hash,"timestamp","actorUserId","organizationId",action,resource,"resourceId",result,"correlationId","before","after") VALUES ($1,$2,$3,$4,NULL,NULL,'t26.imported','x','imp','success',NULL,NULL,NULL)`,
        [bigSeq, tail.hash, importedHash, '2026-10-11T00:00:00.000Z'],
      );
      const l2pre = await state();
      const l2 = await attempt(() => e.audit.record(input('l2', 0), e.manager));
      detail.L2 = { importedSeq: bigSeq, chainValidBeforeAppend: l2pre.chainValid, append: l2, after: await state() };
      result(e, 'L2-explicit-seq-above-sequence-then-append', l2.ok && (detail.L2 as { after: { chainValid: boolean } }).after.chainValid ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail.L2));

      record(e, 'T-26-detail.json', detail);
      await finishBiz(e);
    } catch (err) {
      failure = err;
      throw err;
    }
  });
});
