import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SalesReturn } from '../infrastructure/sales-return.entity';
import { SalesReturnLine } from '../infrastructure/sales-return-line.entity';
import { SALES_RETURN_PROCESS } from '../domain/sales-return-process';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { ConfigurationEngineService } from '../../../foundation/configuration-engine/configuration-engine.service';
import { INVENTORY_LOGISTICS_CONTRACT, InventoryLogisticsContract } from '../../../foundation/module-registry/contracts/inventory.contract';
import { SALES_ORDERS_READ_CONTRACT, SalesOrdersReadContract, SALES_CUSTOMERS_CONTRACT, SalesCustomersContract } from '../../../foundation/module-registry/contracts/sales.contract';
import { OrderLineReturnCapacityService, OrderLineReturnCapacity } from './order-line-return-capacity.service';

const ENTITY_TYPE = 'sales_return';
const DEFAULT_ELIGIBILITY_WINDOW_DAYS = 365;

export interface SalesReturnLineInput {
  sourceSalesOrderLineId: string;
  returnQuantity: number;
  returnPrice: string;
}

/**
 * Sales/Shipment/Returns workflow review (CTO directive, 2026-09-16).
 * A NEW, additive service — independent of `ShipmentReturnsService` and
 * of `ReturnsService`/`ReturnRequest` (untouched). `salesOrderId` on the
 * header is a UI convenience only ("Specific Order" vs "All Orders" —
 * CTO directive §5); every line independently carries and re-verifies
 * its own `sourceSalesOrderId`/`sourceSalesOrderLineId`, so a single
 * return can legitimately span multiple source orders (directive §10)
 * without ever assuming "one return = one order" anywhere in this class.
 */
