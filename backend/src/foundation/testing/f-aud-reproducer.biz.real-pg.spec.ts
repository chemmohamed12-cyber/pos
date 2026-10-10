import { randomUUID } from 'crypto';
import { BizEnv, abortBiz, finishBiz, record, result, setUpBiz, widePool } from './biz-support';

/**
 * F-AUD-002 REPRODUCER (informational — OUTSIDE the frozen T-xx set; it never changes a frozen verdict).
 * Question: does AuditService.record keep the Company audit hash chain intact under concurrency when it is called with a plain
 * (non-transactional) EntityManager — which is how most controllers call it (`req.companyContext.dataSource.manager`) — versus with a transaction manager?
 *   A) 60 concurrent record(input, plainManager)           -> observed result recorded
 *   B) 60 concurrent manager.transaction(tx => record(input, tx)) -> observed result recorded
 * Hypothesis from reading AuditService.record: with a plain manager the `pg_advisory_xact_lock` statement runs in its own implicit transaction and is
 * released immediately, so two records can read the same "latest hash" (a fork) and verifyChain reports a break although nothing was tampered with.
 * Disposable databases `daii_test_biz_t13_*` only (outside the numbered T-01..T-12 names on purpose).
 */
describe('F-AUD-002 reproducer — audit chain under concurrency, plain manager vs transaction manager', () => {
  jest.setTimeout(600_000);
  let env: (BizEnv & { warehouseId: string }) | undefined;
  let failure: unknown;
  afterAll(async () => {
    if (env) await abortBiz(env, failure);
  });

  it('records the observed behaviour of both calling styles', async () => {
    try {
      env = await setUpBiz('T-13', 'biz_t13');
      const e = env;
      const wide = await widePool(e, 80);
      const input = (i: number) => ({ actorUserId: null, organizationId: null, action: 'repro.concurrent', resource: 'x', resourceId: String(i), result: 'success' as const, correlationId: null, after: { i } });
      const forks = async () => (await e.dsA.query(`SELECT count(*)::int AS n FROM (SELECT "prevHash" FROM audit_records GROUP BY "prevHash" HAVING count(*) > 1) x`))[0].n as number;

      // B first (transaction manager) on a clean chain
      await Promise.all(Array.from({ length: 60 }, (_, i) => wide.manager.transaction((tx) => e.audit.record(input(i), tx))));
      const vB = await e.audit.verifyCompanyChain(e.manager);
      const forksB = await forks();

      // A (plain manager) on top of the clean chain: wipe nothing — continue the chain and look for NEW forks
      await Promise.all(Array.from({ length: 60 }, (_, i) => e.audit.record(input(100 + i), wide.manager)));
      const vA = await e.audit.verifyCompanyChain(e.manager);
      const forksA = (await forks()) - forksB;

      record(e, 'F-AUD-002.json', { styleB_transactionManager: { valid: vB.valid, brokenAtSeq: vB.brokenAtSeq, forks: forksB }, styleA_plainManager: { valid: vA.valid, brokenAtSeq: vA.brokenAtSeq, newForks: forksA }, runId: randomUUID().slice(0, 8) });
      result(e, 'F-AUD-002-B-transaction-manager', vB.valid && forksB === 0 ? 'PASS' : 'FAIL-DEFECT', JSON.stringify({ valid: vB.valid, forks: forksB }));
      result(e, 'F-AUD-002-A-plain-manager', vA.valid && forksA === 0 ? 'PASS' : 'FAIL-DEFECT', JSON.stringify({ valid: vA.valid, brokenAtSeq: vA.brokenAtSeq, newForks: forksA }));
      await finishBiz(e);
    } catch (err) {
      failure = err;
      throw err;
    }
  });
});
