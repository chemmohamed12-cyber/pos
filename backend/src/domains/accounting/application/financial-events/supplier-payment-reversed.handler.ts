import { FinancialEvent } from '../../infrastructure/financial-event.entity';
import { HandlerContext, HandlerResult } from './handler-registry';
import { readPaymentAllocations } from './supplier-payment-allocations';

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : typeof v === 'number' ? String(v) : null;
}

function amt(v: unknown): string | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n.toFixed(2) : null;
}

/**
 * `finance.supplier_payment.reversed` -> Dr Bank/Cash / Cr AP — the exact mirror of `finance.supplier_payment.recorded` (T2-S, 2026-10-21). Published ONLY by the owning
 * business document (`SupplierPaymentReversalService`), never by a raw Treasury reversal. The bank leg is the paying Treasury account's OWN mapped GL account
 * (publisher-resolved `glAccountCode`), by code only — never a fallback to a control account.
 */
export async function handleSupplierPaymentReversed(event: FinancialEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const p = event.payload;
  const amount = amt(p.amount);
  if (!amount) return { kind: 'rejected', reason: 'supplier_payment.reversed: missing/invalid amount' };
  const apCode = str(p.apAccountCode);
  const apByCode = apCode ? await ctx.findAccountByCode(apCode) : null;
  const ap = apByCode ?? (await ctx.resolveControlAccount('ap'));
  const bankCode = str(p.glAccountCode) ?? str(p.bankAccountCode) ?? str(p.accountCode);
  const bank = bankCode ? await ctx.findAccountByCode(bankCode) : null;
  if (!ap) return { kind: 'rejected', reason: 'supplier_payment.reversed: no AP control account in the chart' };
  if (!bank) return { kind: 'rejected', reason: 'supplier_payment.reversed: the paying Treasury account is not GL-mapped to an active chart account' };
  // WP-A: the exact mirror of the recorded entry, line by line (the payload carries what was STAMPED at payment time); v1 stays one unit-less pair.
  const alloc = readPaymentAllocations(p, amount);
  if (alloc && !alloc.ok) return { kind: 'rejected', reason: `supplier_payment.reversed: ${alloc.reason}` };
  const apLines = alloc?.ok ? alloc.groups.map((g) => ({ accountId: ap, credit: g.amount, orgUnitId: g.orgUnitId, description: 'Accounts payable' })) : [{ accountId: ap, credit: amount, description: 'Accounts payable' }];
  const bankLine = alloc?.ok ? { accountId: bank, debit: amount, orgUnitId: str(p.bankOrgUnitId), description: 'Cash / bank' } : { accountId: bank, debit: amount, description: 'Cash / bank' };
  return {
    kind: 'draft',
    draft: {
      businessDate: event.businessDate,
      description: `Supplier payment ${str(p.paymentNumber) ?? event.sourceEntityId} reversed (${str(p.reversalNumber) ?? 'reversal'})`,
      transactionCurrencyCode: event.transactionCurrencyCode,
      orgUnitId: event.orgUnitId,
      lines: [bankLine, ...apLines],
    },
  };
}
