import { FinancialEvent } from '../../infrastructure/financial-event.entity';
import { HandlerContext, HandlerResult } from './handler-registry';

/**
 * ADR-061 (Manufacturing) — Financial Event handlers for the three
 * Work Order movement types (§13's accounting table). Every entry here
 * is an asset-to-asset reclassification (Inventory ⇄ WIP) — no P&L
 * account is ever touched, a direct, mechanical consequence of D1–D3
 * (actual costing only, no labor/overhead, no variance). `manufacturing`'s
 * own application service (`ManufacturingWorkOrderService`) computes
 * every dollar amount BEFORE publishing — these handlers only resolve
 * accounts and shape the draft, exactly like every other F03 handler.
 */

function amt(v: unknown): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v);
  return /^\d+(\.\d+)?$/.test(s) && Number(s) > 0 ? s : null;
}

/** `manufacturing.work_order.material_issued` → Dr WIP / Cr Inventory (ADR-061 §13). */
export async function handleWorkOrderMaterialIssued(event: FinancialEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const total = amt(event.payload.totalValueBase);
  if (!total) return { kind: 'rejected', reason: 'manufacturing.work_order.material_issued: missing/invalid totalValueBase' };

  const wip = await ctx.resolveControlAccount('wip');
  const inventory = await ctx.resolveControlAccount('inventory');
  if (!wip) return { kind: 'rejected', reason: 'manufacturing.work_order.material_issued: no active postable account has controlFunction "wip" — assign one first' };
  if (!inventory) return { kind: 'rejected', reason: 'manufacturing.work_order.material_issued: no active postable account has controlFunction "inventory"' };

  return {
    kind: 'draft',
    draft: {
      businessDate: event.businessDate,
      description: `Work Order material issue — ${String(event.payload.workOrderId ?? '')}`,
      transactionCurrencyCode: event.transactionCurrencyCode,
      orgUnitId: event.orgUnitId,
      lines: [
        { accountId: wip, debit: total, description: 'WIP (material issued)' },
        { accountId: inventory, credit: total, description: 'Inventory (material issued to Work Order)' },
      ],
    },
  };
}

/** `manufacturing.work_order.material_returned` → Dr Inventory / Cr WIP — exact reversal of the issue leg (ADR-061 §5/§13). */
export async function handleWorkOrderMaterialReturned(event: FinancialEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const total = amt(event.payload.totalValueBase);
  if (!total) return { kind: 'rejected', reason: 'manufacturing.work_order.material_returned: missing/invalid totalValueBase' };

  const wip = await ctx.resolveControlAccount('wip');
  const inventory = await ctx.resolveControlAccount('inventory');
  if (!wip) return { kind: 'rejected', reason: 'manufacturing.work_order.material_returned: no active postable account has controlFunction "wip"' };
  if (!inventory) return { kind: 'rejected', reason: 'manufacturing.work_order.material_returned: no active postable account has controlFunction "inventory"' };

  return {
    kind: 'draft',
    draft: {
      businessDate: event.businessDate,
      description: `Work Order material return — ${String(event.payload.workOrderId ?? '')}`,
      transactionCurrencyCode: event.transactionCurrencyCode,
      orgUnitId: event.orgUnitId,
      lines: [
        { accountId: inventory, debit: total, description: 'Inventory (material returned from Work Order)' },
        { accountId: wip, credit: total, description: 'WIP (material returned)' },
      ],
    },
  };
}

/**
 * `manufacturing.work_order.finished_goods_received` → Dr Finished Goods
 * Inventory / Cr WIP, at `valueOutput_i` — the ADR-061 §7-ratified,
 * Work-Order-pooled figure the application service already computed
 * (`WIP(WO).value_before ÷ remainingPlannedQty_before × outputQuantity`).
 * This handler performs no costing computation of its own — it only
 * posts the already-derived total.
 */
export async function handleWorkOrderFinishedGoodsReceived(event: FinancialEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const total = amt(event.payload.totalValueBase);
  if (!total) return { kind: 'rejected', reason: 'manufacturing.work_order.finished_goods_received: missing/invalid totalValueBase' };

  const inventory = await ctx.resolveControlAccount('inventory');
  const wip = await ctx.resolveControlAccount('wip');
  if (!inventory) return { kind: 'rejected', reason: 'manufacturing.work_order.finished_goods_received: no active postable account has controlFunction "inventory"' };
  if (!wip) return { kind: 'rejected', reason: 'manufacturing.work_order.finished_goods_received: no active postable account has controlFunction "wip"' };

  return {
    kind: 'draft',
    draft: {
      businessDate: event.businessDate,
      description: `Work Order finished goods output — ${String(event.payload.workOrderId ?? '')}`,
      transactionCurrencyCode: event.transactionCurrencyCode,
      orgUnitId: event.orgUnitId,
      lines: [
        { accountId: inventory, debit: total, description: 'Finished Goods Inventory (produced)' },
        { accountId: wip, credit: total, description: 'WIP (finished goods output)' },
      ],
    },
  };
}
