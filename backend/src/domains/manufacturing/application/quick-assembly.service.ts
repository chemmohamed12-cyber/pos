import { BadRequestException, Inject, Injectable, Optional } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { INVENTORY_VALUATION_CONTRACT, InventoryValuationContract } from '../../../foundation/module-registry/contracts/inventory-events.contract';
import { SALES_BOM_CONTRACT, SalesBomContract } from '../../../foundation/module-registry/contracts/sales.contract';
import { WorkOrderService } from './work-order.service';

export interface QuickAssemblyPreviewComponent {
  productId: string;
  sku: string;
  name: string;
  unit: string | null;
  perUnit: number;
  required: number;
  available: number;
  shortage: number;
  status: 'ok' | 'short';
}

export interface QuickAssemblyBlocker {
  code: 'invalid_quantity' | 'product_not_found' | 'no_active_bom' | 'warehouse_not_found' | 'warehouse_not_usable' | 'shortage';
  message: string;
}

/** Informational only - NOT a reservation or a guarantee: the confirm step revalidates everything atomically. */
export interface QuickAssemblyPreview {
  canAssemble: boolean;
  quantity: number;
  product: { id: string; sku: string; name: string; unit: string | null } | null;
  warehouse: { id: string; code: string; name: string } | null;
  components: QuickAssemblyPreviewComponent[];
  blockers: QuickAssemblyBlocker[];
  /** Material cost at the CURRENT moving-average cost of each component, or null when any component has no reliable cost yet. An estimate, never a posted value. */
  estimatedCostBase: string | null;
}

export interface QuickAssemblyResult {
  workOrderId: string;
  workOrderNumber: string;
  state: string;
  product: { sku: string; name: string; unit: string | null };
  warehouse: { code: string; name: string };
  plannedQuantity: number;
  producedQuantity: number;
  components: Array<{ productId: string; sku: string; name: string; unit: string | null; required: number; consumed: number }>;
  /** From the posted financial events of this order (authoritative), null while none is posted. */
  materialValueBase: string | null;
  outputValueBase: string | null;
  unitCostBase: string | null;
  events: Array<{ eventType: string; status: string; rejectionReason: string | null }>;
  warnings: string[];
}

/**
 * Manufacturing Engine S6 (decision D-ME-5) - quick assembly is NOT a second engine. One call creates, releases, issues every component, receives the output and completes a
 * real Work Order, all in ONE transaction: the production floor gets the instant "assemble N" gesture, while the books, the stock, the cost pool and the audit trail are exactly
 * those of a Work Order (an order number, an events trail, WIP that returns to zero). Any failure rolls the whole thing back - nothing half-assembled is left behind.
 *
 * UX redesign stage 2 (D8): `preview` is the READ-ONLY, informational step in front of it - requirements, availability and shortages for the same warehouse the assembly will draw
 * from, behind the same permission as the assembly itself, exposing only the BOM components' availability. It reserves nothing; `quickAssemble` independently revalidates.
 */
