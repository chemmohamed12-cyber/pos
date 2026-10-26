import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { GoodsReceipt } from '../infrastructure/goods-receipt.entity';
import { GoodsReceiptLine } from '../infrastructure/goods-receipt-line.entity';
import { PurchaseOrder } from '../infrastructure/purchase-order.entity';
import { PurchaseOrderLine } from '../infrastructure/purchase-order-line.entity';
import { PURCHASE_ORDER_PROCESS } from '../domain/purchase-order-process';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { InventoryService } from '../../inventory-warehouse/application/inventory.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { ProductLifecycleGate } from './product-lifecycle-gate.service';
import { AP_EVENT_TOPICS } from '../../../foundation/module-registry/contracts/ap-events.contract';
import { purchaseOrderBranchOf } from './procurement-org';

const GR_DOCUMENT_TYPE = 'goods_receipt';
const PO_ENTITY_TYPE = 'purchase_order';

export interface PostGoodsReceiptLineInput {
  purchaseOrderLineId: string;
  quantityReceived: string;
}
export interface PostGoodsReceiptInput {
  purchaseOrderId: string;
  notes?: string | null;
  lines: PostGoodsReceiptLineInput[];
}

/**
 * ADR-048 — Goods Receipt: the ONE controlled bridge from Procurement
 * into Inventory (CTO directive §11/§7 — "Procurement must not write
 * directly into warehouse tables. Use the existing inventory contract").
 * Every write here — the PO line's `quantityReceived` increment, the
 * `GoodsReceipt`/`GoodsReceiptLine` rows, the PO's derived state
 * transition, and every `InventoryService.recordMovement` call — commits
 * in ONE transaction (mirroring `DeliveryService.recordOutcome`'s own
 * atomic dispatch-movement pattern), or none of it does.
 *
 * 3-way-match guard (CTO directive §13, first half — quantity variance):
 * a receipt line can never push `quantityReceived` past the PO line's
 * own `quantity` — over-receipt is rejected outright here, not merely
 * flagged after the fact.
 */
