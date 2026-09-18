import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ReturnRequest } from '../infrastructure/return-request.entity';
import { ReturnDisposition } from '../infrastructure/return-disposition.entity';
import { ReturnCredit } from '../infrastructure/return-credit.entity';
import { RETURN_PROCESS } from '../domain/return-process';
import { DispositionType } from '../domain/disposition-type';
import { ReturnType, isValidReturnType, CREDIT_BEARING_RETURN_TYPES } from '../domain/return-type';
import { ReturnOrigin } from '../domain/return-origin';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { AuthorizationService } from '../../../foundation/authorization/authorization.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { InventoryService } from '../../inventory-warehouse/application/inventory.service';
import { SalesOrdersService } from '../../sales-orders/application/sales-orders.service';
import { ShipmentService } from '../../shipment/application/shipment.service';
import { DeliveryService } from '../../delivery/application/delivery.service';
import { CustomerLedgerService } from '../../customer-finance/application/customer-ledger.service';
import { InvoiceService } from '../../customer-finance/application/invoices.service';
import { CustomersService } from '../../crm/application/customers.service';

const ENTITY_TYPE = 'return_request';

type ReturnSubLocationKind = 'inspection' | 'damaged' | 'repair';

/** Auto-provisioned Warehouse sub-locations (kind='operational') a returned unit can end up in — same "get-or-create via Numbering Engine, never string-concatenated" pattern already proven by Preparation and Shipping Custody's own sub-locations. */
const RETURN_SUB_LOCATIONS: Record<ReturnSubLocationKind, { prefix: string; documentType: string; name: string }> = {
  inspection: { prefix: 'RETINS', documentType: 'returns_inspection_sub_location', name: 'قيد فحص المرتجعات' },
  damaged: { prefix: 'DMG', documentType: 'returns_damaged_sub_location', name: 'تالف' },
  repair: { prefix: 'RPR', documentType: 'returns_repair_sub_location', name: 'إصلاح' },
};

