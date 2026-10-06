import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { ShipmentReturn } from '../infrastructure/shipment-return.entity';
import { ShipmentReturnLine } from '../infrastructure/shipment-return-line.entity';
import { SHIPMENT_RETURN_PROCESS } from '../domain/shipment-return-process';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { INVENTORY_LOGISTICS_CONTRACT, InventoryLogisticsContract } from '../../../foundation/module-registry/contracts/inventory.contract';
import { SALES_ORDERS_READ_CONTRACT, SalesOrdersReadContract, SALES_CUSTOMERS_CONTRACT, SalesCustomersContract } from '../../../foundation/module-registry/contracts/sales.contract';
import { ShipmentService } from '../../shipment/application/shipment.service';
import { OrderLineReturnCapacityService, OrderLineReturnCapacity } from './order-line-return-capacity.service';
import { ReturnFinancialsService } from './return-financials.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';

const ENTITY_TYPE = 'shipment_return';

export interface ShipmentReturnLineInput {
  shipmentLineId: string;
  returnQuantity: number;
  returnPrice: string;
}

/**
 * Sales/Shipment/Returns workflow review (CTO directive, 2026-09-16).
 * A NEW, additive service — never touches `ReturnsService`/`ReturnRequest`
 * (CTO ratification: leave that flow completely untouched). Bound to an
 * existing `Shipment` at creation (never standalone, directive §3);
 * closes the concurrency race the RBW found in `ReturnsService.
 * createReturnRequest` (no row lock before summing prior returns) by
 * `SELECT ... FOR UPDATE`-locking every referenced `shipment_lines` row,
 * in a deterministic (sorted-id) order, BEFORE computing the
 * already-returned sum — same pattern `NumberingService.getNextNumber`
 * already uses for its own row-locked sequence read.
 */
