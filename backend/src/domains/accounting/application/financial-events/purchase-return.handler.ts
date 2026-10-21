import { FinancialEvent } from '../../infrastructure/financial-event.entity';
import { HandlerContext, HandlerResult, JournalDraftLine } from './handler-registry';

export const RETURN_COST_DIFFERENCE_CONFIG_KEY = 'accounting.purchase_return_cost_difference_account_code';

const num = (v: unknown) => {
  const n = typeof v === 'number' ? v : Number(typeof v === 'string' ? v : NaN);
  return Number.isFinite(n) ? n : NaN;
};
const r4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * Phase D-1 (owner decisions D7 / E3, 2026-10-20) - `procurement.purchase_return.posted`: goods received but NOT yet invoiced go back to the supplier.
 *   Dr GRNI (the receipt's own cost - what the receipt credited)  /  Cr Inventory (the book value that actually left, moving average at posting time)
 *   and the difference to the separately configured SUPPLIER RETURN COST DIFFERENCE account (Cr when the stock left below the receipt cost, Dr when above) - never the PPV account and never a stock-count
 *   difference. The stock side (valuation issue + physical movement) was already done atomically by the posting service; this handler is pure and rejects visibly when an account is missing.
 */
export async function handlePurchaseReturnPosted(event: FinancialEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const p = event.payload;
  const receipt = num(p.receiptValueBase);
  const exit = num(p.exitValueBase);
  // phase D-3 (payload v2): goods that were already INVOICED are credited through Accounts payable (net + VAT), not GRNI
  const creditNet = Number.isNaN(num(p.creditNetBase)) ? 0 : num(p.creditNetBase);
  const creditTax = Number.isNaN(num(p.creditTaxBase)) ? 0 : num(p.creditTaxBase);
  if (!Number.isFinite(receipt) || !Number.isFinite(exit) || receipt < 0 || exit < 0 || creditNet < 0 || creditTax < 0 || receipt + creditNet <= 0 || exit <= 0) {
    return { kind: 'rejected', reason: 'purchase_return.posted: invalid receiptValueBase / creditNetBase / exitValueBase' };
  }
  const inventory = await ctx.resolveControlAccount('inventory');
  if (!inventory) return { kind: 'rejected', reason: 'purchase_return.posted: no `inventory` control account in the chart' };
  const lines: JournalDraftLine[] = [];
  if (receipt > 0) {
    const grni = await ctx.resolveControlAccount('grni');
    if (!grni) return { kind: 'rejected', reason: 'purchase_return.posted: no active postable GRNI control account in this Company chart' };
    lines.push({ accountId: grni, debit: receipt.toFixed(4), description: 'Goods Received Not Invoiced (returned to supplier, at the receipt cost)' });
  }
  if (creditNet > 0) {
    const ap = await ctx.resolveControlAccount('ap');
    if (!ap) return { kind: 'rejected', reason: 'purchase_return.posted: no AP control account in the chart' };
    lines.push({ accountId: ap, debit: (creditNet + creditTax).toFixed(4), description: 'Accounts payable (credit for invoiced goods returned: net + VAT)' });
    if (creditTax > 0) {
      const vat = await ctx.resolveUniqueControlAccount('tax_receivable');
      if (!vat.ok) return { kind: 'rejected', reason: `purchase_return.posted: Input VAT account (tax_receivable) is ${vat.reason} — exactly one active postable account must carry it` };
      lines.push({ accountId: vat.id, credit: creditTax.toFixed(4), description: 'Input VAT (credited back on returned invoiced goods)' });
    }
  }
  lines.push({ accountId: inventory, credit: exit.toFixed(4), description: 'Inventory asset (returned stock at its book cost)' });
  const diff = r4(receipt + creditNet - exit);
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