@Injectable()
export class SalesReturnsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly processEngine: ProcessEngineService,
    private readonly audit: AuditService,
    private readonly numbering: NumberingService,
    private readonly config: ConfigurationEngineService,
    @Inject(INVENTORY_LOGISTICS_CONTRACT) private readonly inventory: InventoryLogisticsContract,
    @Inject(SALES_ORDERS_READ_CONTRACT) private readonly salesOrders: SalesOrdersReadContract,
    @Inject(SALES_CUSTOMERS_CONTRACT) private readonly customers: SalesCustomersContract,
    private readonly capacity: OrderLineReturnCapacityService,
  ) {}

  private getEligibilityWindowDays(): number {
    const configured = this.config.get<number>('logistics.sales_return_eligibility_window_days');
    return typeof configured === 'number' && configured > 0 ? configured : DEFAULT_ELIGIBILITY_WINDOW_DAYS;
  }

  /**
   * "All Orders" product picker (CTO directive §6-§7) — real join over
   * this customer's own order-lines, never a global product list. The
   * window is read from config (`logistics.sales_return_eligibility_
   * window_days`, default 365), never hardcoded in a controller/UI.
   */
  async listEligiblePurchaseLines(customerId: string, returnDate: Date) {
    const windowDays = this.getEligibilityWindowDays();
    return this.salesOrders.findEligibleReturnPurchaseLines(customerId, returnDate, windowDays);
  }

  /**
   * Server-side re-validation (CTO directive §11 — never trust a
   * client-supplied selection as pre-validated): eligibility window,
   * customer ownership, and a returned-quantity cap against the
   * ORIGINAL sold quantity (mirrors `ReturnRequest`'s own precedented
   * "returned <= sold - previously returned" rule), all under a row
   * lock on the referenced `sales_order_lines` row so two concurrent
   * Sales Returns against the same line cannot both pass the cap check
   * — the same race class the RBW found unclosed in `ReturnsService.
   * createReturnRequest`.
   */
  async createSalesReturn(
    customerId: string,
    salesOrderId: string | null,
    returnDate: Date,
    lines: SalesReturnLineInput[],
    reason: string | null,
    requestedByUserId: string,
  ): Promise<SalesReturn> {
    if (lines.length === 0) throw new BadRequestException('At least one return line is required.');
    for (const line of lines) {
      if (!Number.isInteger(line.returnQuantity) || line.returnQuantity <= 0) {
        throw new BadRequestException('Return quantity must be a positive integer.');
      }
      if (Number(line.returnPrice) < 0) throw new BadRequestException('Return price cannot be negative.');
    }

    const windowDays = this.getEligibilityWindowDays();

    // Fetched once, outside the loop — the eligibility set doesn't change per-line, only the
    // membership check does. getOrder/getOrderSnapshot don't expose createdAt directly, so the
    // window check is re-derived the same way the picker computes it, never trusted from the client.
    const eligible = await this.salesOrders.findEligibleReturnPurchaseLines(customerId, returnDate, windowDays);
    const eligibleByLineId = new Map(eligible.map((e) => [e.salesOrderLineId, e]));

    type ResolvedLine = SalesReturnLineInput & { sourceSalesOrderId: string; productId: string; originalQuantity: number; originalUnitPrice: string };
    const resolved: ResolvedLine[] = [];
    for (const line of lines) {
      const orderLine = await this.salesOrders.getOrderLineById(line.sourceSalesOrderLineId);
      if (!orderLine) throw new NotFoundException(`Sales order line "${line.sourceSalesOrderLineId}" not found.`);
      const order = await this.salesOrders.getOrder(orderLine.salesOrderId, requestedByUserId);
      if (order.customerId !== customerId) {
        throw new BadRequestException(
          `Sales order line "${line.sourceSalesOrderLineId}" belongs to a different customer — cannot attach it to this Sales Return.`,
        );
      }
      const eligibleLine = eligibleByLineId.get(line.sourceSalesOrderLineId);
      if (!eligibleLine) {
        throw new ConflictException(
          `Sales order line "${line.sourceSalesOrderLineId}" is outside the ${windowDays}-day return eligibility window ending ${returnDate.toISOString()}, or was never sold to this customer.`,
        );
      }
      resolved.push({
        ...line,
        sourceSalesOrderId: orderLine.salesOrderId,
        productId: orderLine.productId,
        originalQuantity: orderLine.quantity,
        originalUnitPrice: eligibleLine.originalUnitPrice,
      });
    }

    await this.numbering.registerDocumentType('sales_return', 'SLR');
    const returnNumber = await this.numbering.getNextNumber('sales_return');

    const header = await this.dataSource.transaction(async (manager) => {
      // Cross-Return Data Integrity (CTO-approved Option 1, 2026-09-16). Same shared
      // OrderLineReturnCapacityService as ShipmentReturnsService — neither service calls the
      // other; both independently lock+read through this one stateless helper. The lock this
      // service already took on "sales_order_lines" (this exact row, this exact query shape)
      // IS the shared serialization boundary — now delegated entirely to the shared helper
      // instead of a locally-duplicated lock query, so there is exactly one lock site for both
      // return types to reason about.
      const orderLineIds = [...new Set(resolved.map((l) => l.sourceSalesOrderLineId))].sort();
      const capacityByOrderLine = new Map<string, OrderLineReturnCapacity>();
      for (const orderLineId of orderLineIds) {
        capacityByOrderLine.set(orderLineId, await this.capacity.getLockedCapacity(manager, orderLineId));
      }

      // Aggregate requested quantity per order line first (a multi-order "All Orders" return
      // cannot touch the same line twice today, but defensive aggregation costs nothing and
      // matches ShipmentReturnsService's own discipline).
      const requestedByOrderLine = new Map<string, number>();
      for (const line of resolved) {
        requestedByOrderLine.set(line.sourceSalesOrderLineId, (requestedByOrderLine.get(line.sourceSalesOrderLineId) ?? 0) + line.returnQuantity);
      }
      for (const [orderLineId, requestedQty] of requestedByOrderLine) {
        const cap = capacityByOrderLine.get(orderLineId)!;
        if (requestedQty > cap.remaining) {
          throw new ConflictException(
            `Cannot return ${requestedQty} of order line "${orderLineId}" — only ${cap.remaining} remain returnable across ALL return types combined (shipped: ${cap.shippedQuantity}, sold: ${cap.soldQuantity}, already returned via Sales Return: ${cap.returnedViaSalesReturn}, via Shipment Return: ${cap.returnedViaShipmentReturn}).`,
          );
        }
      }

      const totalAmount = resolved.reduce((sum, l) => sum + Number(l.returnPrice) * l.returnQuantity, 0).toFixed(2);

      const headerRepo = manager.getRepository(SalesReturn);
      const saved = await headerRepo.save(
        headerRepo.create({ returnNumber, customerId, salesOrderId, returnDate, totalAmount, reason, requestedByUserId }),
      );

      const lineRepo = manager.getRepository(SalesReturnLine);
      for (const line of resolved) {
        const lineTotal = (Number(line.returnPrice) * line.returnQuantity).toFixed(2);
        await lineRepo.save(
          lineRepo.create({
            salesReturnId: saved.id,
            sourceSalesOrderId: line.sourceSalesOrderId,
            sourceSalesOrderLineId: line.sourceSalesOrderLineId,
            productId: line.productId,
            returnQuantity: line.returnQuantity,
            originalUnitPrice: line.originalUnitPrice,
            returnPrice: line.returnPrice,
            lineTotal,
          }),
        );
      }

      await this.processEngine.start(SALES_RETURN_PROCESS, ENTITY_TYPE, saved.id, manager);
      return saved;
    });

    await this.audit.record({
      actorUserId: requestedByUserId,
      organizationId: null,
      action: 'sales_return.requested',
      resource: 'sales_return',
      resourceId: header.id,
      result: 'success',
      correlationId: null,
      after: { customerId, salesOrderId, returnNumber, lineCount: resolved.length, sourceOrders: [...new Set(resolved.map((l) => l.sourceSalesOrderId))] },
    });

    return header;
  }

  /** The warehouse-facing step — posts `return_in` per line into that line's OWN source order's warehouse (a multi-order return can have lines destined for different warehouses; never assume one). */
  async completeSalesReturn(salesReturnId: string, actorUserId: string): Promise<string> {
    const header = await this.dataSource.getRepository(SalesReturn).findOne({ where: { id: salesReturnId } });
    if (!header) throw new NotFoundException(`Sales return "${salesReturnId}" not found.`);

    const currentState = await this.processEngine.getState(SALES_RETURN_PROCESS, ENTITY_TYPE, salesReturnId);
    if (currentState !== 'requested') {
      throw new ConflictException(`Cannot complete a sales return in state "${currentState}".`);
    }

    const lines = await this.dataSource.getRepository(SalesReturnLine).find({ where: { salesReturnId } });

    await this.dataSource.transaction(async (manager) => {
      await this.processEngine.transition(SALES_RETURN_PROCESS, ENTITY_TYPE, salesReturnId, 'complete', actorUserId, manager);
      for (const line of lines) {
        const order = await this.salesOrders.getOrder(line.sourceSalesOrderId, actorUserId);
        if (!order.warehouseId) continue; // disclosed: a source order with no warehouse cannot receive a physical restock — the document still completes, the line's inventory effect is skipped, never silently guessed at.
        await this.inventory.recordMovement(order.warehouseId, line.productId, line.returnQuantity, 'return_in', 'sales_return', salesReturnId, actorUserId, manager);
      }
    });

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'sales_return.completed',
      resource: 'sales_return',
      resourceId: salesReturnId,
      result: 'success',
      correlationId: null,
      after: { lineCount: lines.length },
    });

    return this.processEngine.getState(SALES_RETURN_PROCESS, ENTITY_TYPE, salesReturnId);
  }

  /** List-screen fields per CTO directive §9: customer name + return amount visible without a detail fetch. */
  async listSalesReturns(): Promise<Array<SalesReturn & { state: string; customerName: string | null }>> {
    const headers = await this.dataSource.getRepository(SalesReturn).find({ order: { createdAt: 'DESC' } });
    return Promise.all(
      headers.map(async (h) => {
        const state = await this.processEngine.getState(SALES_RETURN_PROCESS, ENTITY_TYPE, h.id);
        const customer = await this.customers.getCustomerSnapshot(h.customerId);
        return { ...h, state, customerName: customer?.name ?? null };
      }),
    );
  }

  /** Return Details per CTO directive §9: all source orders, not just one — `sourceOrderIds` is always an array, never a single value. */
  async getSalesReturnDetail(
    salesReturnId: string,
  ): Promise<{ header: SalesReturn; state: string; lines: SalesReturnLine[]; sourceOrderIds: string[]; customerName: string | null }> {
    const header = await this.dataSource.getRepository(SalesReturn).findOne({ where: { id: salesReturnId } });
    if (!header) throw new NotFoundException(`Sales return "${salesReturnId}" not found.`);
    const state = await this.processEngine.getState(SALES_RETURN_PROCESS, ENTITY_TYPE, salesReturnId);
    const lines = await this.dataSource.getRepository(SalesReturnLine).find({ where: { salesReturnId } });
    const sourceOrderIds = [...new Set(lines.map((l) => l.sourceSalesOrderId))];
    const customer = await this.customers.getCustomerSnapshot(header.customerId);
    return { header, state, lines, sourceOrderIds, customerName: customer?.name ?? null };
  }
}
