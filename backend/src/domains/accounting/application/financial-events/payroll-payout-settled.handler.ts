import Decimal from 'decimal.js';
import { FinancialEvent } from '../../infrastructure/financial-event.entity';
import { HandlerContext, HandlerResult } from './handler-registry';

/**
 * ADR-070 Addendum A-7 — the ledger effect of ONE payroll payment: `Dr Wages Payable / Cr <the paying Treasury account's mapped GL account>`, on the amount
 * actually paid. Same pattern as `finance.supplier_payment.recorded` (publisher-resolved `glAccountCode`, by code only — never a fallback to the first bank
 * account). Published by `PayrollPayoutService` in the SAME transaction as the item update and the Treasury cash-out, so a payment never exists without it.
 * Payload: { payoutItemId, payoutBatchId, payoutBatchCode, payrollRunId, payrollRunCode, payrollRunLineId, employeeId, amount, treasuryAccountId, glAccountCode }.
 */
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

export async function handlePayrollPayoutSettled(event: FinancialEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const p = event.payload;
  const raw = str(p.amount) ?? (typeof p.amount === 'number' ? String(p.amount) : null);
  if (!raw || !/^\d+(\.\d+)?$/.test(raw) || new Decimal(raw).lte(0)) return { kind: 'rejected', reason: 'payroll payout settled: missing/invalid amount' };
  const amount = new Decimal(raw).toFixed(2);

  const wagesPayable = await ctx.resolveControlAccount('wages_payable');
  if (!wagesPayable) return { kind: 'rejected', reason: 'payroll payout settled: no Wages Payable control account in the chart' };

  const cashCode = str(p.glAccountCode);
  const cash = cashCode ? await ctx.findAccountByCode(cashCode) : null;
  if (!cash) return { kind: 'rejected', reason: 'payroll payout settled: the paying Treasury account is not GL-mapped to an active chart account' };

  return {
    kind: 'draft',
    draft: {
      businessDate: event.businessDate,
      description: `Payroll payout ${str(p.payoutBatchCode) ?? ''} — ${str(p.payrollRunCode) ?? str(p.payrollRunId) ?? ''}`.trim(),
      transactionCurrencyCode: event.transactionCurrencyCode,
      orgUnitId: event.orgUnitId,
      lines: [
        { accountId: wagesPayable, debit: amount, description: 'Wages Payable' },
        { accountId: cash, credit: amount, description: 'Cash / bank' },
      ],
    },
  };
}
