import { BizEnv, abortBiz, attempt, finishBiz, record, result, setUpBiz, tally, widePool } from './biz-support';
import { TreasuryService } from '../../domains/treasury/application/treasury.service';
import { AuditService } from '../audit/audit.service';
import { NumberingService } from '../numbering/numbering.service';
import { EventBusService } from '../events/event-bus.service';

/**
 * F-TRS-001 REPRODUCER (informational — OUTSIDE the frozen T-xx set; it never changes a frozen verdict).
 * Question: does TreasuryService keep a treasury account from being overdrawn by concurrent withdrawals when it is called with a plain
 * (non-transactional) EntityManager — which is how TreasuryController calls it (`req.companyContext.dataSource.manager`) — versus a transaction manager?
 *   A) plain manager (as the controller does)         -> overdraft occurrences over 15 rounds of 10 x 30.00 from 100.00
 *   B) wrapped in manager.transaction(tx => ...)      -> overdraft occurrences over 15 rounds
 * Disposable databases `daii_test_biz_t14_*` only. Uses the non-emitting cashOut (no accounting involved) so the balance logic is isolated.
 */
describe('F-TRS-001 reproducer — concurrent withdrawals, plain manager vs transaction manager', () => {
  jest.setTimeout(900_000);
  let env: (BizEnv & { warehouseId: string }) | undefined;
  let failure: unknown;
  afterAll(async () => {
    if (env) await abortBiz(env, failure);
  });

  it('records overdraft occurrences for both calling styles', async () => {
    try {
      env = await setUpBiz('T-14', 'biz_t14');
      const e = env;
      const wide = await widePool(e, 40);
      const inert = {} as never;
      const audit = new AuditService(e.h.controlPlane);
      const treasury = new TreasuryService(e.h.controlPlane, new NumberingService(e.h.controlPlane), audit, inert, new EventBusService(inert, e.h.connections));
      const type = (await treasury.listAccountTypes(e.manager)).find((t) => t.code === 'bank')!;
      const rounds = 15;
      const stats: Record<'plain' | 'transaction', { overdrafts: number; okCounts: number[]; balances: string[] }> = { plain: { overdrafts: 0, okCounts: [], balances: [] }, transaction: { overdrafts: 0, okCounts: [], balances: [] } };
      for (const style of ['plain', 'transaction'] as const) {
        for (let r = 1; r <= rounds; r += 1) {
          const acct = await treasury.createAccount(`F-TRS-${style}-${r}`, `F-TRS ${style} ${r}`, type.id, e.actor, e.manager);
          await treasury.cashIn(acct.id, '100.00', null, null, null, 'funding', e.actor, e.manager);
          const outs = await Promise.all(Array.from({ length: 10 }, (_, i) => attempt(() =>
            style === 'plain'
              ? treasury.cashOut(acct.id, '30.00', null, null, `r${r}-${i}`, 'F-TRS', e.actor, wide.manager)
              : wide.manager.transaction((tx) => treasury.cashOut(acct.id, '30.00', null, null, `r${r}-${i}`, 'F-TRS', e.actor, tx)))));
          const bal = await treasury.getAccountBalance(acct.id, e.manager);
          stats[style].okCounts.push(outs.filter((o) => o.ok).length);
          stats[style].balances.push(bal);
          if (Number(bal) < 0) stats[style].overdrafts += 1;
          void tally;
        }
      }
      record(e, 'F-TRS-001.json', { rounds, stats });
      result(e, 'F-TRS-001-B-transaction-manager', stats.transaction.overdrafts === 0 && stats.transaction.okCounts.every((n) => n === 3) ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(stats.transaction));
      result(e, 'F-TRS-001-A-plain-manager', stats.plain.overdrafts === 0 && stats.plain.okCounts.every((n) => n === 3) ? 'PASS' : 'FAIL-DEFECT', JSON.stringify({ overdraftRounds: stats.plain.overdrafts, okCounts: stats.plain.okCounts, balances: stats.plain.balances }));
      await finishBiz(e);
    } catch (err) {
      failure = err;
      throw err;
    }
  });
});