@Injectable()
export class ReturnsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly processEngine: ProcessEngineService,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditService,
    private readonly events: EventBusService,
    private readonly inventory: InventoryService,
    private readonly numbering: NumberingService,
    private readonly salesOrders: SalesOrdersService,
    private readonly shipments: ShipmentService,
    private readonly delivery: DeliveryService,
    private readonly customerLedger: CustomerLedgerService,
    private readonly invoices: InvoiceService,
    private readonly customers: CustomersService,
  ) {}

  /**
   * Returns Engine (CTO directive) — resolves the line directly rather
   * than trusting a client-supplied productId/salesOrderId pair (ambiguous
   * for an order with the same product on two lines), enforces the
   * mandatory quantity cap ("returned qty <= sold qty - previously
   * returned qty", directive §2), and Scope-checks the actor via
   * `SalesOrdersService.getOrder` — the same check `createOrder` itself
   * uses, never re-derived.
   */
  async createReturnRequest(
    salesOrderLineId: string,
    quantity: number,
    returnType: ReturnType,
    reason: string,
    requestedByUserId: string,
  ): Promise<ReturnRequest> {
    if (!isValidReturnType(returnType)) throw new BadRequestException(`Invalid return type "${returnType}".`);
    if (!Number.isInteger(quantity) || quantity <= 0) throw new BadRequestException('Return quantity must be a positive integer.');

    const line = await this.salesOrders.getOrderLineById(salesOrderLineId);
    if (!line) throw new NotFoundException(`Sales order line "${salesOrderLineId}" not found.`);
    const order = await this.salesOrders.getOrder(line.salesOrderId, requestedByUserId);
    if (!order.warehouseId) {
      throw new BadRequestException(`Sales order "${line.salesOrderId}" has no warehouse to return stock into.`);
    }

    const priorRequests = await this.dataSource.getRepository(ReturnRequest).find({ where: { salesOrderLineId } });
    let previouslyReturned = 0;
    for (const prior of priorRequests) {
      const state = await this.getStatus(prior.id);
      if (state !== 'rejected') previouslyReturned += prior.quantity;
    }
    const maxReturnable = line.quantity - previouslyReturned;
    if (quantity > maxReturnable) {
      throw new ConflictException(
        `Cannot return ${quantity} — only ${maxReturnable} of ${line.quantity} sold remain returnable (already returned or in-flight: ${previouslyReturned}).`,
      );
    }

    await this.numbering.registerDocumentType('return', 'RET'); // idempotent
    const returnNumber = await this.numbering.getNextNumber('return');

    const repo = this.dataSource.getRepository(ReturnRequest);
    const request = await repo.save(
      repo.create({
        salesOrderId: line.salesOrderId,
        salesOrderLineId,
        productId: line.productId,
        quantity,
        warehouseId: order.warehouseId,
        reason,
        requestedByUserId,
        returnType,
        returnNumber,
        // Explicit, never relying on the column's DB-level DEFAULT — the
        // in-memory entity `repo.create()` returns has no value for
        // `origin` until a real round-trip to Postgres, and `recordDisposition`
        // branches on this field before that round-trip could ever happen.
        origin: 'customer',
        shipmentId: null,
        custodianType: null,
        custodianId: null,
      }),
    );
    await this.processEngine.start(RETURN_PROCESS, ENTITY_TYPE, request.id);

    await this.audit.record({
      actorUserId: requestedByUserId,
      organizationId: null,
      action: 'return.requested',
      resource: 'return_request',
      resourceId: request.id,
      result: 'success',
      correlationId: null,
      after: { salesOrderId: line.salesOrderId, salesOrderLineId, productId: line.productId, quantity, reason, returnType, returnNumber },
    });

    return request;
  }

  /**
   * Returns Engine Phase B (CTO directive — "مرتجعات الشحن") — a
   * pre-delivery custody reversal: goods sitting in a Shipping Company's
   * or a Company Vehicle's custody, never delivered to the customer, so
   * unlike `createReturnRequest` there is no `returnType`/customer credit
   * involved (the customer never received the goods — directive's
   * explicit instruction) and no `salesOrderLineId`/sold-quantity cap (that
   * cap assumes the goods were actually shipped to and received by the
   * customer, which never happened here — the real cap enforced instead is
   * "how much of this product is ACTUALLY still in this custodian's
   * custody," checked by `InventoryService.relocateReservedStock` itself).
   * Reuses the SAME `return_request` Process Engine + `ReturnRequest`
   * table as customer returns (directive's own "Return Engine واحد" — one
   * unified engine, never a parallel Returns system per origin).
   */
  async initiateCustodyReturn(
    shipmentId: string,
    productId: string,
    quantity: number,
    reason: string,
    actorUserId: string,
  ): Promise<ReturnRequest> {
    await this.requireRole(actorUserId, ['warehouse_worker', 'sales_supervisor']);

    if (!Number.isInteger(quantity) || quantity <= 0) throw new BadRequestException('Return quantity must be a positive integer.');

    const shipmentState = await this.shipments.getStatus(shipmentId);
    if (shipmentState === 'delivered' || shipmentState === 'returned') {
      throw new BadRequestException(`Cannot initiate a custody return for a shipment in state "${shipmentState}" — the goods are no longer in custody.`);
    }

    const shipmentSnapshot = await this.shipments.getShipmentSnapshot(shipmentId);
    if (!shipmentSnapshot) throw new NotFoundException(`Shipment "${shipmentId}" not found.`);
    if (!shipmentSnapshot.shippingCompanyId && !shipmentSnapshot.vehicleId) {
      throw new BadRequestException('This shipment has no shipping company or vehicle custodian assigned — use the standard customer return instead.');
    }
    if (!shipmentSnapshot.salesOrderId) {
      throw new ConflictException(`Shipment "${shipmentId}" has no linked sales order.`);
    }

    // Financial guard (directive — a return after COD was already collected
    // is a materially different, harder case, explicitly out of scope for
    // this cut): a pre-delivery custody return has zero Treasury unwind to
    // perform in the common case (COD only ever posts at actual delivery,
    // `DeliveryService.recordCollection`) — but if collection already
    // happened, reject outright rather than silently mishandle money.
    const existingCollection = await this.delivery.getCollectionForShipmentUnscoped(shipmentId);
    if (existingCollection) {
      throw new ConflictException(
        `Shipment "${shipmentId}" already has a COD collection recorded (${existingCollection.id}) — a custody return after collection requires manual finance reconciliation and is not supported here.`,
      );
    }

    const order = await this.salesOrders.getOrder(shipmentSnapshot.salesOrderId, actorUserId);
    if (!order.warehouseId) {
      throw new BadRequestException(`Sales order "${shipmentSnapshot.salesOrderId}" has no warehouse to return stock into.`);
    }

    const custodyWarehouseId = await this.shipments.getCurrentCustodyWarehouseId(shipmentId);
    if (!custodyWarehouseId) {
      throw new ConflictException('Could not resolve the current custody warehouse for this shipment.');
    }

    const custodianType: 'company' | 'vehicle' = shipmentSnapshot.vehicleId ? 'vehicle' : 'company';
    const custodianId = shipmentSnapshot.vehicleId ?? shipmentSnapshot.shippingCompanyId!;
    const origin: ReturnOrigin = custodianType === 'vehicle' ? 'vehicle_custody' : 'shipping_company_custody';

    await this.numbering.registerDocumentType('return', 'RET'); // idempotent
    const returnNumber = await this.numbering.getNextNumber('return');

    const repo = this.dataSource.getRepository(ReturnRequest);
    const request = await repo.save(
      repo.create({
        salesOrderId: shipmentSnapshot.salesOrderId,
        salesOrderLineId: null,
        productId,
        quantity,
        warehouseId: order.warehouseId,
        reason,
        requestedByUserId: actorUserId,
        returnType: null,
        returnNumber,
        origin,
        shipmentId,
        custodianType,
        custodianId,
      }),
    );
    await this.processEngine.start(RETURN_PROCESS, ENTITY_TYPE, request.id);
    // Custody returns are dispatcher-initiated (already role-gated at entry
    // above), not a customer-facing request awaiting a supervisor's
    // separate approval — auto-authorize straight through, same as no
    // second approval gate exists on Inventory's own deposit-confirm path.
    await this.processEngine.transition(RETURN_PROCESS, ENTITY_TYPE, request.id, 'authorize', actorUserId);

    // `relocateReservedStock` enforces the REAL cap here: it fails if this
    // custodian's warehouse doesn't actually hold >= `quantity` of this
    // product under an active reservation for this order — the custody
    // return's equivalent of Phase A's "sold qty - previously returned"
    // check, just checked against physical custody instead.
    const inspectionWarehouseId = await this.getOrCreateReturnSubLocation(order.warehouseId, 'inspection');
    await this.inventory.relocateReservedStock(
      shipmentSnapshot.salesOrderId,
      productId,
      custodyWarehouseId,
      inspectionWarehouseId,
      quantity,
      'custody_return_request',
      request.id,
      actorUserId,
    );
    await this.processEngine.transition(RETURN_PROCESS, ENTITY_TYPE, request.id, 'receive_at_warehouse', actorUserId);

    await this.shipments.recordCustodyReversal(shipmentId, productId, quantity, actorUserId);

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'return.custody_initiated',
      resource: 'return_request',
      resourceId: request.id,
      result: 'success',
      correlationId: null,
      after: { shipmentId, custodianType, custodianId, productId, quantity, reason, origin, returnNumber },
    });

    return request;
  }

  /** Backs the Returns operational screen — every actor in the return lifecycle (rep, supervisor, warehouse_worker) needs visibility across the whole queue to do their stage's job, same "qualified role over the whole queue" pattern as Sales Orders' reviewer visibility. */
  async listReturns(): Promise<Array<ReturnRequest & { state: string }>> {
    const requests = await this.dataSource.getRepository(ReturnRequest).find({ order: { createdAt: 'DESC' } });
    return Promise.all(
      requests.map(async (r) => ({ ...r, state: await this.getStatus(r.id) })),
    );
  }

  private async requireRole(actorUserId: string, roles: string[]): Promise<void> {
    const userRoles = await this.authorization.getRoleKeysForUser(actorUserId);
    if (userRoles.includes('admin')) return;
    if (!roles.some((r) => userRoles.includes(r))) {
      throw new ForbiddenException(`Role required: one of [${roles.join(', ')}] (or admin).`);
    }
  }

  async authorize(returnRequestId: string, actorUserId: string): Promise<string> {
    await this.requireRole(actorUserId, ['sales_supervisor']);
    await this.processEngine.transition(RETURN_PROCESS, ENTITY_TYPE, returnRequestId, 'authorize', actorUserId);
    return this.getStatus(returnRequestId);
  }

  async reject(returnRequestId: string, actorUserId: string): Promise<string> {
    await this.requireRole(actorUserId, ['sales_supervisor']);
    await this.processEngine.transition(RETURN_PROCESS, ENTITY_TYPE, returnRequestId, 'reject', actorUserId);
    return this.getStatus(returnRequestId);
  }

  /**
   * Returns/Inspection Location (CTO directive) — the goods now get a
   * REAL inventory position, not just a Process Engine state flip: a
   * `return_in` movement into the Returns/Inspection sub-location under
   * the order's own warehouse (auto-provisioned, get-or-create, same
   * precedent as Preparation's "تحت التجهيز"). Before this point (`requested`/
   * `authorized`), nothing has touched the ledger — matches the
   * directive's "Draft لا يحرك مخزونًا" boundary.
   */
  async receiveAtWarehouse(returnRequestId: string, actorUserId: string): Promise<string> {
    await this.requireRole(actorUserId, ['warehouse_worker']);
    const request = await this.dataSource.getRepository(ReturnRequest).findOneOrFail({ where: { id: returnRequestId } });
    await this.processEngine.transition(RETURN_PROCESS, ENTITY_TYPE, returnRequestId, 'receive_at_warehouse', actorUserId);

    const inspectionWarehouseId = await this.getOrCreateReturnSubLocation(request.warehouseId, 'inspection');
    await this.inventory.recordMovement(
      inspectionWarehouseId,
      request.productId,
      request.quantity,
      'return_in',
      'return_request',
      returnRequestId,
      actorUserId,
    );

    return this.getStatus(returnRequestId);
  }

  async inspect(returnRequestId: string, actorUserId: string): Promise<string> {
    await this.requireRole(actorUserId, ['warehouse_worker']);
    await this.processEngine.transition(RETURN_PROCESS, ENTITY_TYPE, returnRequestId, 'inspect', actorUserId);
    return this.getStatus(returnRequestId);
  }

  private async getOrCreateReturnSubLocation(parentWarehouseId: string, kind: ReturnSubLocationKind): Promise<string> {
    const config = RETURN_SUB_LOCATIONS[kind];
    const existing = await this.inventory.findOperationalSubLocation(parentWarehouseId, `${config.prefix}-`);
    if (existing) return existing.id;

    await this.numbering.registerDocumentType(config.documentType, config.prefix, false);
    const code = await this.numbering.getNextNumber(config.documentType);
    const warehouse = await this.inventory.createWarehouse(code, config.name, null, null, parentWarehouseId, 'operational');
    return warehouse.id;
  }

  /** `null` return means a write-off with no inbound leg (scrap) — never a bug, a deliberate one-sided ledger exit, same precedent as a final customer dispatch. */
  private async resolveDispositionDestination(mainWarehouseId: string, disposition: DispositionType): Promise<string | null> {
    switch (disposition) {
      case 'restock':
      case 'replacement':
        return mainWarehouseId; // Finished Goods — the order's own warehouse
      case 'damaged':
        return this.getOrCreateReturnSubLocation(mainWarehouseId, 'damaged');
      case 'repair':
        return this.getOrCreateReturnSubLocation(mainWarehouseId, 'repair');
      case 'scrap':
        return null;
    }
  }

  /**
   * Blueprint §29 + Returns Engine (CTO directive): every disposition now
   * has a real ledger effect — the goods physically leave Inspection
   * (`transfer_out`) and land at their real destination (`transfer_in`),
   * never materializing from nowhere the way the pre-Returns-Engine
   * `restock`-only single movement used to. A `ReturnCredit` is created
   * here too, for `value_credit`/`product_return` types only (never
   * `exchange` — directive §2.A's explicit "no credit for a same-value
   * exchange" rule) — decoupled from the physical disposition outcome
   * itself, since what the warehouse decides to do with the physical
   * goods (restock/damaged/repair/scrap) is orthogonal to whether the
   * CUSTOMER is owed credit for having returned them.
   */
  async recordDisposition(
    returnRequestId: string,
    disposition: DispositionType,
    notes: string | null,
    actorUserId: string,
  ): Promise<ReturnDisposition> {
    await this.requireRole(actorUserId, ['warehouse_worker']);

    const currentState = await this.getStatus(returnRequestId);
    if (currentState !== 'inspected') {
      throw new ConflictException(`Cannot record a disposition for a return in state "${currentState}".`);
    }

    const request = await this.dataSource.getRepository(ReturnRequest).findOneOrFail({ where: { id: returnRequestId } });

    // Phase B — "replacement" (issue a different unit to the customer) is
    // meaningless for a pre-delivery custody return: the customer never
    // had the goods to begin with, so there's no one to issue a
    // replacement to.
    if (request.origin !== 'customer' && disposition === 'replacement') {
      throw new BadRequestException('"replacement" is a customer-facing disposition — not valid for a pre-delivery custody return.');
    }

    const record = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(ReturnDisposition);
      const saved = await repo.save(repo.create({ returnRequestId, disposition, notes, inspectedByUserId: actorUserId }));
      await this.events.publish(manager, 'return.disposition.recorded', { returnRequestId, disposition });
      return saved;
    });

    await this.processEngine.transition(RETURN_PROCESS, ENTITY_TYPE, returnRequestId, 'disposition', actorUserId);

    const inspectionWarehouseId = await this.getOrCreateReturnSubLocation(request.warehouseId, 'inspection');
    const destinationWarehouseId = await this.resolveDispositionDestination(request.warehouseId, disposition);

    if (request.origin !== 'customer' && disposition === 'restock') {
      // Pre-delivery custody return, restocked: the reservation itself
      // follows the goods back to Finished Goods and stays active — the
      // order remains fulfillable from there, same primitive
      // `ShipmentService.transferCustodyOnPickup` uses, reversed.
      await this.inventory.relocateReservedStock(
        request.salesOrderId,
        request.productId,
        inspectionWarehouseId,
        destinationWarehouseId!,
        request.quantity,
        'return_request',
        returnRequestId,
        actorUserId,
      );
    } else {
      if (request.origin !== 'customer') {
        // damaged/repair/scrap: these specific units can no longer fulfil
        // the order — release exactly this quantity of the reservation
        // still sitting at Inspection (unlike a customer return, where the
        // reservation was already consumed by dispatch long before the
        // goods came back, so there is nothing left to release).
        await this.inventory.releaseReservedQuantity(request.salesOrderId, request.productId, inspectionWarehouseId, request.quantity, actorUserId);
      }
      await this.inventory.recordMovement(
        inspectionWarehouseId,
        request.productId,
        request.quantity,
        'transfer_out',
        'return_request',
        returnRequestId,
        actorUserId,
      );
      if (destinationWarehouseId) {
        await this.inventory.recordMovement(
          destinationWarehouseId,
          request.productId,
          request.quantity,
          'transfer_in',
          'return_request',
          returnRequestId,
          actorUserId,
        );
      }
    }

    let createdCredit: ReturnCredit | null = null;
    if (request.returnType && CREDIT_BEARING_RETURN_TYPES.includes(request.returnType) && request.salesOrderLineId) {
      createdCredit = await this.createReturnCreditForRequest(request, request.salesOrderLineId, actorUserId);
    }

    await this.dataSource.transaction(async (manager) => {
      await this.events.publish(manager, 'return.completed', {
        returnRequestId,
        salesOrderId: request.salesOrderId,
        disposition,
        businessDate: new Date().toISOString(),
      });
    });

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'return.completed',
      resource: 'return_request',
      resourceId: returnRequestId,
      result: 'success',
      correlationId: null,
      after: {
        disposition,
        returnType: request.returnType,
        creditId: createdCredit?.id ?? null,
        creditAmount: createdCredit?.originalAmount ?? null,
      },
    });

    return record;
  }

  /**
   * Return Credit amount — the line's OWN historical `lineTotal` (already
   * `unitPrice × quantity − discountAmount`, server-computed at order
   * time), never the product's current price (directive's explicit "من
   * السعر التاريخي الفعلي في Sales Order الأصلي، مع مراعاة الخصومات").
   * Per-unit effective price × the quantity actually returned — proportional,
   * not the whole line, since a partial return is fully supported.
   */
  private async createReturnCreditForRequest(
    request: ReturnRequest,
    salesOrderLineId: string,
    actorUserId: string,
  ): Promise<ReturnCredit> {
    const line = await this.salesOrders.getOrderLineById(salesOrderLineId);
    if (!line) throw new NotFoundException(`Sales order line "${salesOrderLineId}" not found — cannot price the return credit.`);
    const order = await this.salesOrders.getOrderSnapshot(request.salesOrderId);
    if (!order) throw new NotFoundException(`Sales order "${request.salesOrderId}" not found.`);

    const perUnitEffectivePrice = Number(line.lineTotal) / line.quantity;
    const creditAmount = (perUnitEffectivePrice * request.quantity).toFixed(2);

    const repo = this.dataSource.getRepository(ReturnCredit);
    const credit = await repo.save(
      repo.create({
        returnRequestId: request.id,
        customerId: order.customerId,
        originalSalesOrderId: request.salesOrderId,
        originalAmount: creditAmount,
        usedAmount: '0.00',
        remainingAmount: creditAmount,
        status: 'active',
        appliedToSalesOrderId: null,
      }),
    );

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'return.credit_issued',
      resource: 'return_credit',
      resourceId: credit.id,
      result: 'success',
      correlationId: null,
      after: {
        returnRequestId: request.id,
        customerId: order.customerId,
        originalSalesOrderId: request.salesOrderId,
        amount: creditAmount,
      },
    });

    return credit;
  }

  /**
   * Returns Engine (CTO directive §6) — a credit is applied to exactly
   * ONE order at a time in this phase (disclosed scoping decision): the
   * target order must belong to the SAME customer the credit was issued
   * to, and must still be `draft` (mirrors `editDraftOrder`'s own
   * ownership+status discipline). Never lets `remainingAmount` go
   * negative or a `void`/`fully_used` credit be re-applied (§7/§8's "a
   * credit cannot be used more than once").
   */
  /**
   * Shared guard+decrement core for both credit-application paths
   * (`applyCreditToOrder` — a draft order — and `applyCreditToInvoice` —
   * a posted invoice's AR): active/positive-amount/sufficient-remaining/
   * same-customer, then decrements `usedAmount`/`remainingAmount` and
   * flips to `fully_used` at zero. Never lets `remainingAmount` go
   * negative or a `void`/`fully_used` credit be re-applied. The caller
   * still does its OWN target-specific check (draft order vs. posted
   * invoice) and sets the corresponding `appliedTo*` field before saving.
   */
  private async validateAndDecrementCreditAmount(
    creditId: string,
    requestedAmountStr: string,
    expectedCustomerId: string,
  ): Promise<{ credit: ReturnCredit; beforeUsed: string; beforeRemaining: string; requestedAmount: number }> {
    const repo = this.dataSource.getRepository(ReturnCredit);
    const credit = await repo.findOne({ where: { id: creditId } });
    if (!credit) throw new NotFoundException(`Return credit "${creditId}" not found.`);
    if (credit.status !== 'active') {
      throw new ConflictException(`Return credit "${creditId}" is not active (status "${credit.status}").`);
    }
    if (credit.customerId !== expectedCustomerId) {
      throw new ForbiddenException('This credit belongs to a different customer than the target.');
    }

    const requestedAmount = Number(requestedAmountStr);
    if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
      throw new BadRequestException('Amount to apply must be a positive number.');
    }
    if (requestedAmount > Number(credit.remainingAmount)) {
      throw new ConflictException(`Cannot apply ${requestedAmountStr} — only ${credit.remainingAmount} remains on this credit.`);
    }

    const beforeUsed = credit.usedAmount;
    const beforeRemaining = credit.remainingAmount;
    credit.usedAmount = (Number(credit.usedAmount) + requestedAmount).toFixed(2);
    credit.remainingAmount = (Number(credit.remainingAmount) - requestedAmount).toFixed(2);
    if (Number(credit.remainingAmount) <= 0) credit.status = 'fully_used';

    return { credit, beforeUsed, beforeRemaining, requestedAmount };
  }

  async applyCreditToOrder(creditId: string, salesOrderId: string, amount: string, actorUserId: string): Promise<ReturnCredit> {
    const order = await this.salesOrders.getOrder(salesOrderId, actorUserId);
    const orderStatus = await this.salesOrders.getOrderStatus(salesOrderId);
    if (orderStatus !== 'draft') {
      throw new ConflictException(`Credits can only be applied to a draft order (this order is "${orderStatus}").`);
    }

    const { credit, beforeUsed, beforeRemaining, requestedAmount } = await this.validateAndDecrementCreditAmount(creditId, amount, order.customerId);
    credit.appliedToSalesOrderId = salesOrderId;
    const saved = await this.dataSource.getRepository(ReturnCredit).save(credit);

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'return.credit_applied',
      resource: 'return_credit',
      resourceId: creditId,
      result: 'success',
      correlationId: null,
      before: { usedAmount: beforeUsed, remainingAmount: beforeRemaining },
      after: { usedAmount: saved.usedAmount, remainingAmount: saved.remainingAmount, appliedToSalesOrderId: salesOrderId, amountApplied: requestedAmount.toFixed(2) },
    });

    return saved;
  }

  /**
   * Customer Financial Account / AR (CTO directive §7) — the parallel
   * path: applying a Return Credit to an EXISTING posted Invoice's AR,
   * rather than a new draft order. Same guards as `applyCreditToOrder`
   * (via the shared `validateAndDecrementCreditAmount` helper — no
   * double-spend, no wrong-customer, no re-use past its balance), plus a
   * `CustomerLedgerEntry` (`return_credit_note`, credit) so the invoice's
   * own remaining balance and the customer's statement both reflect it.
   */
  async applyCreditToInvoice(creditId: string, invoiceId: string, amount: string, actorUserId: string): Promise<ReturnCredit> {
    const invoice = await this.invoices.getInvoice(invoiceId, actorUserId);
    if (invoice.state !== 'posted' && invoice.state !== 'partially_paid') {
      throw new ConflictException(`Credits can only be applied to a posted invoice (this invoice is "${invoice.state}").`);
    }

    const { credit, beforeUsed, beforeRemaining, requestedAmount } = await this.validateAndDecrementCreditAmount(creditId, amount, invoice.customerId);
    credit.appliedToInvoiceId = invoiceId;
    const saved = await this.dataSource.getRepository(ReturnCredit).save(credit);

    await this.customerLedger.postEntry({
      customerId: invoice.customerId,
      entryType: 'return_credit_note',
      direction: 'credit',
      amount: requestedAmount.toFixed(2),
      salesOrderId: invoice.salesOrderId,
      invoiceId,
      returnCreditId: creditId,
      reference: saved.id,
      reason: 'Return credit applied to invoice',
      createdByUserId: actorUserId,
    });
    await this.invoices.recomputeStatus(invoiceId, actorUserId);

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'return.credit_applied_to_invoice',
      resource: 'return_credit',
      resourceId: creditId,
      result: 'success',
      correlationId: null,
      before: { usedAmount: beforeUsed, remainingAmount: beforeRemaining },
      after: { usedAmount: saved.usedAmount, remainingAmount: saved.remainingAmount, appliedToInvoiceId: invoiceId, amountApplied: requestedAmount.toFixed(2) },
    });

    return saved;
  }

  /** Backs the SO-draft "Returns / Credits" panel — active (remainingAmount > 0) credits for a customer, enriched with their originating return's own number/product/quantity/type (directive §6's exact field list) via one small join, never a direct cross-domain query. */
  async listAvailableCredits(
    customerId: string,
  ): Promise<Array<ReturnCredit & { returnNumber: string | null; productId: string; quantity: number; returnType: ReturnType | null }>> {
    const credits = await this.dataSource
      .getRepository(ReturnCredit)
      .createQueryBuilder('c')
      .where('c.customerId = :customerId', { customerId })
      .andWhere('c.remainingAmount > 0')
      .orderBy('c.createdAt', 'ASC')
      .getMany();

    const requestIds = [...new Set(credits.map((c) => c.returnRequestId))];
    // Small N (this customer's own credited returns) — individual lookups, same
    // "N calls fine at V1 scale" precedent already used elsewhere in this codebase.
    const requestRepo = this.dataSource.getRepository(ReturnRequest);
    const requests = await Promise.all(requestIds.map((id) => requestRepo.findOne({ where: { id } })));
    const byId = new Map(requests.filter((r): r is ReturnRequest => !!r).map((r) => [r.id, r]));

    return credits.map((c) => {
      const r = byId.get(c.returnRequestId);
      return { ...c, returnNumber: r?.returnNumber ?? null, productId: r?.productId ?? '', quantity: r?.quantity ?? 0, returnType: r?.returnType ?? null };
    });
  }

  /**
   * ERP UI Integration (CTO directive) — the section-wide "Return Credits
   * المتاحة" KPI and a future all-customers credits screen. Same active-
   * credit query as `listAvailableCredits`, just Scope-filtered across
   * every customer the caller may see (via `CustomersService.listCustomers`)
   * instead of one customer — never a second independent query shape.
   */
  async listAllAvailableCredits(
    actorUserId: string,
  ): Promise<Array<ReturnCredit & { returnNumber: string | null; productId: string; quantity: number; returnType: ReturnType | null; customerCode: string; customerName: string }>> {
    const customers = await this.customers.listCustomers(actorUserId);
    const customerById = new Map(customers.map((c) => [c.id, c]));
    if (customerById.size === 0) return [];

    const credits = await this.dataSource
      .getRepository(ReturnCredit)
      .createQueryBuilder('c')
      .where('c."customerId" = ANY(:customerIds)', { customerIds: [...customerById.keys()] })
      .andWhere('c.remainingAmount > 0')
      .orderBy('c.createdAt', 'ASC')
      .getMany();

    const requestIds = [...new Set(credits.map((c) => c.returnRequestId))];
    const requestRepo = this.dataSource.getRepository(ReturnRequest);
    const requests = await Promise.all(requestIds.map((id) => requestRepo.findOne({ where: { id } })));
    const byId = new Map(requests.filter((r): r is ReturnRequest => !!r).map((r) => [r.id, r]));

    return credits.map((c) => {
      const r = byId.get(c.returnRequestId);
      const customer = customerById.get(c.customerId);
      return {
        ...c,
        returnNumber: r?.returnNumber ?? null,
        productId: r?.productId ?? '',
        quantity: r?.quantity ?? 0,
        returnType: r?.returnType ?? null,
        customerCode: customer?.code ?? '',
        customerName: customer?.name ?? '',
      };
    });
  }

  /** Cross-domain read for `CustomerAccountsService` (directive §7 — ERP/AR readiness) — the credit issued for a given return, if any (never issued for `exchange`). */
  async getCreditForReturnRequest(returnRequestId: string): Promise<ReturnCredit | null> {
    return this.dataSource.getRepository(ReturnCredit).findOne({ where: { returnRequestId } });
  }

  /** Cross-domain read for the upcoming Customer Financial Account/AR phase — a single credit by id, needed to price/validate an `applyCreditToInvoice` call. */
  async getCreditById(creditId: string): Promise<ReturnCredit | null> {
    return this.dataSource.getRepository(ReturnCredit).findOne({ where: { id: creditId } });
  }

  async getStatus(returnRequestId: string): Promise<string> {
    return this.processEngine.getState(RETURN_PROCESS, ENTITY_TYPE, returnRequestId);
  }

  /** Backs the Return print document — single-request read with state, didn't exist before (only list + bare status existed). */
  async getReturnRequest(returnRequestId: string): Promise<ReturnRequest & { state: string }> {
    const request = await this.dataSource.getRepository(ReturnRequest).findOneOrFail({ where: { id: returnRequestId } });
    const state = await this.getStatus(returnRequestId);
    return { ...request, state };
  }
}