@Injectable()
export class ShipmentReturnsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly processEngine: ProcessEngineService,
    private readonly audit: AuditService,
    private readonly numbering: NumberingService,
    @Inject(INVENTORY_LOGISTICS_CONTRACT) private readonly inventory: InventoryLogisticsContract,
    @Inject(SALES_ORDERS_READ_CONTRACT) private readonly salesOrders: SalesOrdersReadContract,
    @Inject(SALES_CUSTOMERS_CONTRACT) private readonly customers: SalesCustomersContract,
    private readonly shipments: ShipmentService,
    private readonly capacity: OrderLineReturnCapacityService,
    // D4 (2026-10-05) — the shared financial policy of both return types, and the Company event bus (post-commit flush).
    private readonly financials: ReturnFinancialsService,
    private readonly events: EventBusService,
  ) {}

  /**
   * Creates the return AND commits its quantities atomically (the cap
   * check only means something if it happens at the same instant the
   * quantity is committed — see the class doc comment). Does not move
   * inventory yet; `completeShipmentReturn` does, as its own explicit
   * warehouse-facing step (never conflating "the customer/carrier
   * returned it" with "the warehouse physically received it").
   */
  async createShipmentReturn(
    shipmentId: string,
    returnMode: 'full' | 'partial',
    lines: ShipmentReturnLineInput[],
    reason: string | null,
    requestedByUserId: string,
    manager?: EntityManager,
  ): Promise<ShipmentReturn> {
    if (lines.length === 0) throw new BadRequestException('At least one return line is required.');
    for (const line of lines) {
      if (!Number.isInteger(line.returnQuantity) || line.returnQuantity <= 0) {
        throw new BadRequestException('Return quantity must be a positive integer.');
      }
      if (Number(line.returnPrice) < 0) throw new BadRequestException('Return price cannot be negative.');
    }

    const shipmentSnapshot = await this.shipments.getShipmentLinesSnapshot(shipmentId, manager);
    if (!shipmentSnapshot) throw new NotFoundException(`Shipment "${shipmentId}" not found.`);
    if (!shipmentSnapshot.salesOrderId) {
      throw new BadRequestException(`Shipment "${shipmentId}" has no linked Sales Order — cannot determine the customer for a Shipment Return.`);
    }
    const orderSnapshot = await this.salesOrders.getOrderSnapshot(shipmentSnapshot.salesOrderId, manager);
    if (!orderSnapshot) throw new NotFoundException(`Sales order "${shipmentSnapshot.salesOrderId}" not found.`);

    const shipmentLineById = new Map(shipmentSnapshot.lines.map((l) => [l.id, l]));
    for (const line of lines) {
      if (!shipmentLineById.has(line.shipmentLineId)) {
        throw new BadRequestException(`Shipment line "${line.shipmentLineId}" does not belong to shipment "${shipmentId}".`);
      }
    }

    await this.numbering.registerDocumentType('shipment_return', 'SRT', true, manager);
    const returnNumber = await this.numbering.getNextNumber('shipment_return', manager);

    const header = await (manager ?? this.dataSource).transaction(async (txManager) => {
      // Cross-Return Data Integrity (CTO-approved Option 1, 2026-09-16). The shared
      // serialization boundary is the underlying SalesOrderLine, not shipment_lines —
      // ShipmentLine.quantity is immutable after creation, so only the cumulative-returned
      // reads (which now span BOTH return types) are contended, and OrderLineReturnCapacityService
      // locks exactly that row. Deterministic (sorted) per-distinct-order-line order, same
      // discipline this service already used, now retargeted at the shared boundary.
      const orderLineIds = [...new Set(lines.map((l) => shipmentLineById.get(l.shipmentLineId)!.salesOrderLineId))].sort();
      const capacityByOrderLine = new Map<string, OrderLineReturnCapacity>();
      for (const orderLineId of orderLineIds) {
        capacityByOrderLine.set(orderLineId, await this.capacity.getLockedCapacity(txManager, orderLineId));
      }

      // Aggregate requested quantity per underlying order line first — a request could touch
      // the same order line via two different ShipmentLines (multi-shipment case) and each
      // individually-fine quantity could still exceed the shared cap together.
      const requestedByOrderLine = new Map<string, number>();
      for (const line of lines) {
        const orderLineId = shipmentLineById.get(line.shipmentLineId)!.salesOrderLineId;
        requestedByOrderLine.set(orderLineId, (requestedByOrderLine.get(orderLineId) ?? 0) + line.returnQuantity);
      }
      for (const [orderLineId, requestedQty] of requestedByOrderLine) {
        const cap = capacityByOrderLine.get(orderLineId)!;
        if (requestedQty > cap.remaining) {
          throw new ConflictException(
            `Cannot return ${requestedQty} against sales order line "${orderLineId}" — only ${cap.remaining} remain returnable across ALL return types combined (shipped: ${cap.shippedQuantity}, sold: ${cap.soldQuantity}, already returned via Sales Return: ${cap.returnedViaSalesReturn}, via Shipment Return: ${cap.returnedViaShipmentReturn}).`,
          );
        }
      }

      // Existing per-ShipmentLine bookkeeping — Full mode's own "exact remaining SHIPPED
      // quantity for THIS shipment line" rule, orthogonal to (and enforced in addition to)
      // the shared cross-Return cap above. Safe to read without its own lock: it is derived
      // entirely from data whose writers all first acquire the shared order-line lock above.
      for (const line of lines) {
        const shipmentLine = shipmentLineById.get(line.shipmentLineId)!;
        const priorRows: Array<{ sum: string | null }> = await txManager.query(
          `SELECT SUM(srl."returnQuantity")::text as sum FROM "shipment_return_lines" srl WHERE srl."shipmentLineId" = $1::uuid`,
          [line.shipmentLineId],
        );
        const previouslyReturned = Number(priorRows[0]?.sum ?? 0);
        const maxReturnable = shipmentLine.quantity - previouslyReturned;
        if (line.returnQuantity > maxReturnable) {
          throw new ConflictException(
            `Cannot return ${line.returnQuantity} of shipment line "${line.shipmentLineId}" — only ${maxReturnable} of ${shipmentLine.quantity} shipped remain returnable on this shipment line (already returned via Shipment Return: ${previouslyReturned}).`,
          );
        }
        if (returnMode === 'full' && line.returnQuantity !== maxReturnable) {
          throw new BadRequestException(
            `Full return requires returning the entire remaining shipped quantity (${maxReturnable}) for line "${line.shipmentLineId}" — got ${line.returnQuantity}. Use returnMode "partial" for a smaller quantity.`,
          );
        }
      }

      const headerRepo = txManager.getRepository(ShipmentReturn);
      const saved = await headerRepo.save(
        headerRepo.create({
          returnNumber,
          shipmentId,
          customerId: orderSnapshot.customerId,
          salesOrderId: shipmentSnapshot.salesOrderId!,
          returnMode,
          reason,
          requestedByUserId,
        }),
      );

      const lineRepo = txManager.getRepository(ShipmentReturnLine);
      for (const line of lines) {
        const shipmentLine = shipmentLineById.get(line.shipmentLineId)!;
        const lineTotal = (Number(line.returnPrice) * line.returnQuantity).toFixed(2);
        await lineRepo.save(
          lineRepo.create({
            shipmentReturnId: saved.id,
            shipmentLineId: line.shipmentLineId,
            productId: shipmentLine.productId,
            returnQuantity: line.returnQuantity,
            returnPrice: line.returnPrice,
            lineTotal,
          }),
        );
      }

      await this.processEngine.start(SHIPMENT_RETURN_PROCESS, ENTITY_TYPE, saved.id, txManager);
      return saved;
    });

    await this.audit.record(
      {
        actorUserId: requestedByUserId,
        organizationId: null,
        action: 'shipment_return.requested',
        resource: 'shipment_return',
        resourceId: header.id,
        result: 'success',
        correlationId: null,
        after: { shipmentId, returnMode, returnNumber, lineCount: lines.length },
      },
      manager,
    );

    return header;
  }

  /** The warehouse-facing step: posts the actual `return_in` inventory movement(s) for every committed line, into the order's own warehouse (same destination `ReturnRequest`'s `restock` disposition uses). */
  async completeShipmentReturn(shipmentReturnId: string, actorUserId: string, manager?: EntityManager): Promise<string> {
    const header = await (manager ?? this.dataSource).getRepository(ShipmentReturn).findOne({ where: { id: shipmentReturnId } });
    if (!header) throw new NotFoundException(`Shipment return "${shipmentReturnId}" not found.`);

    const currentState = await this.processEngine.getState(SHIPMENT_RETURN_PROCESS, ENTITY_TYPE, shipmentReturnId, manager);
    if (currentState !== 'requested') {
      throw new ConflictException(`Cannot complete a shipment return in state "${currentState}".`);
    }

    const returnLines = await (manager ?? this.dataSource).getRepository(ShipmentReturnLine).find({ where: { shipmentReturnId } });
    const shipmentSnapshot = await this.shipments.getShipmentLinesSnapshot(header.shipmentId, manager);
    if (!shipmentSnapshot) throw new NotFoundException(`Shipment "${header.shipmentId}" not found.`);
    const orderLineByShipmentLine = new Map(shipmentSnapshot.lines.map((l) => [l.id, l.salesOrderLineId]));

    // D4 (2026-10-05): the same financial policy as a Sales Return — an un-invoiced sale gets Dr Inventory / Cr COGS only
    // (at the original exit cost); an invoiced one gets the full Revenue/AR/tax reversal. One transaction, plan() before any write.
    await (manager ?? this.dataSource).transaction(async (txManager) => {
      const plan = await this.financials.plan(
        returnLines.map((l) => {
          const salesOrderLineId = orderLineByShipmentLine.get(l.shipmentLineId);
          if (!salesOrderLineId) throw new BadRequestException(`Shipment line "${l.shipmentLineId}" no longer resolves to a sales order line.`);
          return { lineId: l.id, salesOrderId: header.salesOrderId, salesOrderLineId, productId: l.productId, quantity: l.returnQuantity };
        }),
        actorUserId,
        txManager,
      );
      await this.processEngine.transition(SHIPMENT_RETURN_PROCESS, ENTITY_TYPE, shipmentReturnId, 'complete', actorUserId, txManager);
      await this.financials.apply('shipment_return', { id: shipmentReturnId, number: header.returnNumber, customerId: header.customerId }, plan, actorUserId, txManager);
    });
    await this.events.dispatchAfterCommit(manager);

    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'shipment_return.completed',
        resource: 'shipment_return',
        resourceId: shipmentReturnId,
        result: 'success',
        correlationId: null,
        after: { lineCount: returnLines.length },
      },
      manager,
    );

    return this.processEngine.getState(SHIPMENT_RETURN_PROCESS, ENTITY_TYPE, shipmentReturnId, manager);
  }

  /**
   * Read-only pre-submit helper (Historical Requirements Audit, 2026-09-17,
   * A1.7 — "Previously Returned Quantity" / "Remaining Returnable Quantity"
   * per shipment line). Mirrors the SAME per-`ShipmentLine` sum this
   * service's own `createShipmentReturn` uses to compute `maxReturnable`
   * (never `FOR UPDATE` here — this is display guidance only, the real
   * enforcement stays the locked check inside the write transaction). Does
   * NOT additionally fold in the cross-aggregate `OrderLineReturnCapacity`
   * ceiling (that one needs a lock to mean anything and is re-verified
   * authoritatively at submit time regardless) — a rarer multi-shipment/
   * cross-return-type case can still submit-time 409 even when this number
   * says "remaining", exactly like every other optimistic-UI quantity
   * field in this codebase. Read-only, no transaction, no lock — display
   * guidance only.
   */
  async getReturnableLines(
    shipmentId: string,
    manager?: EntityManager,
  ): Promise<Array<{ shipmentLineId: string; productId: string; shippedQuantity: number; unitPrice: string; previouslyReturned: number; remaining: number }>> {
    const snapshot = await this.shipments.getShipmentLinesSnapshot(shipmentId, manager);
    if (!snapshot) throw new NotFoundException(`Shipment "${shipmentId}" not found.`);
    return Promise.all(
      snapshot.lines.map(async (line) => {
        // Deliberately NOT state-filtered — byte-for-byte the same query `createShipmentReturn`
        // itself runs (that one has no `rejected`-exclusion either; `reject` has no route exposed
        // anywhere in this controller today, so the two queries are equivalent in practice, and
        // this one must keep tracking whichever query is authoritative rather than diverge from it).
        const priorRows: Array<{ sum: string | null }> = await (manager ?? this.dataSource).query(
          `SELECT SUM(srl."returnQuantity")::text as sum FROM "shipment_return_lines" srl WHERE srl."shipmentLineId" = $1::uuid`,
          [line.id],
        );
        const previouslyReturned = Number(priorRows[0]?.sum ?? 0);
        return {
          shipmentLineId: line.id,
          productId: line.productId,
          shippedQuantity: line.quantity,
          unitPrice: line.unitPrice,
          previouslyReturned,
          remaining: line.quantity - previouslyReturned,
        };
      }),
    );
  }

  /** List-screen fields per CTO directive §9-equivalent for shipments: customer name + amount must be visible without a detail fetch. */
  async listShipmentReturns(manager?: EntityManager): Promise<Array<ShipmentReturn & { state: string; totalAmount: string; customerName: string | null }>> {
    const headers = await (manager ?? this.dataSource).getRepository(ShipmentReturn).find({ order: { createdAt: 'DESC' } });
    return Promise.all(
      headers.map(async (h) => {
        const state = await this.processEngine.getState(SHIPMENT_RETURN_PROCESS, ENTITY_TYPE, h.id, manager);
        const lines = await (manager ?? this.dataSource).getRepository(ShipmentReturnLine).find({ where: { shipmentReturnId: h.id } });
        const totalAmount = lines.reduce((sum, l) => sum + Number(l.lineTotal), 0).toFixed(2);
        const customer = await this.customers.getCustomerSnapshot(h.customerId, manager);
        return { ...h, state, totalAmount, customerName: customer?.name ?? null };
      }),
    );
  }

  async getShipmentReturnDetail(
    shipmentReturnId: string,
    manager?: EntityManager,
  ): Promise<{ header: ShipmentReturn; state: string; lines: ShipmentReturnLine[]; totalAmount: string; customerName: string | null }> {
    const header = await (manager ?? this.dataSource).getRepository(ShipmentReturn).findOne({ where: { id: shipmentReturnId } });
    if (!header) throw new NotFoundException(`Shipment return "${shipmentReturnId}" not found.`);
    const state = await this.processEngine.getState(SHIPMENT_RETURN_PROCESS, ENTITY_TYPE, shipmentReturnId, manager);
    const lines = await (manager ?? this.dataSource).getRepository(ShipmentReturnLine).find({ where: { shipmentReturnId } });
    const totalAmount = lines.reduce((sum, l) => sum + Number(l.lineTotal), 0).toFixed(2);
    const customer = await this.customers.getCustomerSnapshot(header.customerId, manager);
    return { header, state, lines, totalAmount, customerName: customer?.name ?? null };
  }
}