@Injectable()
export class GoodsReceiptService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly processEngine: ProcessEngineService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    private readonly inventory: InventoryService,
    private readonly events: EventBusService,
    private readonly lifecycleGate: ProductLifecycleGate,
  ) {}

  /**
   * Goods received but not yet invoiced: every purchase order with a positive (received - invoiced) balance - the SAME columns the GRNI ledger and the 3-way-match guard use, never a second
   * calculation - with the goods receipts it received and the uninvoiced value. `visibleWarehouseIds` (F6) narrows it to the caller's warehouses. Read-only.
   */
  async listUninvoiced(
    manager?: EntityManager,
    visibleWarehouseIds?: string[],
  ): Promise<{
    totalReceipts: number;
    totalValue: string;
    orders: Array<{
      purchaseOrderId: string;
      poNumber: string;
      supplierId: string;
      supplierName: string | null;
      warehouseId: string;
      uninvoicedQuantity: string;
      uninvoicedValue: string;
      receipts: Array<{ id: string; grNumber: string; createdAt: string }>;
    }>;
  }> {
    const m = manager ?? this.dataSource;
    const scope = visibleWarehouseIds ? 'AND po."warehouseId" = ANY($1::uuid[])' : '';
    const orders = (await m.query(
      `SELECT po.id AS "purchaseOrderId", po."poNumber", po."supplierId", s."legalName" AS "supplierName", po."warehouseId",
              SUM(pol."quantityReceived" - pol."quantityReturned" - pol."quantityInvoiced")::numeric(20,3)::text AS "uninvoicedQuantity",
              SUM((pol."quantityReceived" - pol."quantityReturned" - pol."quantityInvoiced") * pol."unitCostBase")::numeric(20,4)::text AS "uninvoicedValue"
         FROM "purchase_order_lines" pol
         JOIN "purchase_orders" po ON po.id = pol."purchaseOrderId"
         LEFT JOIN "suppliers" s ON s.id = po."supplierId"
        WHERE (pol."quantityReceived" - pol."quantityReturned" - pol."quantityInvoiced") > 0 ${scope}
        GROUP BY po.id, po."poNumber", po."supplierId", s."legalName", po."warehouseId"
        ORDER BY po."poNumber"`,
      visibleWarehouseIds ? [visibleWarehouseIds] : [],
    )) as Array<{ purchaseOrderId: string; poNumber: string; supplierId: string; supplierName: string | null; warehouseId: string; uninvoicedQuantity: string; uninvoicedValue: string }>;
    const ids = orders.map((o) => o.purchaseOrderId);
    const receipts = ids.length
      ? ((await m.query(`SELECT id, "grNumber", "purchaseOrderId", "createdAt" FROM "goods_receipts" WHERE "purchaseOrderId" = ANY($1::uuid[]) ORDER BY "createdAt"`, [ids])) as Array<{ id: string; grNumber: string; purchaseOrderId: string; createdAt: Date }>)
      : [];
    const out = orders.map((o) => ({
      ...o,
      receipts: receipts.filter((r) => r.purchaseOrderId === o.purchaseOrderId).map((r) => ({ id: r.id, grNumber: r.grNumber, createdAt: new Date(r.createdAt).toISOString() })),
    }));
    const totalValue = orders.reduce((sum, o) => sum + Math.round(Number(o.uninvoicedValue) * 10000), 0) / 10000;
    return { totalReceipts: out.reduce((n, o) => n + o.receipts.length, 0), totalValue: totalValue.toFixed(4), orders: out };
  }

  async listForPurchaseOrder(purchaseOrderId: string, manager?: EntityManager): Promise<GoodsReceipt[]> {
    return (manager ?? this.dataSource).getRepository(GoodsReceipt).find({ where: { purchaseOrderId }, order: { createdAt: 'DESC' } });
  }

  async post(input: PostGoodsReceiptInput, actorUserId: string, manager?: EntityManager): Promise<GoodsReceipt> {
    if (input.lines.length === 0) throw new BadRequestException('A Goods Receipt needs at least one line.');

    const po = await (manager ?? this.dataSource).getRepository(PurchaseOrder).findOne({ where: { id: input.purchaseOrderId } });
    if (!po) throw new NotFoundException(`Purchase Order "${input.purchaseOrderId}" not found.`);
    const state = await this.processEngine.getState(PURCHASE_ORDER_PROCESS, PO_ENTITY_TYPE, po.id, manager);
    if (state !== 'approved' && state !== 'partially_received') {
      throw new ConflictException(`Purchase Order is "${state}" — a Goods Receipt can only be posted against an "approved" or "partially_received" order.`);
    }

    const poLines = await (manager ?? this.dataSource).getRepository(PurchaseOrderLine).find({ where: { purchaseOrderId: po.id } });
    const poLineById = new Map(poLines.map((l) => [l.id, l]));

    for (const line of input.lines) {
      const poLine = poLineById.get(line.purchaseOrderLineId);
      if (!poLine) throw new BadRequestException(`Purchase Order line "${line.purchaseOrderLineId}" does not belong to this order.`);
      const qty = Number(line.quantityReceived);
      if (!Number.isFinite(qty) || qty <= 0) throw new BadRequestException('Every receipt line quantity must be a positive number.');
      const remaining = Number(poLine.quantity) - Number(poLine.quantityReceived);
      if (qty > remaining) {
        throw new ConflictException(
          `Cannot receive ${qty} — only ${remaining} remains receivable on this line (ordered ${poLine.quantity}, already received ${poLine.quantityReceived}).`,
        );
      }
    }

    await this.lifecycleGate.assertNoneDraft(poLines.map((l) => l.productId), 'Cannot receive goods on this Purchase Order', manager); // D7 gate (before any mutation)
    await this.numbering.registerDocumentType(GR_DOCUMENT_TYPE, 'GR', true, manager);

    return (manager ?? this.dataSource).transaction(async (txManager) => {
      const grNumber = await this.numbering.getNextNumber(GR_DOCUMENT_TYPE, txManager);
      const grRepo = txManager.getRepository(GoodsReceipt);
      const grLineRepo = txManager.getRepository(GoodsReceiptLine);
      const poLineRepo = txManager.getRepository(PurchaseOrderLine);

      const gr = await grRepo.save(
        grRepo.create({
          grNumber,
          purchaseOrderId: po.id,
          supplierId: po.supplierId,
          warehouseId: po.warehouseId,
          notes: input.notes ?? null,
          receivedByUserId: actorUserId,
        }),
      );

      const eventLines: Array<{ purchaseOrderLineId: string; productId: string; quantityReceived: string; unitCostBase: string; lineValueBase: string }> = [];
      let totalValueBase = 0;

      for (const line of input.lines) {
        const poLine = poLineById.get(line.purchaseOrderLineId)!;
        await grLineRepo.save(
          grLineRepo.create({
            goodsReceiptId: gr.id,
            purchaseOrderLineId: poLine.id,
            productId: poLine.productId,
            quantityReceived: line.quantityReceived,
            unitCostBase: poLine.unitCostBase,
          }),
        );
        await poLineRepo.increment({ id: poLine.id }, 'quantityReceived', Number(line.quantityReceived));

        // The ONE call into Inventory — never a raw warehouse-table write (CTO directive §11).
        await this.inventory.recordMovement(
          po.warehouseId,
          poLine.productId,
          Number(line.quantityReceived),
          'receipt',
          'goods_receipt',
          gr.id,
          actorUserId,
          txManager,
          poLine.unitCostBase,
        );

        const lineValueBase = Number(line.quantityReceived) * Number(poLine.unitCostBase);
        totalValueBase += lineValueBase;
        eventLines.push({
          purchaseOrderLineId: poLine.id,
          productId: poLine.productId,
          quantityReceived: line.quantityReceived,
          unitCostBase: poLine.unitCostBase,
          lineValueBase: lineValueBase.toFixed(4),
        });
      }

      // ADR-054/ADR-057 — GRNI: Dr Inventory / Cr GRNI, one event for this whole receipt, published
      // in the SAME transaction as every line's inventory movement and quantityReceived increment —
      // or none of it commits.
      await this.events.publish(txManager, AP_EVENT_TOPICS.goodsReceiptPosted, {
        idempotencyKey: `procurement:goods_receipt:${gr.id}:posted`,
        businessDate: new Date().toISOString().slice(0, 10),
        orgUnitId: await purchaseOrderBranchOf(txManager, gr.purchaseOrderId),
        currency: 'EGP',
        sourceEntityType: 'goods_receipt' as const,
        sourceEntityId: gr.id,
        externalDocument: null,
        payloadVersion: 1,
        goodsReceiptId: gr.id,
        grNumber,
        purchaseOrderId: po.id,
        supplierId: po.supplierId,
        warehouseId: po.warehouseId,
        totalValueBase: totalValueBase.toFixed(4),
        lines: eventLines,
      });

      const refreshedLines = await poLineRepo.find({ where: { purchaseOrderId: po.id } });
      const fullyReceived = refreshedLines.every((l) => Number(l.quantityReceived) >= Number(l.quantity));
      await this.processEngine.transition(
        PURCHASE_ORDER_PROCESS,
        PO_ENTITY_TYPE,
        po.id,
        fullyReceived ? 'receive_full' : 'receive_partial',
        actorUserId,
        txManager,
      );

      await this.audit.record(
        {
          actorUserId,
          organizationId: null,
          action: 'goods_receipt.posted',
          resource: 'goods_receipt',
          resourceId: gr.id,
          result: 'success',
          correlationId: gr.id,
          after: { grNumber, purchaseOrderId: po.id, lines: input.lines.length, fullyReceived },
        },
        txManager,
      );

      return gr;
    }).then(async (gr) => {
      // Mirrors `SupplierInvoiceService.postInvoice`/`SupplierPaymentService.recordPayment` — the
      // outbox row `events.publish` wrote above only becomes a real GL entry once dispatched; without
      // this call the `finance.goods_receipt.posted` event would sit `pending` until some UNRELATED
      // later action happened to sweep it up, an accidental and non-deterministic delay, not "GR
      // posts → one journal" (ADR-057's own Acceptance Matrix item 1).
      await this.events.dispatchAfterCommit(manager);
      return gr;
    });
  }
}
