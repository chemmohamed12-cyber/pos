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
  if (!Number.isFinite(receipt) || !Number.isFinite(exit) || receipt < 0 || exit < 0 || receipt + exit <= 0) {
    return { kind: 'rejected', reason: 'purchase_return.posted: invalid receiptValueBase / exitValueBase' };
  }
  const grni = await ctx.resolveControlAccount('grni');
  const inventory = await ctx.resolveControlAccount('inventory');
  if (!grni) return { kind: 'rejected', reason: 'purchase_return.posted: no active postable GRNI control account in this Company chart' };
  if (!inventory) return { kind: 'rejected', reason: 'purchase_return.posted: no `inventory` control account in the chart' };

  const diff = r4(receipt - exit);
  const lines: JournalDraftLine[] = [
    { accountId: grni, debit: receipt.toFixed(4), description: 'Goods Received Not Invoiced (returned to supplier, at the receipt cost)' },
    { accountId: inventory, credit: exit.toFixed(4), description: 'Inventory asset (returned stock at its book cost)' },
  ];
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
