import { FinancialEvent } from '../../infrastructure/financial-event.entity';
import { HandlerContext, HandlerResult, JournalDraftLine } from './handler-registry';

/**
 * ADR-054/ADR-057 — `procurement.goods_receipt.posted` → `Dr Inventory /
 * Cr GRNI`. The first leg of the GRNI lifecycle (`PO → GR → GRNI →
 * Supplier Invoice → AP`, ADR-054). One event per `GoodsReceipt`, Σ over
 * its own lines' `quantityReceived × unitCostBase` — exactly the figure
 * `GoodsReceiptService.post` already persists per line, no new arithmetic.
 * Mirrors `handleSupplierInvoicePosted`'s account-resolution shape exactly
 * (`resolveControlAccount`, never `resolveConfiguredPostableAccount` —
 * ADR-057 §2: GRNI is a control account, identical in kind to `ap`, and
 * must resolve through the SAME mechanism `GrniReconciliationService`
 * already reconciles against, or the two would permanently desync).
 */
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : typeof v === 'number' ? String(v) : null;
}
function amt(v: unknown): string | null {
  const s = str(v);
  return s && /^\d+(\.\d+)?$/.test(s) && Number(s) > 0 ? s : null;
}

async function resolveAccount(
  ctx: HandlerContext,
  codeHint: unknown,
  controlFn: Parameters<HandlerContext['resolveControlAccount']>[0],
): Promise<string | null> {
  const code = str(codeHint);
  if (code) {
    const byCode = await ctx.findAccountByCode(code);
    if (byCode) return byCode;
  }
  return ctx.resolveControlAccount(controlFn);
}

/** `procurement.goods_receipt.posted` → Dr Inventory / Cr GRNI. */
export async function handleGoodsReceiptPosted(event: FinancialEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const p = event.payload;
  const total = amt(p.totalValueBase);
  if (!total) return { kind: 'rejected', reason: 'goods_receipt.posted: missing/invalid totalValueBase' };

  const inventoryAcc = await resolveAccount(ctx, p.inventoryAccountCode, 'inventory');
  const grni = await resolveAccount(ctx, p.grniAccountCode, 'grni');
  if (!inventoryAcc) return { kind: 'rejected', reason: 'goods_receipt.posted: no inventory control account in the chart' };
  if (!grni) return { kind: 'rejected', reason: 'goods_receipt.posted: no GRNI control account in the chart — assign controlFunction "grni" to an account first' };

  const lines: JournalDraftLine[] = [
    { accountId: inventoryAcc, debit: total, description: 'Inventory (goods received)' },
    { accountId: grni, credit: total, description: 'Goods Received Not Invoiced' },
  ];

  return {
    kind: 'draft',
    draft: {
      businessDate: event.businessDate,
      description: `Goods receipt ${str(p.grNumber) ?? event.sourceEntityId} posted`,
      transactionCurrencyCode: event.transactionCurrencyCode,
      orgUnitId: event.orgUnitId,
      lines,
    },
  };
}
