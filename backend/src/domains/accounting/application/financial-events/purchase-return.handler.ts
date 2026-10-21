import { FinancialEvent } from '../../infrastructure/financial-event.entity';
import { HandlerContext, HandlerResult, JournalDraftLine } from './handler-registry';

export const RETURN_COST_DIFFERENCE_CONFIG_KEY = 'accounting.purchase_return_cost_difference_account_code';
export const RETURN_CLEARING_CONFIG_KEY = 'accounting.purchase_return_clearing_account_code';

const num = (v: unknown) => {
  const n = typeof v === 'number' ? v : Number(typeof v === 'string' ? v : NaN);
  return Number.isFinite(n) ? n : NaN;
};
const r4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * `procurement.purchase_return.posted` - the PHYSICAL return of goods to the supplier (owner decisions D7 / E3 and the policy of 2026-10-21). The stock side (valuation issue + physical movement) was
 * already done atomically by the posting service; this handler is pure and rejects visibly when an account is missing. Accounts payable is NEVER touched here.
 *   UNINVOICED goods:  Dr GRNI (the receipt cost) / Cr Inventory (the book value that left) / the difference to the separately configured SUPPLIER RETURN COST DIFFERENCE account.
 *   INVOICED goods:    Dr the clearing account "supplier returns pending credit" / Cr Inventory, both at the book value - no difference yet; it is settled (and the difference booked) when a supplier credit note
 *                      posts (`finance.supplier_credit_note.return_settled`).
 * A mixed return carries both. The difference account is never the PPV account and never a stock-count difference.
 */
export async function handlePurchaseReturnPosted(event: FinancialEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const p = event.payload;
  const receipt = num(p.receiptValueBase);
  const exit = num(p.exitValueBase);
  const exitUninvoiced = num(p.exitUninvoicedBase);
  const clearing = Number.isNaN(num(p.clearingValueBase)) ? 0 : num(p.clearingValueBase);
  if (!Number.isFinite(receipt) || !Number.isFinite(exit) || !Number.isFinite(exitUninvoiced) || receipt < 0 || exit <= 0 || exitUninvoiced < 0 || clearing < 0 || Math.abs(exitUninvoiced + clearing - exit) > 0.00005) {
    return { kind: 'rejected', reason: 'purchase_return.posted: invalid receiptValueBase / exitUninvoicedBase / clearingValueBase / exitValueBase' };
  }
  const inventory = await ctx.resolveControlAccount('inventory');
  if (!inventory) return { kind: 'rejected', reason: 'purchase_return.posted: no `inventory` control account in the chart' };
  const lines: JournalDraftLine[] = [];
  if (receipt > 0) {
    const grni = await ctx.resolveControlAccount('grni');
    if (!grni) return { kind: 'rejected', reason: 'purchase_return.posted: no active postable GRNI control account in this Company chart' };
    lines.push({ accountId: grni, debit: receipt.toFixed(4), description: 'Goods Received Not Invoiced (returned to supplier, at the receipt cost)' });
  }
  if (clearing > 0) {
    const acc = await ctx.resolveConfiguredPostableAccount(RETURN_CLEARING_CONFIG_KEY);
    if (!acc.ok) return { kind: 'rejected', reason: `purchase_return.posted: the supplier returns pending credit account is ${acc.reason} — the finance owner must set ${RETURN_CLEARING_CONFIG_KEY} to a postable non-control GL account` };
    lines.push({ accountId: acc.id, debit: clearing.toFixed(4), description: 'Supplier returns pending credit (invoiced goods returned - Accounts payable is not reduced until the credit note)' });
  }
  lines.push({ accountId: inventory, credit: exit.toFixed(4), description: 'Inventory asset (returned stock at its book cost)' });

  const diff = r4(receipt - exitUninvoiced);
  if (Math.abs(diff) > 0.00005) {
    const acc = await ctx.resolveConfiguredPostableAccount(RETURN_COST_DIFFERENCE_CONFIG_KEY);
    if (!acc.ok) {
      return { kind: 'rejected', reason: `purchase_return.posted: the supplier return cost differences account is ${acc.reason} — the finance owner must set ${RETURN_COST_DIFFERENCE_CONFIG_KEY} to a postable non-control GL account` };
    }
    lines.push(
      diff > 0
        ? { accountId: acc.id, credit: diff.toFixed(4), description: 'Supplier return cost difference (stock left below the receipt cost)' }
        : { accountId: acc.id, debit: Math.abs(diff).toFixed(4), description: 'Supplier return cost difference (stock left above the receipt cost)' },
    );
  }
  const dr = lines.reduce((s, l) => s + Number(l.debit ?? 0), 0);
  const cr = lines.reduce((s, l) => s + Number(l.credit ?? 0), 0);
  if (Math.abs(dr - cr) > 0.00005) return { kind: 'rejected', reason: `purchase_return.posted: unbalanced draft (Dr ${dr.toFixed(4)} ≠ Cr ${cr.toFixed(4)})` };

  return {
    kind: 'draft',
    draft: {
      businessDate: event.businessDate,
      description: `Purchase return ${typeof p.returnNumber === 'string' ? p.returnNumber : event.sourceEntityId} posted`,
      transactionCurrencyCode: event.transactionCurrencyCode,
      orgUnitId: event.orgUnitId,
      lines,
    },
  };
}

