import { FinancialEvent } from '../../infrastructure/financial-event.entity';
import { HandlerContext, HandlerResult, JournalDraftLine } from './handler-registry';
import { InventoryAdjustmentKind } from '../../domain/inventory';
import { InventoryValuationContract } from '../../../../foundation/module-registry/contracts/inventory-events.contract';

/**
 * F07 — Inventory Accounting (ADR-040 D7/D12). The mirror of
 * `cash-bank-adjustment.handler.ts` / `ap-adjustment.handler.ts`.
 * `InventoryAdjustmentService` emits an internal `FinancialEvent`
 * (`sourceDomain = 'accounting'`, `eventType =
 * 'accounting.inventory.adjustment.approved'`) after FA-01 approves; this
 * **pure** handler maps it to a balanced 2-line journal draft that F03's
 * posting gate posts. **Zero change to `journal-entry.service.ts`, the
 * posting gate, or `LedgerService`.**
 *
 * **Not a valuation engine.** The `amount` here is exactly what the maker
 * typed and a checker approved — never derived from quantity × any price
 * (CTO Mandatory Condition 1). **No hard-coded account codes** — the
 * counter account is a maker-supplied code the service already validated
 * (postable, active, non-control); the handler only looks it up and
 * rejects on a miss.
 */
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : typeof v === 'number' ? String(v) : null;
}
function amt(v: unknown): string | null {
  const s = str(v);
  return s && /^\d+(\.\d+)?$/.test(s) && Number(s) > 0 ? s : null;
}

/** C6 - what the handler needs to ALSO move the valuation (absent = the pre-C6 GL-only behaviour, exactly). */
export interface InventoryAdjustmentHandlerDeps {
  valuation?: InventoryValuationContract;
}

export async function handleInventoryAdjustmentApproved(event: FinancialEvent, ctx: HandlerContext, deps?: InventoryAdjustmentHandlerDeps): Promise<HandlerResult> {
  const p = event.payload;
  const kind = str(p.kind) as InventoryAdjustmentKind | null;
  const amount = amt(p.amount);
  if (!kind) return { kind: 'rejected', reason: 'inventory adjustment: missing kind' };
  if (!amount) return { kind: 'rejected', reason: 'inventory adjustment: missing/invalid amount' };

  const inventoryAccount = await ctx.resolveControlAccount('inventory');
  if (!inventoryAccount) {
    return {
      kind: 'rejected',
      reason: 'inventory adjustment: no `inventory` control account in the chart — assign controlFunction "inventory" to an account first',
    };
  }
  const counterCode = str(p.counterAccountCode);
  if (!counterCode) return { kind: 'rejected', reason: `inventory ${kind}: a counterAccountCode is required` };
  const counter = await ctx.findAccountByCode(counterCode);
  if (!counter) return { kind: 'rejected', reason: `inventory ${kind}: counter account "${counterCode}" not found` };

  const direction = str(p.direction) === 'debit' ? 'debit' : 'credit';
  const lines: JournalDraftLine[] =
    direction === 'debit'
      ? [
          { accountId: inventoryAccount, debit: amount, description: 'Inventory asset' },
          { accountId: counter, credit: amount, description: 'Counter' },
        ]
      : [
          { accountId: counter, debit: amount, description: 'Counter' },
          { accountId: inventoryAccount, credit: amount, description: 'Inventory asset' },
        ];

  // C6 (ADR-INV-05 2.1): a value-only write-down / write-up that was submitted with a valuation effect moves the valuation of its (warehouse, product) position in the SAME transaction
  // as the journal (the handler-through-posting span is one transaction: a rejected posting rolls the revaluation back). Every account above resolved BEFORE this mutation.
  if (p.valuationEffect === true || p.valuationEffect === 'true') {
    const productId = str(p.productId);
    const warehouseId = str(p.warehouseId);
    if (!productId || !warehouseId) return { kind: 'rejected', reason: `inventory ${kind}: a valuation-affecting adjustment needs productId and warehouseId` };
    if (!deps?.valuation?.applyRevaluation) return { kind: 'rejected', reason: `inventory ${kind}: the valuation engine is not available - the adjustment cannot move the valuation` };
    const revalued = await deps.valuation.applyRevaluation(productId, warehouseId, direction === 'debit' ? amount : `-${amount}`, event.idempotencyKey, ctx.manager, event.businessDate);
    if ('rejected' in revalued) return { kind: 'rejected', reason: `inventory ${kind}: valuation not changed (${revalued.rejected})` };
  }

  return {
    kind: 'draft',
    draft: {
      businessDate: event.businessDate,
      description: `Inventory ${kind.replace(/_/g, ' ')} — ${str(p.reason) ?? event.sourceEntityId}`,
      transactionCurrencyCode: event.transactionCurrencyCode,
      orgUnitId: event.orgUnitId,
      lines,
    },
  };
}