@Injectable()
export class QuickAssemblyService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly workOrders: WorkOrderService,
    @Optional() @Inject(SALES_BOM_CONTRACT) private readonly bom?: SalesBomContract,
    @Optional() @Inject(INVENTORY_VALUATION_CONTRACT) private readonly valuation?: InventoryValuationContract,
    @Optional() private readonly events?: EventBusService,
  ) {}

  async quickAssemble(warehouseId: string, finishedProductId: string, quantity: number, actorUserId: string | null, manager?: EntityManager): Promise<{ workOrderId: string; workOrderNumber: string }> {
    const result = await (manager ?? this.dataSource).transaction(async (tx) => {
      const order = await this.workOrders.createWorkOrder(finishedProductId, quantity, warehouseId, actorUserId, tx);
      await this.workOrders.release(order.id, actorUserId, tx);
      for (const c of await this.workOrders.getWorkOrderComponents(order.id, tx)) {
        await this.workOrders.materialIssue(order.id, c.componentProductId, c.quantityRequired, actorUserId, `qa-${order.id}-${c.componentProductId}`, tx);
      }
      await this.workOrders.finishedGoodsOutput(order.id, quantity, actorUserId, `qa-out-${order.id}`, tx);
      await this.workOrders.complete(order.id, actorUserId, tx);
      return { workOrderId: order.id, workOrderNumber: order.workOrderNumber };
    });
    return result;
  }

  async preview(finishedProductId: string, warehouseId: string, quantity: number, manager?: EntityManager): Promise<QuickAssemblyPreview> {
    if (!this.bom) throw new BadRequestException('Quick assembly preview is not available in this installation.');
    const m = manager ?? this.dataSource.manager;
    const blockers: QuickAssemblyBlocker[] = [];
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty < 1) blockers.push({ code: 'invalid_quantity', message: 'The quantity must be a positive whole number.' });

    const product = (await m.query(`SELECT "id","sku","name","unit" FROM "products" WHERE "id" = $1`, [finishedProductId]))[0] as { id: string; sku: string; name: string; unit: string | null } | undefined;
    if (!product) blockers.push({ code: 'product_not_found', message: 'The product was not found.' });
    const warehouse = (await m.query(`SELECT "id","code","name","kind" FROM "warehouses" WHERE "id" = $1`, [warehouseId]))[0] as { id: string; code: string; name: string; kind: string } | undefined;
    if (!warehouse) blockers.push({ code: 'warehouse_not_found', message: 'The warehouse was not found.' });
    else if (warehouse.kind === 'operational') blockers.push({ code: 'warehouse_not_usable', message: 'A work-in-process location cannot be used as the assembly warehouse.' });

    const recipe = product ? await this.bom.getBomForAssembly(finishedProductId, m) : null;
    if (product && (!recipe || recipe.length === 0)) blockers.push({ code: 'no_active_bom', message: 'This product has no active Bill of Materials.' });

    const components: QuickAssemblyPreviewComponent[] = [];
    let cost = 0;
    let costKnown = true;
    if (recipe && recipe.length > 0 && warehouse && Number.isInteger(qty) && qty >= 1) {
      const meta = new Map<string, { sku: string; name: string; unit: string | null }>(
        ((await m.query(`SELECT "id","sku","name","unit" FROM "products" WHERE "id" = ANY($1)`, [recipe.map((r) => r.componentProductId)])) as Array<{ id: string; sku: string; name: string; unit: string | null }>).map((p) => [p.id, p]),
      );
      for (const line of recipe) {
        const onHand = Number((await m.query(`SELECT COALESCE(SUM("quantity"),0) AS n FROM "stock_movements" WHERE "warehouseId" = $1 AND "productId" = $2`, [warehouse.id, line.componentProductId]))[0].n);
        const reserved = Number((await m.query(`SELECT COALESCE(SUM("quantity"),0) AS n FROM "stock_reservations" WHERE "warehouseId" = $1 AND "productId" = $2 AND "status" IN ('active','preliminary')`, [warehouse.id, line.componentProductId]))[0].n);
        const required = line.quantityPerUnit * qty;
        const available = onHand - reserved;
        const shortage = Math.max(0, required - available);
        const p = meta.get(line.componentProductId);
        components.push({ productId: line.componentProductId, sku: p?.sku ?? '', name: p?.name ?? '', unit: p?.unit ?? null, perUnit: line.quantityPerUnit, required, available, shortage, status: shortage > 0 ? 'short' : 'ok' });
        const unitCost = this.valuation ? await this.valuation.getUnitCost(line.componentProductId, warehouse.id, undefined, m) : null;
        if (unitCost?.unitCostBase == null) costKnown = false;
        else cost += Number(unitCost.unitCostBase) * required;
      }
      if (components.some((c) => c.status === 'short')) blockers.push({ code: 'shortage', message: `Insufficient available stock: ${components.filter((c) => c.status === 'short').map((c) => `${c.sku} (short ${c.shortage})`).join(', ')}.` });
    }
    return {
      canAssemble: blockers.length === 0,
      quantity: Number.isInteger(qty) ? qty : 0,
      product: product ?? null,
      warehouse: warehouse ? { id: warehouse.id, code: warehouse.code, name: warehouse.name } : null,
      components,
      blockers,
      estimatedCostBase: components.length > 0 && costKnown ? cost.toFixed(4) : null,
    };
  }

  /** Dispatches the events the assembly published (best effort, post-commit) and describes the order from its AUTHORITATIVE records. */
  async finish(base: { workOrderId: string; workOrderNumber: string }, manager?: EntityManager): Promise<QuickAssemblyResult> {
    const m = manager ?? this.dataSource.manager;
    if (this.events) await this.events.dispatchAfterCommit(m);
    const wo = await this.workOrders.getWorkOrderOrThrow(base.workOrderId, m);
    const state = await this.workOrders.getWorkOrderState(base.workOrderId, m);
    const comps = await this.workOrders.getWorkOrderComponents(base.workOrderId, m);
    const prodIds = [wo.finishedProductId, ...comps.map((c) => c.componentProductId)];
    const meta = new Map<string, { sku: string; name: string; unit: string | null }>(
      ((await m.query(`SELECT "id","sku","name","unit" FROM "products" WHERE "id" = ANY($1)`, [prodIds])) as Array<{ id: string; sku: string; name: string; unit: string | null }>).map((p) => [p.id, p]),
    );
    const wh = (await m.query(`SELECT "code","name" FROM "warehouses" WHERE "id" = $1`, [wo.warehouseId]))[0] as { code: string; name: string };
    const trail = await this.workOrders.getFinancialTrail(base.workOrderId, m);
    const sumDebit = (type: string) => {
      const evs = trail.filter((e) => e.eventType === type && e.status === 'POSTED');
      return evs.length === 0 ? null : evs.reduce((s, e) => s + e.lines.reduce((x, l) => x + Number(l.debitBase), 0), 0);
    };
    const issued = sumDebit('manufacturing.work_order.material_issued');
    const output = sumDebit('manufacturing.work_order.finished_goods_received');
    const warnings: string[] = [];
    for (const e of trail) if (e.status !== 'POSTED') warnings.push(`${e.eventType}: ${e.status}${e.rejectionReason ? ` - ${e.rejectionReason}` : ''}`);
    const fp = meta.get(wo.finishedProductId);
    return {
      workOrderId: wo.id,
      workOrderNumber: wo.workOrderNumber,
      state,
      product: { sku: fp?.sku ?? '', name: fp?.name ?? '', unit: fp?.unit ?? null },
      warehouse: wh,
      plannedQuantity: wo.quantityPlanned,
      producedQuantity: wo.quantityProduced,
      components: comps.map((c) => ({ productId: c.componentProductId, sku: meta.get(c.componentProductId)?.sku ?? '', name: meta.get(c.componentProductId)?.name ?? '', unit: meta.get(c.componentProductId)?.unit ?? null, required: c.quantityRequired, consumed: c.quantityIssued })),
      materialValueBase: issued == null ? null : issued.toFixed(4),
      outputValueBase: output == null ? null : output.toFixed(4),
      unitCostBase: output != null && wo.quantityProduced > 0 ? (output / wo.quantityProduced).toFixed(4) : null,
      events: trail.map((e) => ({ eventType: e.eventType, status: e.status, rejectionReason: e.rejectionReason })),
      warnings,
    };
  }
}