/**
 * `finance.supplier_credit_note.return_settled` - the FINANCIAL side of a physical return of invoiced goods: a posted supplier credit note that links returned lines settles them.
 *   Dr Accounts payable (the credited net) / Cr the clearing account (the book value parked by the return) / the difference (credited net - book value) to the separate cost-difference account
 *   (Cr when the supplier credits more than the book value, Dr when less). The Input VAT of the note is its own event; the E1 cost leg covers any lines that are not linked to a return.
 */
export async function handleSupplierCreditNoteReturnSettled(event: FinancialEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const p = event.payload;
  const net = num(p.settledNetAmount);
  const clearing = num(p.clearingValueBase);
  if (!Number.isFinite(net) || !Number.isFinite(clearing) || net <= 0 || clearing <= 0) return { kind: 'rejected', reason: 'supplier_credit_note.return_settled: invalid settledNetAmount / clearingValueBase' };
  const ap = await ctx.resolveControlAccount('ap');
  if (!ap) return { kind: 'rejected', reason: 'supplier_credit_note.return_settled: no AP control account in the chart' };
  const acc = await ctx.resolveConfiguredPostableAccount(RETURN_CLEARING_CONFIG_KEY);
  if (!acc.ok) return { kind: 'rejected', reason: `supplier_credit_note.return_settled: the supplier returns pending credit account is ${acc.reason} — set ${RETURN_CLEARING_CONFIG_KEY}` };

  const lines: JournalDraftLine[] = [
    { accountId: ap, debit: net.toFixed(4), description: 'Accounts payable (credit note settling returned goods)' },
    { accountId: acc.id, credit: clearing.toFixed(4), description: 'Supplier returns pending credit (settled)' },
  ];
  const diff = r4(net - clearing);
  if (Math.abs(diff) > 0.00005) {
    const d = await ctx.resolveConfiguredPostableAccount(RETURN_COST_DIFFERENCE_CONFIG_KEY);
    if (!d.ok) return { kind: 'rejected', reason: `supplier_credit_note.return_settled: the supplier return cost differences account is ${d.reason} — set ${RETURN_COST_DIFFERENCE_CONFIG_KEY}` };
    lines.push(
      diff > 0
        ? { accountId: d.id, credit: diff.toFixed(4), description: 'Supplier return cost difference (credited above the book value)' }
        : { accountId: d.id, debit: Math.abs(diff).toFixed(4), description: 'Supplier return cost difference (credited below the book value)' },
    );
  }
  const dr = lines.reduce((s, l) => s + Number(l.debit ?? 0), 0);
  const cr = lines.reduce((s, l) => s + Number(l.credit ?? 0), 0);
  if (Math.abs(dr - cr) > 0.00005) return { kind: 'rejected', reason: `supplier_credit_note.return_settled: unbalanced draft (Dr ${dr.toFixed(4)} ≠ Cr ${cr.toFixed(4)})` };
  return {
    kind: 'draft',
    draft: {
      businessDate: event.businessDate,
      description: `Supplier credit note ${typeof p.invoiceNumber === 'string' ? p.invoiceNumber : event.sourceEntityId} - settles returned goods`,
      transactionCurrencyCode: event.transactionCurrencyCode,
      orgUnitId: event.orgUnitId,
      lines,
    },
  };
}
