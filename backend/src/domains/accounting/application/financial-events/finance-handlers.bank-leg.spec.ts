import { FinancialEvent } from '../../infrastructure/financial-event.entity';
import { HandlerContext } from './handler-registry';
import { handleCashRecorded, handlePaymentRecorded } from './finance-handlers';
import { handleSupplierPaymentRecorded } from './supplier-invoice.handler';

/**
 * D2 (2026-10-04) — handler-level guarantee: the bank leg of a cash event is resolved BY THE PUBLISHED
 * `glAccountCode` ONLY. A control-account lookup for `bank` must never happen (that fallback used to post every
 * payment to the first `bank` control account). The real-PG A/B proof is `treasury-bank-leg.company-isolation.spec.ts`.
 */
describe('finance handlers — D2 bank leg is the Treasury account\'s mapped GL account, no control-account fallback', () => {
  const accounts: Record<string, string> = { '1102': 'acc-1102', '2101': 'acc-ap', '1110': 'acc-ar', 'CLEAR': 'acc-clearing' };

  function makeCtx() {
    const resolveControlAccount = jest.fn(async (fn: string) => ({ bank: 'acc-FIRST-BANK-CONTROL', ap: 'acc-ap', ar: 'acc-ar' } as Record<string, string>)[fn] ?? null);
    const ctx = {
      manager: {} as never,
      baseCurrencyCode: 'EGP',
      resolveControlAccount,
      findAccountByCode: jest.fn(async (code: string) => accounts[code] ?? null),
      resolveConfiguredPostableAccount: jest.fn(async () => ({ ok: true as const, id: 'acc-clearing' })),
      resolveDimension: jest.fn(async () => null),
    } as unknown as HandlerContext;
    return { ctx, resolveControlAccount };
  }

  const event = (payload: Record<string, unknown>) =>
    ({ businessDate: '2026-10-04', transactionCurrencyCode: 'EGP', orgUnitId: null, sourceEntityId: 'src-1', payload }) as unknown as FinancialEvent;

  describe.each([
    ['supplier payment', handleSupplierPaymentRecorded, { amount: '50.00', paymentNumber: 'SP-1' }],
    ['customer payment', handlePaymentRecorded, { amount: '50.00', paymentNumber: 'PAY-1' }],
  ] as const)('%s', (_label, handler, base) => {
    it('uses the published glAccountCode for the bank leg and NEVER asks for the bank control account', async () => {
      const { ctx, resolveControlAccount } = makeCtx();
      const result = await handler(event({ ...base, glAccountCode: '1102' }), ctx);
      expect(result.kind).toBe('draft');
      if (result.kind === 'draft') expect(result.draft.lines.map((l) => l.accountId)).toContain('acc-1102');
      expect(resolveControlAccount).not.toHaveBeenCalledWith('bank');
    });

    it('rejects when no glAccountCode was published — even though a bank control account exists', async () => {
      const { ctx, resolveControlAccount } = makeCtx();
      const result = await handler(event({ ...base }), ctx);
      expect(result.kind).toBe('rejected');
      expect(resolveControlAccount).not.toHaveBeenCalledWith('bank');
    });

    it('rejects when the published code is not in the chart — no fallback to another bank account', async () => {
      const { ctx, resolveControlAccount } = makeCtx();
      const result = await handler(event({ ...base, glAccountCode: '9999' }), ctx);
      expect(result.kind).toBe('rejected');
      if (result.kind === 'rejected') expect(result.reason).toMatch(/not GL-mapped to an active chart account/);
      expect(resolveControlAccount).not.toHaveBeenCalledWith('bank');
    });
  });

  describe('direct treasury cash (treasury.cash.recorded)', () => {
    it('uses the account\'s mapped code; rejects (no control-account fallback) when it is absent or unknown', async () => {
      const ok = makeCtx();
      const good = await handleCashRecorded(event({ amount: '10.00', direction: 'in', accountCode: '1102', counterAccountCode: 'CLEAR' }), ok.ctx);
      expect(good.kind).toBe('draft');
      expect(ok.resolveControlAccount).not.toHaveBeenCalledWith('bank');

      const missing = makeCtx();
      expect((await handleCashRecorded(event({ amount: '10.00', direction: 'in', counterAccountCode: 'CLEAR' }), missing.ctx)).kind).toBe('rejected');
      expect(missing.resolveControlAccount).not.toHaveBeenCalledWith('bank');

      const unknown = makeCtx();
      expect((await handleCashRecorded(event({ amount: '10.00', direction: 'out', accountCode: '9999', counterAccountCode: 'CLEAR' }), unknown.ctx)).kind).toBe('rejected');
      expect(unknown.resolveControlAccount).not.toHaveBeenCalledWith('bank');
    });
  });
});
