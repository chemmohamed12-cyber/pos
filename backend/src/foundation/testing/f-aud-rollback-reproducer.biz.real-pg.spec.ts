import { AuditRecord } from '../audit/audit-record.entity';
import { BizEnv, abortBiz, finishBiz, record, result, setUpBiz } from './biz-support';

/**
 * F-AUD-003 REPRODUCER (informational — OUTSIDE the frozen T-xx set; it changes no verdict and NO product code).
 * Question: does a ROLLED-BACK transaction that wrote an audit record leave the company audit hash chain verifiable?
 * Found while verifying N-02 (T-21 case D: the chain broke exactly after an outer-transaction rollback that contained a successful audit write).
 * Hypothesis from reading AuditService.record + the table: `audit_records.seq` is `SERIAL PRIMARY KEY` and the entity `@PrimaryGeneratedColumn()`;
 * the service HASHES `seq = MAX(seq)+1`, but the stored `seq` comes from the DB sequence. A rolled-back insert still consumes a sequence value, so the next record is
 * stored with seq = hashed seq + 1 and verification (which recomputes the hash with the stored seq) fails from there on.
 * Cases: S) control: a record written and committed; R) a record written inside a transaction that is rolled back, then a committed record.
 * Reports whether the chain stays valid, the stored vs hashed seq, and the sequence state. Disposable databases `daii_test_biz_t22_*` only.
 */
describe('F-AUD-003 reproducer — audit chain after a rolled-back transaction that wrote an audit record', () => {
  jest.setTimeout(600_000);
  let env: (BizEnv & { warehouseId: string }) | undefined;
  let failure: unknown;
  afterAll(async () => {
    if (env) await abortBiz(env, failure);
  });

  it('records the behaviour', async () => {
    try {
      env = await setUpBiz('T-22', 'biz_t22');
      const e = env;
      const input = (i: number) => ({ actorUserId: null, organizationId: null, action: 'repro.rollback', resource: 'x', resourceId: String(i), result: 'success' as const, correlationId: null, after: { i } });
      const state = async () => {
        const rows = await e.dsA.query(`SELECT seq FROM audit_records ORDER BY seq`);
        const seqs = rows.map((r: { seq: number }) => Number(r.seq));
        const seqName = (await e.dsA.query(`SELECT pg_get_serial_sequence('audit_records','seq') AS s`))[0].s as string | null;
        const last = seqName ? Number((await e.dsA.query(`SELECT last_value FROM ${seqName}`))[0].last_value) : null;
        return { storedSeqs: seqs, sequenceLastValue: last };
      };

      // S) control
      await e.audit.record(input(1), e.manager);
      await e.audit.record(input(2), e.manager);
      const v0 = await e.audit.verifyCompanyChain(e.manager);
      const s0 = await state();

      // R) a transaction that writes an audit record and is rolled back
      let rolledBack = false;
      try {
        await e.manager.transaction(async (tx) => { await e.audit.record(input(3), tx); throw new Error('forced rollback'); });
      } catch { rolledBack = true; }
      const sAfterRollback = await state();
      await e.audit.record(input(4), e.manager);
      const v1 = await e.audit.verifyCompanyChain(e.manager);
      const s1 = await state();

      // X) exact persistence behaviour: does TypeORM store an EXPLICIT seq given to save() on the SERIAL primary key, or take the sequence default? (determines how the fix must insert)
      const probeRepo = e.dsA.getRepository(AuditRecord);
      const probe = probeRepo.create({ seq: 9000, timestamp: new Date(), actorUserId: null, organizationId: null, action: 'repro.explicit-seq', resource: 'x', resourceId: 'x', result: 'success', correlationId: null, before: null, after: null, prevHash: 'p', hash: 'h' });
      const saved = await probeRepo.save(probe);
      const explicitSeq = { requested: 9000, storedSeq: Number(saved.seq) };
      result(e, 'F-AUD-003-X-explicit-seq-honoured-by-save', explicitSeq.storedSeq === 9000 ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(explicitSeq));
      record(e, 'F-AUD-003.json', { control: { chainValid: v0.valid, ...s0 }, rolledBack, afterRollback: sAfterRollback, afterNextCommittedRecord: { chainValid: v1.valid, brokenAtSeq: v1.brokenAtSeq, ...s1 } });
      result(e, 'F-AUD-003-S-control', v0.valid ? 'PASS' : 'FAIL-DEFECT', JSON.stringify({ chainValid: v0.valid, ...s0 }));
      result(e, 'F-AUD-003-R-after-rollback', rolledBack && v1.valid ? 'PASS' : 'FAIL-DEFECT', JSON.stringify({ rolledBack, chainValid: v1.valid, brokenAtSeq: v1.brokenAtSeq, ...s1 }));
      await finishBiz(e);
    } catch (err) {
      failure = err;
      throw err;
    }
  });
});
