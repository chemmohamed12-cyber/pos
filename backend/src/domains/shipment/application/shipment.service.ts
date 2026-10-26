import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { DataSource, EntityManager, FindOptionsWhere } from 'typeorm';
import { Shipment } from '../infrastructure/shipment.entity';
import { ShipmentLine } from '../infrastructure/shipment-line.entity';
import { TrackingEvent } from '../infrastructure/tracking-event.entity';
import { ShippingCompany } from '../infrastructure/shipping-company.entity';
import { Vehicle } from '../infrastructure/vehicle.entity';
import { SHIPMENT_PROCESS } from '../domain/shipment-process';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { AuthorizationService } from '../../../foundation/authorization/authorization.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { runInTransaction } from '../../../foundation/transaction/run-in-transaction';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import {
  INVENTORY_LOGISTICS_CONTRACT,
  InventoryLogisticsContract,
  FULFILLMENT_CONTRACT,
  FulfillmentContract,
} from '../../../foundation/module-registry/contracts/inventory.contract';
import { FINANCE_TREASURY_CONTRACT, FinanceTreasuryContract } from '../../../foundation/module-registry/contracts/finance.contract';
import {
  SALES_ORDERS_READ_CONTRACT,
  SalesOrdersReadContract,
  SALES_CUSTOMERS_CONTRACT,
  SalesCustomersContract,
} from '../../../foundation/module-registry/contracts/sales.contract';
import { LogisticsShipmentContract } from '../../../foundation/module-registry/contracts/logistics.contract';
import { UsersService } from '../../../foundation/identity/users.service';

const ENTITY_TYPE = 'shipment';
const DRIVER_ACTIONS = new Set(['pickup', 'depart', 'arrive_for_delivery', 'deliver', 'fail_delivery']);
const CUSTODY_ACCOUNT_TYPE_CODE = 'custody';
const SHIPPING_ORDER_DOCUMENT_TYPE = 'shipping_order';

@Injectable()
export class ShipmentService implements OnModuleInit, LogisticsShipmentContract {
  constructor(
    private readonly dataSource: DataSource,
    private readonly numbering: NumberingService,
    private readonly processEngine: ProcessEngineService,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditService,
    private readonly events: EventBusService,
    @Inject(INVENTORY_LOGISTICS_CONTRACT) private readonly inventory: InventoryLogisticsContract,
    @Inject(FULFILLMENT_CONTRACT) private readonly fulfillment: FulfillmentContract,
    @Inject(FINANCE_TREASURY_CONTRACT) private readonly treasury: FinanceTreasuryContract,
    @Inject(SALES_ORDERS_READ_CONTRACT) private readonly salesOrders: SalesOrdersReadContract,
    @Inject(SALES_CUSTOMERS_CONTRACT) private readonly customers: SalesCustomersContract,
    private readonly users: UsersService,
  ) {}

  /**
   * RSH Shipping Orders (CTO directive §3) — the moment a Sales Order
   * reaches Ready-for-Shipping (its Pack Task closes), `FulfillmentService.
   * transitionPackTask` publishes `fulfillment.ready-for-dispatch` and
   * flushes it via `dispatchPending()` in the same request. This
   * subscription is what actually turns that (previously undelivered)
   * event into a real Shipping Order — same registration pattern as
   * `IntegrationsService.onModuleInit` (`commerce.product.created` etc.).
   * No try/catch here: a throwing handler is exactly what
   * `EventBusService.dispatchPending`'s own retry loop is designed to
   * catch and re-attempt — `createShipment`'s own duplicate guard below
   * is what makes a retry safe rather than a source of duplicates.
   */
  onModuleInit(): void {
    // ADR-075 (D10): Company-scope — the handoff runs against the Company whose outbox carried the event.
    this.events.subscribe(
      'fulfillment.ready-for-dispatch',
      async (payload, ctx) => {
        await this.createShipment(payload.fulfillmentOrderId as string, null, null, null, null, ctx.manager ?? undefined);
      },
      { scope: 'company' },
    );
  }

  /**
   * Resolves the 'custody' Treasury Account Type's id (CTO directive §6 —
   * a custody account is explicitly NOT a normal cash account; seeded
   * once via migration `SeedTreasuryCustodyAccountType`, same reuse
   * discipline as the existing `bank`/`cash`/`wallet` types — never a new
   * Treasury Core concept). Looked up by code every call rather than
   * cached — company/vehicle creation is rare, not a hot path.
   */
  private async getCustodyAccountTypeId(manager?: EntityManager): Promise<string> {
    const types = await this.treasury.listAccountTypes(manager);
    const custodyType = types.find((t) => t.code === CUSTODY_ACCOUNT_TYPE_CODE);
    if (!custodyType) {
      throw new ConflictException(`Treasury account type "${CUSTODY_ACCOUNT_TYPE_CODE}" is not provisioned — run the seed migration first.`);
    }
    return custodyType.id;
  }

  /** The default parent for an auto-created Operational Sub-location — the first active top-level ('main') warehouse, unless the caller names one explicitly. */
  private async resolveParentWarehouseId(explicit: string | null, manager?: EntityManager): Promise<string> {
    if (explicit) return explicit;
    const warehouses = await this.inventory.listWarehouses(manager);
    const mainWarehouse = warehouses.find((w) => w.kind === 'main' && w.status === 'active');
    if (!mainWarehouse) {
      throw new ConflictException('No active main warehouse exists to nest an Operational Sub-location under — create one first.');
    }
    return mainWarehouse.id;
  }

  /**
   * Provisions the two Operational Custodian resources every Shipping
   * Company/Vehicle needs (CTO directive §4/§6). REAL BUG FOUND LIVE
   * (E2E verification, not the unit tests, which never exercised a
   * realistically-long code): naming the sub-location/custody-account
   * codes off the custodian's OWN code (e.g. `${code}-LOC`,
   * `CUSTODY-${code}`) silently overflowed `warehouses.code`/
   * `treasury_accounts.code`'s `varchar(32)` column the moment a
   * custodian code got anywhere near that length — a 500 on creation,
   * not a validation error. Fixed by generating both codes through the
   * Numbering Engine (same short, collision-free, length-bounded codes
   * every other document in this codebase already uses), never string
   * concatenation off caller-supplied input.
   */
  private async provisionCustodianResources(
    displayName: string,
    parentWarehouseId: string,
    driverUserId: string | null,
    actorUserId: string,
    manager?: EntityManager,
    /** Org engine Stage 2 — the custodian's branch, inherited by its custody sub-location and custody treasury account. */
    orgUnitId: string | null = null,
  ): Promise<{ warehouseId: string; custodyAccountId: string }> {
    await this.numbering.registerDocumentType('shipping_sub_location', 'SLOC', false, manager);
    await this.numbering.registerDocumentType('shipping_custody_account', 'CUST', false, manager);
    const warehouseCode = await this.numbering.getNextNumber('shipping_sub_location', manager);
    const custodyCode = await this.numbering.getNextNumber('shipping_custody_account', manager);

    const warehouse = await this.inventory.createWarehouse(warehouseCode, displayName, null, driverUserId, parentWarehouseId, 'operational', manager, orgUnitId);
    const custodyAccount = await this.treasury.createAccount(custodyCode, `${displayName} — عهدة`, await this.getCustodyAccountTypeId(manager), actorUserId, manager, orgUnitId);
    return { warehouseId: warehouse.id, custodyAccountId: custodyAccount.id };
  }

  /**
   * `shippingCompanyId`/`codAmount`/`vehicleId` optional and appended
   * last (backward compatible with the existing in-house-driver flow,
   * which passes none) — CTO directive: a shipment MAY route through a
   * third-party shipping company and/or a specific Company Vehicle, with
   * an expected COD amount, instead of (or as well as) an internal
   * driver.
   *
   * RSH Shipping Orders (CTO directive §3) — every new Shipment IS the
   * "Shipping Order" the directive asks to auto-create at Ready-for-
   * Shipping; this method is now called both manually (the pre-existing
   * admin UI flow, kept as a defensive fallback) and automatically (this
   * service's own `onModuleInit` subscriber, the moment a Pack Task
   * closes). Generates a real `RSH-YYYY-NNNNNN` number and resolves/
   * snapshots the owning Sales Order's id + number — "مرتبط مباشرة
   * بالـSales Order" (directly linked), not just reachable via the
   * `fulfillmentOrderId` chain. The duplicate guard below is what makes
   * it safe for BOTH callers (a human retrying the old manual form, or
   * the event-bus retrying a failed handler) to never produce two
   * Shipping Orders for the same Fulfillment Order.
   */
  async createShipment(
    fulfillmentOrderId: string,
    actorUserId: string | null,
    shippingCompanyId: string | null = null,
    codAmount: string | null = null,
    vehicleId: string | null = null,
    manager?: EntityManager,
  ): Promise<Shipment> {
    const existing = await (manager ?? this.dataSource).getRepository(Shipment).findOne({ where: { fulfillmentOrderId } });
    if (existing) {
      throw new ConflictException(`A shipment already exists for fulfillment order "${fulfillmentOrderId}" (${existing.rshNumber ?? existing.id}).`);
    }
    if (shippingCompanyId) {
      const company = await this.getShippingCompany(shippingCompanyId, manager);
      if (company.status !== 'active') {
        throw new ConflictException(`Shipping company "${company.name}" is inactive.`);
      }
    }
    if (vehicleId) {
      const vehicle = await this.getVehicle(vehicleId, manager);
      if (vehicle.status !== 'active') {
        throw new ConflictException(`Vehicle "${vehicle.code}" is retired.`);
      }
    }
    const fulfillmentOrder = await this.fulfillment.getFulfillmentOrder(fulfillmentOrderId, manager);
    const orderSnapshot = await this.salesOrders.getOrderSnapshot(fulfillmentOrder.salesOrderId, manager);

    const waybillNumber = await this.numbering.getNextNumber('shipment', manager);
    await this.numbering.registerDocumentType(SHIPPING_ORDER_DOCUMENT_TYPE, 'RSH', true, manager); // idempotent
    const rshNumber = await this.numbering.getNextNumber(SHIPPING_ORDER_DOCUMENT_TYPE, manager);

    const shipment = await (manager ?? this.dataSource).transaction(async (txManager) => {
      const repo = txManager.getRepository(Shipment);
      const saved = await repo.save(
        repo.create({
          fulfillmentOrderId,
          waybillNumber,
          driverUserId: null,
          shippingCompanyId,
          codAmount,
          vehicleId,
          rshNumber,
          salesOrderId: fulfillmentOrder.salesOrderId,
          branchOrgUnitId: orderSnapshot?.branchOrgUnitId ?? null, // Org engine Stage 5 — inherited from the sales order
          salesOrderNumber: orderSnapshot?.orderNumber ?? null,
          salesRepUserId: orderSnapshot?.salesRepUserId ?? null,
        }),
      );

      // Sales/Shipment/Returns workflow review (CTO directive, 2026-09-16):
      // freeze what's actually being shipped NOW, once, instead of letting
      // every future read re-derive "contents" live from StockReservation
      // (which drifts if the order's reservations change later, and has no
      // price/lineTotal fields at all — see ShipmentLine's own doc comment).
      // Matched by productId: an order with the SAME product on two lines
      // is a known, pre-existing ambiguity in this codebase (returns.service.ts
      // has the identical caveat for the same reason) — the first matching
      // unconsumed line is used, never split heuristically.
      const orderLines = await this.salesOrders.getOrderLines(fulfillmentOrder.salesOrderId, txManager);
      const reservations = await this.inventory.getActiveReservationsForOrder(fulfillmentOrder.salesOrderId, txManager);
      const consumedLineIds = new Set<string>();
      const lineRepo = txManager.getRepository(ShipmentLine);
      for (const reservation of reservations) {
        const orderLine = orderLines.find((l) => l.productId === reservation.productId && !consumedLineIds.has(l.id));
        if (!orderLine) continue; // no matching order line to snapshot a price from — nothing to freeze
        consumedLineIds.add(orderLine.id);
        const quantity = reservation.quantity;
        const unitPrice = orderLine.unitPrice;
        await lineRepo.save(
          lineRepo.create({
            shipmentId: saved.id,
            salesOrderLineId: orderLine.id,
            productId: reservation.productId,
            quantity,
            unitPrice,
            lineTotal: (Number(unitPrice) * quantity).toFixed(2),
          }),
        );
      }

      await this.events.publish(txManager, 'shipment.created', { shipmentId: saved.id, waybillNumber, rshNumber, fulfillmentOrderId });
      return saved;
    });

    await this.processEngine.start(SHIPMENT_PROCESS, ENTITY_TYPE, shipment.id, manager);
    await this.recordTrackingEvent(shipment.id, 'created', `Waybill ${waybillNumber} created.`, manager);

    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'shipment.created',
        resource: 'shipment',
        resourceId: shipment.id,
        result: 'success',
        correlationId: null,
        after: { waybillNumber, rshNumber, fulfillmentOrderId, salesOrderId: fulfillmentOrder.salesOrderId },
      },
      manager,
    );

    return shipment;
  }

  /**
   * RSH Shipping Orders (CTO directive §3) — backs the Sales Order detail screen's "does this
   * order have an RSH yet" check. AUDIT-SEC-03 remediation: previously took no `actorUserId` and
   * had no Scope check at all — any authenticated user with the `logistics` module entitled could
   * enumerate `salesOrderId`s and read a full Shipment record (salesRepUserId, codAmount included)
   * for an order outside their own Scope. Delegates to the Sales Order's own already-Scope-checked
   * `getOrder`, same "parent" derivation idiom every other cross-domain read in this codebase uses.
   */
  async getShipmentBySalesOrderId(salesOrderId: string, actorUserId: string, manager?: EntityManager): Promise<Shipment | null> {
    await this.salesOrders.getOrder(salesOrderId, actorUserId, manager);
    return (manager ?? this.dataSource).getRepository(Shipment).findOne({ where: { salesOrderId } });
  }

  async assignDriver(shipmentId: string, driverUserId: string, actorUserId: string, manager?: EntityManager): Promise<string> {
    const access = await this.authorization.workflowAccess(actorUserId, manager);
    if (!access.allows('logistics.shipment.assign_driver')) {
      throw new ForbiddenException('Only a dispatcher/admin may assign a driver to a shipment.');
    }
    const repo = (manager ?? this.dataSource).getRepository(Shipment);
    const shipment = await repo.findOne({ where: { id: shipmentId } });
    if (!shipment) throw new NotFoundException(`Shipment "${shipmentId}" not found.`);

    shipment.driverUserId = driverUserId;
    await repo.save(shipment);

    await this.processEngine.transition(SHIPMENT_PROCESS, ENTITY_TYPE, shipmentId, 'assign_driver', actorUserId, manager);
    await this.recordTrackingEvent(shipmentId, 'assigned', `Assigned to driver ${driverUserId}.`, manager);
    return this.processEngine.getState(SHIPMENT_PROCESS, ENTITY_TYPE, shipmentId, manager);
  }

  /**
   * Shipping Screen Redesign directive §3 — "SHIPPING ASSIGNMENT". RSH
   * Shipping Orders now auto-create the moment a Pack Task closes
   * (`onModuleInit` above), always with `shippingCompanyId`/`vehicleId`
   * null — there was previously NO way to set either afterward; the only
   * place they could ever be set was `createShipment`'s own parameters,
   * which auto-creation always calls with both null. This closes that
   * real gap: an operator can now assign — or, before custody has
   * physically transferred, reassign — a shipment's route to a shipping
   * company or a company vehicle (never both), fully audited (before/
   * after/actor/reason). Once `pickup` has been confirmed the route is
   * locked — the goods have already physically left custody by then, so
   * retroactively changing who they're "routed through" would misstate
   * where they actually are (same "state gate" pattern `transitionShipment`
   * already uses for the waybill-required check).
   */
  async assignShippingRoute(
    shipmentId: string,
    shippingCompanyId: string | null,
    vehicleId: string | null,
    actorUserId: string,
    reason: string | null = null,
    manager?: EntityManager,
  ): Promise<Shipment> {
    const access = await this.authorization.workflowAccess(actorUserId, manager);
    if (!access.allows('logistics.shipment.set_route')) {
      throw new ForbiddenException('Only a dispatcher/admin may assign or change a shipment\'s shipping route.');
    }
    if (shippingCompanyId && vehicleId) {
      throw new BadRequestException('A shipment is routed through a shipping company or a vehicle, never both.');
    }

    const repo = (manager ?? this.dataSource).getRepository(Shipment);
    const shipment = await repo.findOne({ where: { id: shipmentId } });
    if (!shipment) throw new NotFoundException(`Shipment "${shipmentId}" not found.`);

    const state = await this.processEngine.getState(SHIPMENT_PROCESS, ENTITY_TYPE, shipmentId, manager);
    if (state !== 'created' && state !== 'assigned') {
      throw new ConflictException(
        `Cannot change shipment "${shipmentId}"'s shipping route once pickup has been confirmed (current state: "${state}") — custody has already transferred.`,
      );
    }

    if (shippingCompanyId) {
      const company = await this.getShippingCompany(shippingCompanyId, manager);
      if (company.status !== 'active') throw new ConflictException(`Shipping company "${company.name}" is inactive.`);
    }
    if (vehicleId) {
      const vehicle = await this.getVehicle(vehicleId, manager);
      if (vehicle.status !== 'active') throw new ConflictException(`Vehicle "${vehicle.code}" is retired.`);
    }

    const before = { shippingCompanyId: shipment.shippingCompanyId, vehicleId: shipment.vehicleId };
    shipment.shippingCompanyId = shippingCompanyId;
    shipment.vehicleId = vehicleId;
    const saved = await repo.save(shipment);

    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'shipment.route_assigned',
        resource: 'shipment',
        resourceId: shipmentId,
        result: 'success',
        correlationId: null,
        before,
        after: { shippingCompanyId, vehicleId, reason },
      },
      manager,
    );
    await this.recordTrackingEvent(
      shipmentId,
      'route_assigned',
      shippingCompanyId ? `Routed to shipping company ${shippingCompanyId}.` : vehicleId ? `Routed to vehicle ${vehicleId}.` : 'Route cleared.',
      manager,
    );

    return saved;
  }

  /**
   * CTO directive ("Shipping Company waybill-required flow") — records the
   * shipping company's own physical waybill number and a photo of it
   * (already-uploaded via the generic `POST /media/upload`, referenced
   * here only by id — this service never touches file bytes). Either
   * value may be set alone (e.g. the number is known before the photo is
   * uploaded) and updated again later; `transitionShipment`'s `pickup`
   * gate is what actually enforces both being present, not this setter.
   * Same driver-or-admin scope as every other per-shipment action a
   * driver performs (`assertDriverOrAdmin`) — the driver is who's
   * physically standing at the company's counter receiving the document.
   */
  async setCarrierWaybill(
    shipmentId: string,
    carrierWaybillNumber: string | null,
    waybillImageMediaAssetId: string | null,
    actorUserId: string,
    carrierContactPhone: string | null = null,
    manager?: EntityManager,
  ): Promise<Shipment> {
    await this.assertDriverOrAdmin(shipmentId, actorUserId, manager);
    const repo = (manager ?? this.dataSource).getRepository(Shipment);
    const shipment = await repo.findOne({ where: { id: shipmentId } });
    if (!shipment) throw new NotFoundException(`Shipment "${shipmentId}" not found.`);

    // REAL BUG FOUND LIVE (E2E, not the unit tests): an empty string is
    // not `null`, so `!== null` let it through to `repo.save`, which then
    // failed with a raw Postgres "invalid input syntax for type uuid"
    // (waybillImageMediaAssetId is a UUID column) instead of a clean 400 —
    // a caller sending `""` (a real possibility: `@IsString()` alone
    // accepts an empty string) crashed with a 500. Truthy checks treat an
    // empty/whitespace-only value the same as "not provided", matching
    // every other optional-field setter in this codebase.
    const before = {
      carrierWaybillNumber: shipment.carrierWaybillNumber,
      waybillImageMediaAssetId: shipment.waybillImageMediaAssetId,
      carrierContactPhone: shipment.carrierContactPhone,
    };
    if (carrierWaybillNumber?.trim()) shipment.carrierWaybillNumber = carrierWaybillNumber.trim();
    if (waybillImageMediaAssetId?.trim()) shipment.waybillImageMediaAssetId = waybillImageMediaAssetId.trim();
    if (carrierContactPhone?.trim()) shipment.carrierContactPhone = carrierContactPhone.trim();
    const saved = await repo.save(shipment);

    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'shipment.carrier_waybill.set',
        resource: 'shipment',
        resourceId: shipmentId,
        result: 'success',
        correlationId: null,
        before,
        after: {
          carrierWaybillNumber: saved.carrierWaybillNumber,
          waybillImageMediaAssetId: saved.waybillImageMediaAssetId,
          carrierContactPhone: saved.carrierContactPhone,
        },
      },
      manager,
    );

    return saved;
  }

  /** Shared by transitionShipment and Delivery's recordCollection (V1 Release Audit MEDIUM fix — collection recording had no check at all). Driver ACTIONS only (pickup/depart/.../setCarrierWaybill/recordCollection) — never widen this to `finance` (see `assertCanReadShipment` below for the read-only counterpart). */
  async assertDriverOrAdmin(shipmentId: string, actorUserId: string, manager?: EntityManager): Promise<void> {
    const shipment = await (manager ?? this.dataSource).getRepository(Shipment).findOne({ where: { id: shipmentId } });
    if (!shipment) throw new NotFoundException(`Shipment "${shipmentId}" not found.`);
    const access = await this.authorization.workflowAccess(actorUserId, manager);
    const isAssignedDriver = shipment.driverUserId === actorUserId;
    const isAdmin = access.allows('logistics.shipment.act_any');
    if (!isAssignedDriver && !isAdmin) {
      throw new ForbiddenException('Only the assigned driver (or an admin) may act on this shipment.');
    }
  }

  /**
   * REAL BUG FOUND LIVE (Returns/Custody-Settlement E2E verification) —
   * `getShipment`'s own IDOR fix (driver-or-admin only, see its doc
   * comment) never anticipated a `finance` caller: `CollectionReceiptPrint.tsx`
   * (this session's own new Collection Receipt print page) calls
   * `GET /shipments/:id` to enrich the receipt with the waybill/RSH/SO
   * number, and 403'd for `fin1` — the exact role
   * `GET /delivery/collections/by-shipment/:shipmentId` and
   * `POST /delivery/collections/:id/remit` are `@RequireRole`-gated to.
   * Deliberately a SEPARATE helper from `assertDriverOrAdmin` above, not
   * a widening of it: that one guards driver ACTIONS (pickup, depart,
   * carrier-waybill, recordCollection) where letting `finance` through
   * would be a real privilege escalation, not a fix. This one only ever
   * backs a read.
   */
  private async assertCanReadShipment(shipmentId: string, actorUserId: string, manager?: EntityManager): Promise<Shipment> {
    const shipment = await (manager ?? this.dataSource).getRepository(Shipment).findOne({ where: { id: shipmentId } });
    if (!shipment) throw new NotFoundException(`Shipment "${shipmentId}" not found.`);
    const access = await this.authorization.workflowAccess(actorUserId, manager);
    const isAssignedDriver = shipment.driverUserId === actorUserId;
    const isReviewer = access.allows('logistics.shipment.read_any');
    if (!isAssignedDriver && !isReviewer) {
      throw new ForbiddenException('Only the assigned driver (or an admin/finance user) may view this shipment.');
    }
    return shipment;
  }

  /**
   * Gap Resolution Package 3 (2026-09-14, row 37) — `manager?` added so `DeliveryService.recordOutcome`
   * can make the shipment's own state transition part of its one atomic operation.
   *
   * Area 21 Operational Company Scoping Retrofit (2026-09-27): the prior version of this doc comment
   * said `manager` was deliberately NOT threaded into `transferCustodyOnPickup` (the `pickup`-only
   * branch) — that was an ATOMICITY decision (no current caller combined a supplied `manager` with
   * `action === 'pickup'`), unrelated to Company-routing. Area 21 requires every nested call to
   * resolve the correct Company regardless of atomicity concerns, so `transferCustodyOnPickup` (and
   * `InventoryService.relocateReservedStock`, which already accepts `manager?`) now both receive it.
   */
  async transitionShipment(shipmentId: string, action: string, actorUserId: string, manager?: EntityManager): Promise<string> {
    // V1 Release Audit MEDIUM fix — default-deny: an action absent from
    // DRIVER_ACTIONS (e.g. 'return_to_sender', 'retry') used to skip the
    // assigned-driver/admin check entirely instead of being rejected,
    // letting any authenticated user transition someone else's shipment.
    if (!DRIVER_ACTIONS.has(action)) {
      const access = await this.authorization.workflowAccess(actorUserId, manager);
      if (!access.allows('logistics.shipment.manage_non_driver_actions')) {
        throw new ForbiddenException(`Role required for action "${action}": admin.`);
      }
    } else {
      await this.assertDriverOrAdmin(shipmentId, actorUserId, manager);
    }

    // CTO directive ("Shipping Company waybill-required flow") — block
    // CONFIRMING dispatch (the `pickup` transition — the same real-world
    // moment custody actually leaves the warehouse, see `transferCustodyOnPickup`
    // below) to a third-party shipping company until its own physical
    // waybill number AND a photo of it are on file. Checked BEFORE the
    // Process Engine transition fires, so a rejected pickup never leaves
    // the shipment mid-transition. Doesn't apply when there's no
    // `shippingCompanyId` at all (a plain in-house driver delivery has no
    // carrier waybill to begin with).
    if (action === 'pickup') {
      const shipment = await (manager ?? this.dataSource).getRepository(Shipment).findOne({ where: { id: shipmentId } });
      if (shipment?.shippingCompanyId && (!shipment.carrierWaybillNumber || !shipment.waybillImageMediaAssetId)) {
        throw new BadRequestException(
          'Cannot confirm pickup for a shipment routed through a shipping company without its carrier waybill number and a photo of it — set both first.',
        );
      }
    }

    const run = async (m: EntityManager): Promise<string> => {
      await this.processEngine.transition(SHIPMENT_PROCESS, ENTITY_TYPE, shipmentId, action, actorUserId, m);
      const newState = await this.processEngine.getState(SHIPMENT_PROCESS, ENTITY_TYPE, shipmentId, m);
      await this.recordTrackingEvent(shipmentId, action, `Status: ${newState}`, m);

      // CTO directive §5 — Chain of Custody: the real-world moment goods
      // leave the warehouse's custody and enter the driver/vehicle/
      // company's is pickup, not shipment creation (before pickup the
      // goods are still physically sitting in the warehouse).
      if (action === 'pickup') {
        await this.transferCustodyOnPickup(shipmentId, actorUserId, m);
      }

      if (newState === 'delivered' || newState === 'failed' || newState === 'returned') {
        await this.events.publish(m, `shipment.${newState}`, { shipmentId });
      }

      return newState;
    };

    // WP-INV-10 (H5-D1): a plain manager (the controller passes the Company DataSource's manager) used to run every step as its own auto-committed statement, so a failing
    // custody transfer left the shipment `picked_up` with a reservation drained and not re-created. The whole unit is now one transaction; a caller's transaction is joined.
    return runInTransaction(this.dataSource, manager, run);
  }

  /**
   * Backs the Shipments operational screen — a driver sees only
   * shipments assigned to them (the actual per-resource `driverUserId`
   * assignment, not a Scope lookup); admin sees the full dispatch board.
   * `warehouse_worker` added for the same reason as `SalesOrdersService.
   * listOrders`/`getOrder` (CTO directive — Fulfillment dashboard): a
   * fulfillment operator needs to know whether a "ready for shipping"
   * order has ALREADY been shipped, or the dashboard bucket it belongs
   * in never advances past that stage.
   */
  async listShipments(
    actorUserId: string,
    manager?: EntityManager,
  ): Promise<Array<Shipment & { state: string; customerName: string | null; governorate: string | null; totalAmount: string | null; salesRepName: string | null }>> {
    const access = await this.authorization.workflowAccess(actorUserId, manager);
    const repo = (manager ?? this.dataSource).getRepository(Shipment);
    const shipments = access.allows('logistics.shipment.board_all')
      ? await repo.find({ order: { createdAt: 'DESC' } })
      : await repo.find({ where: { driverUserId: actorUserId }, order: { createdAt: 'DESC' } });
    const repNameById = await this.buildUserNameMap();
    return Promise.all(shipments.map((s) => this.enrichForBoard(s, repNameById, manager)));
  }

  /**
   * Warehouse / Shipment Operations Requirement (Historical Requirements
   * Audit, 2026-09-17) — a dispatch/shipping warehouse's primary
   * operating unit is the SHIPMENT (customer/order/total/governorate/
   * rep/status), not the SKU. `Shipment` already snapshots
   * `salesOrderNumber`/`salesRepUserId` at creation (avoids a live
   * cross-domain read); this adds the 4 remaining board fields the SAME
   * way `getShipmentDetail` and `ShipmentReturnsService.
   * listShipmentReturns` already resolve cross-domain display data — one
   * `getOrderSnapshot` + one `getCustomerSnapshot` call per row, both
   * already-injected lightweight read contracts, never a live SQL join
   * and never business logic reconstructed in the frontend. `salesRepName`
   * is resolved from a name map built ONCE per list call (`GET /admin/
   * users` is `admin`-only, so `warehouse_worker` — the board's other
   * intended viewer — could never resolve it client-side; `UsersService`
   * itself has no permission gate, only its controller does, so calling
   * it directly here is the same "service-to-service, not controller-to-
   * controller" precedent every other foundation dependency in this class
   * already uses). Legacy shipments with no `salesOrderId` (pre-dating
   * the CTO directive that added it) degrade to null, same precedent as
   * every other additive field in this entity.
   */
  private async enrichForBoard(
    s: Shipment,
    repNameById: Map<string, string>,
    manager?: EntityManager,
  ): Promise<Shipment & { state: string; customerName: string | null; governorate: string | null; totalAmount: string | null; salesRepName: string | null }> {
    const state = await this.processEngine.getState(SHIPMENT_PROCESS, ENTITY_TYPE, s.id, manager);
    const salesRepName = s.salesRepUserId ? repNameById.get(s.salesRepUserId) ?? null : null;
    if (!s.salesOrderId) return { ...s, state, customerName: null, governorate: null, totalAmount: null, salesRepName };
    const order = await this.salesOrders.getOrderSnapshot(s.salesOrderId, manager);
    if (!order) return { ...s, state, customerName: null, governorate: null, totalAmount: null, salesRepName };
    const customer = await this.customers.getCustomerSnapshot(order.customerId, manager);
    return {
      ...s,
      state,
      customerName: customer?.name ?? null,
      governorate: customer?.governorate ?? null,
      totalAmount: order.totalAmount,
      salesRepName,
    };
  }

  private async buildUserNameMap(): Promise<Map<string, string>> {
    const all = await this.users.listAll();
    return new Map(all.map((u) => [u.id, u.fullName]));
  }

  /**
   * Paginated sibling of `listShipments` above — same role/driver-scoped
   * `where` clause, `take`/`skip` + a matching `count()` for `total`.
   * Following the exact `?page=&pageSize=` contract already live on
   * `InventoryController.warehouseInventory`/Customers/SalesOrders/
   * WarehouseTransactions (`MASTER_PROJECT_STATUS.md` §6 pagination
   * audit) — `listShipments` itself is left untouched since it has no
   * other internal caller today (grepped: only its own controller route
   * and spec), so there's no full-set consumer to preserve, but keeping
   * both methods matches the established pattern instead of adding an
   * optional-params branch to the existing one.
   */
  async listShipmentsPage(
    actorUserId: string,
    options: { page: number; pageSize: number },
    manager?: EntityManager,
  ): Promise<{
    rows: Array<Shipment & { state: string; customerName: string | null; governorate: string | null; totalAmount: string | null; salesRepName: string | null }>;
    total: number;
  }> {
    const access = await this.authorization.workflowAccess(actorUserId, manager);
    const repo = (manager ?? this.dataSource).getRepository(Shipment);
    const isBoardViewer = access.allows('logistics.shipment.board_all');
    const where = isBoardViewer ? {} : { driverUserId: actorUserId };
    const skip = (options.page - 1) * options.pageSize;

    const [shipments, total] = await repo.findAndCount({ where, order: { createdAt: 'DESC' }, take: options.pageSize, skip });
    const repNameById = await this.buildUserNameMap();
    const rows = await Promise.all(shipments.map((s) => this.enrichForBoard(s, repNameById, manager)));
    return { rows, total };
  }

  async getShipmentByFulfillmentOrderId(fulfillmentOrderId: string, manager?: EntityManager): Promise<Shipment | null> {
    return (manager ?? this.dataSource).getRepository(Shipment).findOne({ where: { fulfillmentOrderId } });
  }

  /**
   * Backs the Waybill/Delivery print documents (and, since this session,
   * `CollectionReceiptPrint.tsx`) — single-shipment read. V1 Release
   * Audit MEDIUM fix (IDOR): unlike listShipments, this had no assigned-
   * driver/admin check, so any authenticated user could read any
   * shipment by guessing/enumerating ids. Drivers only ever reach this
   * with their own shipment's id (obtained from their own filtered
   * list), so this doesn't change legitimate usage. Uses
   * `assertCanReadShipment` (admin/finance/assigned-driver), not
   * `assertDriverOrAdmin` — see that method's own comment for why the
   * two are deliberately separate.
   */
  async getShipment(shipmentId: string, actorUserId: string, manager?: EntityManager): Promise<Shipment & { state: string }> {
    const shipment = await this.assertCanReadShipment(shipmentId, actorUserId, manager);
    const state = await this.processEngine.getState(SHIPMENT_PROCESS, ENTITY_TYPE, shipmentId, manager);
    return { ...shipment, state };
  }

  /**
   * Sales/Shipment/Returns workflow review (CTO directive, 2026-09-16) —
   * closes the RBW finding that no single endpoint assembled the
   * directive's "shipment detail screen" fields (customer/address/phone/
   * governorate/order total/carrier/line items). Joins across the exact
   * contracts already injected into this service — no new cross-domain
   * mechanism. `salesRepUserId`/`driverUserId` are returned as raw ids:
   * there is no `USERS_CONTRACT` anywhere in this codebase to resolve a
   * display name from a user id (grepped, confirmed absent) — disclosed
   * gap, not silently worked around with a direct cross-domain query.
   */
  async getShipmentDetail(shipmentId: string, actorUserId: string, manager?: EntityManager): Promise<{
    shipment: Shipment & { state: string };
    customer: { id: string; name: string; phone: string | null; address: string | null; governorate: string | null } | null;
    orderTotalAmount: string | null;
    carrier: { type: 'company' | 'vehicle' | null; id: string | null; name: string | null };
    lines: Array<{ id: string; productId: string; quantity: number; unitPrice: string; lineTotal: string; salesOrderLineId: string }>;
  }> {
    const shipmentWithState = await this.getShipment(shipmentId, actorUserId, manager);
    const orderSnapshot = shipmentWithState.salesOrderId ? await this.salesOrders.getOrderSnapshot(shipmentWithState.salesOrderId, manager) : null;
    const customer = orderSnapshot ? await this.customers.getCustomerSnapshot(orderSnapshot.customerId, manager) : null;
    const orderTotalAmount = orderSnapshot?.totalAmount ?? null;

    let carrier: { type: 'company' | 'vehicle' | null; id: string | null; name: string | null } = { type: null, id: null, name: null };
    if (shipmentWithState.vehicleId) {
      const vehicle = await this.getVehicle(shipmentWithState.vehicleId, manager);
      carrier = { type: 'vehicle', id: vehicle.id, name: vehicle.plateNumber };
    } else if (shipmentWithState.shippingCompanyId) {
      const company = await this.getShippingCompany(shipmentWithState.shippingCompanyId, manager);
      carrier = { type: 'company', id: company.id, name: company.name };
    }

    const lines = await (manager ?? this.dataSource).getRepository(ShipmentLine).find({ where: { shipmentId } });

    return {
      shipment: shipmentWithState,
      customer,
      orderTotalAmount,
      carrier,
      lines: lines.map((l) => ({
        id: l.id,
        productId: l.productId,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        lineTotal: l.lineTotal,
        salesOrderLineId: l.salesOrderLineId,
      })),
    };
  }

  /**
   * Sales/Shipment/Returns workflow review (CTO directive, 2026-09-16) —
   * unscoped cross-domain snapshot for `ShipmentReturnsService` (returns
   * domain), same "snapshot" precedent as `getOrderSnapshot`/
   * `getCustomerSnapshot`: no actor-scoping (a warehouse/returns actor is
   * not necessarily the shipment's assigned driver), narrowed to exactly
   * what a Shipment Return needs to validate against.
   *
   * NOT named `getShipmentSnapshot` — that name was already taken by an
   * existing method further down this same class (used by `delivery.
   * service.ts`/`returns.service.ts`, different shape: fulfillmentOrderId/
   * shippingCompanyId/vehicleId/codAmount, no `lines`). Caught by `tsc`
   * ("Duplicate function implementation") during real verification —
   * renamed rather than silently shadowing the pre-existing method.
   */
  async getShipmentLinesSnapshot(
    shipmentId: string,
    manager?: EntityManager,
  ): Promise<{ id: string; salesOrderId: string | null; lines: ShipmentLine[] } | null> {
    const shipment = await (manager ?? this.dataSource).getRepository(Shipment).findOne({ where: { id: shipmentId } });
    if (!shipment) return null;
    const lines = await (manager ?? this.dataSource).getRepository(ShipmentLine).find({ where: { shipmentId } });
    return { id: shipment.id, salesOrderId: shipment.salesOrderId, lines };
  }

  async recordTrackingEvent(shipmentId: string, eventType: string, detail: string | null, manager?: EntityManager): Promise<TrackingEvent> {
    const repo = (manager ?? this.dataSource).getRepository(TrackingEvent);
    return repo.save(repo.create({ shipmentId, eventType, detail }));
  }

  /** V1 Release Audit MEDIUM fix (IDOR) — same missing check as getShipment, same read-only `assertCanReadShipment` (not `assertDriverOrAdmin`) for the same reason. */
  async getTrackingHistory(shipmentId: string, actorUserId: string, manager?: EntityManager): Promise<TrackingEvent[]> {
    await this.assertCanReadShipment(shipmentId, actorUserId, manager);
    return (manager ?? this.dataSource)
      .getRepository(TrackingEvent)
      .find({ where: { shipmentId }, order: { occurredAt: 'ASC' } });
  }

  async getStatus(shipmentId: string, manager?: EntityManager): Promise<string> {
    return this.processEngine.getState(SHIPMENT_PROCESS, ENTITY_TYPE, shipmentId, manager);
  }

  /**
   * Cross-domain read contract (same pattern as `CustomersService.
   * getCustomerSnapshot`) — unscoped, no driver/admin check, for
   * Delivery's Treasury-remittance bridge, which acts as
   * finance/admin (never the shipment's assigned driver) and was never
   * granted per-shipment access the way `getShipment` requires.
   */
  async getShipmentSnapshot(shipmentId: string, manager?: EntityManager): Promise<{
    id: string;
    fulfillmentOrderId: string;
    shippingCompanyId: string | null;
    vehicleId: string | null;
    codAmount: string | null;
    salesOrderId: string | null;
  } | null> {
    const shipment = await (manager ?? this.dataSource).getRepository(Shipment).findOne({ where: { id: shipmentId } });
    if (!shipment) return null;
    return {
      id: shipment.id,
      fulfillmentOrderId: shipment.fulfillmentOrderId,
      shippingCompanyId: shipment.shippingCompanyId,
      vehicleId: shipment.vehicleId,
      codAmount: shipment.codAmount,
      // Returns Engine Phase B — `Shipment.salesOrderId` already exists on
      // the entity (RSH migration) but this snapshot never surfaced it,
      // forcing callers into an unnecessary extra Fulfillment hop.
      salesOrderId: shipment.salesOrderId,
    };
  }

  /**
   * Cross-domain read contract (Delivery's custody bridge) — resolves the
   * ACTUAL custodian (vehicle preferred over company, same priority as
   * `transferCustodyOnPickup`) for a shipment, with both of its Treasury
   * links. `null` means no custodian at all (plain in-house delivery).
   */
  async getCustodianForShipment(
    shipmentId: string,
    manager?: EntityManager,
  ): Promise<{ custodyAccountId: string; settlementAccountId: string | null } | null> {
    const shipment = await (manager ?? this.dataSource).getRepository(Shipment).findOne({ where: { id: shipmentId } });
    if (!shipment) return null;
    if (shipment.vehicleId) {
      const vehicle = await this.getVehicle(shipment.vehicleId, manager);
      if (!vehicle.custodyAccountId) return null;
      let settlementAccountId = vehicle.settlementAccountId;
      if (!settlementAccountId && vehicle.shippingCompanyId) {
        const company = await this.getShippingCompany(vehicle.shippingCompanyId, manager);
        settlementAccountId = company.treasuryAccountId;
      }
      return { custodyAccountId: vehicle.custodyAccountId, settlementAccountId };
    }
    if (shipment.shippingCompanyId) {
      const company = await this.getShippingCompany(shipment.shippingCompanyId, manager);
      if (!company.custodyAccountId) return null;
      return { custodyAccountId: company.custodyAccountId, settlementAccountId: company.treasuryAccountId };
    }
    return null;
  }

  // ---- Shipping Companies (CTO directive — multi-carrier support from the start) ----

  /**
   * CTO directive ("SHIPPING & CUSTODY MANAGEMENT" §1/§3/§4/§6) — creates
   * the company AND its two auto-provisioned Operational Custodian
   * resources: a Warehouse sub-location (`warehouseId`, so every custody
   * transfer routed to this company is an ordinary
   * `WarehouseTransactionsService` transfer — never a parallel stock
   * system) and a Custody Treasury account (`custodyAccountId`, typed
   * `'custody'` — explicitly NOT normal cash). Provisioning happens
   * AFTER the company row commits (same non-transactional
   * cross-domain-provisioning precedent as `CustomersService.
   * assignSalesRep`'s Scope grant) — if either downstream create fails,
   * the company still exists with that one link left `null`, fixable by
   * re-running provisioning rather than losing the company record.
   */
  async createShippingCompany(
    code: string,
    name: string,
    contactPhone: string | null,
    address: string | null,
    responsiblePerson: string | null,
    actorUserId: string,
    parentWarehouseId: string | null = null,
    manager?: EntityManager,
  ): Promise<ShippingCompany> {
    const repo = (manager ?? this.dataSource).getRepository(ShippingCompany);
    const existing = await repo.findOne({ where: { code } });
    if (existing) throw new ConflictException(`Shipping company code "${code}" is already in use.`);
    const saved = await repo.save(
      repo.create({ code, name, contactPhone, address, responsiblePerson, warehouseId: null, custodyAccountId: null, treasuryAccountId: null, status: 'active' }),
    );

    const resolvedParentId = await this.resolveParentWarehouseId(parentWarehouseId, manager);
    const { warehouseId, custodyAccountId } = await this.provisionCustodianResources(name, resolvedParentId, null, actorUserId, manager);
    saved.warehouseId = warehouseId;
    saved.custodyAccountId = custodyAccountId;
    await repo.save(saved);

    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'shipment.shipping_company.created',
        resource: 'shipping_company',
        resourceId: saved.id,
        result: 'success',
        correlationId: null,
        after: { code, name, warehouseId, custodyAccountId },
      },
      manager,
    );
    return saved;
  }

  /** CTO directive §1 — "تعديل بياناتها" (edit its data), everything except code/status/the auto-provisioned links. */
  async updateShippingCompany(
    shippingCompanyId: string,
    updates: { name?: string; contactPhone?: string | null; address?: string | null; responsiblePerson?: string | null },
    actorUserId: string,
    manager?: EntityManager,
  ): Promise<ShippingCompany> {
    const repo = (manager ?? this.dataSource).getRepository(ShippingCompany);
    const company = await this.getShippingCompany(shippingCompanyId, manager);
    const before = { name: company.name, contactPhone: company.contactPhone, address: company.address, responsiblePerson: company.responsiblePerson };
    if (updates.name !== undefined) company.name = updates.name;
    if (updates.contactPhone !== undefined) company.contactPhone = updates.contactPhone;
    if (updates.address !== undefined) company.address = updates.address;
    if (updates.responsiblePerson !== undefined) company.responsiblePerson = updates.responsiblePerson;
    const saved = await repo.save(company);
    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'shipment.shipping_company.updated',
        resource: 'shipping_company',
        resourceId: shippingCompanyId,
        result: 'success',
        correlationId: null,
        before,
        after: updates,
      },
      manager,
    );
    return saved;
  }

  async listShippingCompanies(manager?: EntityManager): Promise<ShippingCompany[]> {
    return (manager ?? this.dataSource).getRepository(ShippingCompany).find({ order: { code: 'ASC' } });
  }

  async getShippingCompany(shippingCompanyId: string, manager?: EntityManager): Promise<ShippingCompany> {
    const company = await (manager ?? this.dataSource).getRepository(ShippingCompany).findOne({ where: { id: shippingCompanyId } });
    if (!company) throw new NotFoundException(`Shipping company "${shippingCompanyId}" not found.`);
    return company;
  }

  /** Links (or clears, with `null`) which Treasury account this company's remittances post to — the concrete Customer→Order→Shipment→ShippingCompany→Treasury link the CTO directive asks for. Does not validate the account exists here (CRM/Commerce's own "never query another domain's table for a non-error-critical link" precedent, e.g. `setPriceList`) — an unknown/inactive account simply fails loudly the first time a remittance actually targets it. */
  async setShippingCompanyTreasuryAccount(
    shippingCompanyId: string,
    treasuryAccountId: string | null,
    actorUserId: string,
    manager?: EntityManager,
  ): Promise<ShippingCompany> {
    const repo = (manager ?? this.dataSource).getRepository(ShippingCompany);
    const company = await this.getShippingCompany(shippingCompanyId, manager);
    const before = { treasuryAccountId: company.treasuryAccountId };
    company.treasuryAccountId = treasuryAccountId;
    const saved = await repo.save(company);
    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'shipment.shipping_company.treasury_account_set',
        resource: 'shipping_company',
        resourceId: shippingCompanyId,
        result: 'success',
        correlationId: null,
        before,
        after: { treasuryAccountId },
      },
      manager,
    );
    return saved;
  }

  async setShippingCompanyStatus(
    shippingCompanyId: string,
    status: 'active' | 'inactive',
    actorUserId: string,
    manager?: EntityManager,
  ): Promise<ShippingCompany> {
    const repo = (manager ?? this.dataSource).getRepository(ShippingCompany);
    const company = await this.getShippingCompany(shippingCompanyId, manager);
    company.status = status;
    const saved = await repo.save(company);
    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'shipment.shipping_company.status_changed',
        resource: 'shipping_company',
        resourceId: shippingCompanyId,
        result: 'success',
        correlationId: null,
        after: { status },
      },
      manager,
    );
    return saved;
  }

  // ---- Company Vehicles (CTO directive §2 — a second Operational Custodian type) ----

  /** Same auto-provisioning discipline as `createShippingCompany` — its own Warehouse sub-location + Custody Treasury account. */
  async createVehicle(
    code: string,
    plateNumber: string,
    driverUserId: string | null,
    shippingCompanyId: string | null,
    branch: string | null,
    actorUserId: string,
    parentWarehouseId: string | null = null,
    manager?: EntityManager,
    /** Org engine Stage 2 — the VALIDATED branch (resolved by `OrgContextService`); `null` for a Company without branches. */
    orgUnitId: string | null = null,
  ): Promise<Vehicle> {
    const repo = (manager ?? this.dataSource).getRepository(Vehicle);
    const existing = await repo.findOne({ where: { code } });
    if (existing) throw new ConflictException(`Vehicle code "${code}" is already in use.`);
    if (shippingCompanyId) await this.getShippingCompany(shippingCompanyId, manager); // 404s if unknown

    const saved = await repo.save(
      repo.create({
        code,
        plateNumber,
        driverUserId,
        shippingCompanyId,
        branch: orgUnitId ? await this.branchNameOf(orgUnitId, manager) : branch, // legacy text mirrors the branch name once a branch is assigned
        orgUnitId,
        warehouseId: null,
        custodyAccountId: null,
        settlementAccountId: null,
        status: 'active',
      }),
    );

    const resolvedParentId = await this.resolveParentWarehouseId(parentWarehouseId, manager);
    const { warehouseId, custodyAccountId } = await this.provisionCustodianResources(
      `${code} — ${plateNumber}`,
      resolvedParentId,
      driverUserId,
      actorUserId,
      manager,
      orgUnitId,
    );
    saved.warehouseId = warehouseId;
    saved.custodyAccountId = custodyAccountId;
    await repo.save(saved);

    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'shipment.vehicle.created',
        resource: 'vehicle',
        resourceId: saved.id,
        result: 'success',
        correlationId: null,
        after: { code, plateNumber, shippingCompanyId, warehouseId, custodyAccountId, orgUnitId },
      },
      manager,
    );
    return saved;
  }

  async listVehicles(manager?: EntityManager): Promise<Vehicle[]> {
    return (manager ?? this.dataSource).getRepository(Vehicle).find({ order: { code: 'ASC' } });
  }

  async getVehicle(vehicleId: string, manager?: EntityManager): Promise<Vehicle> {
    const vehicle = await (manager ?? this.dataSource).getRepository(Vehicle).findOne({ where: { id: vehicleId } });
    if (!vehicle) throw new NotFoundException(`Vehicle "${vehicleId}" not found.`);
    return vehicle;
  }

  private async branchNameOf(orgUnitId: string, manager?: EntityManager): Promise<string | null> {
    const rows: Array<{ name: string }> = await (manager ?? this.dataSource).query(`SELECT "name" FROM "org_units" WHERE "id" = $1`, [orgUnitId]);
    return rows[0]?.name ?? null;
  }

  /**
   * CTO directive §2 — "تعديل" (edit): plate number and branch. Driver changes go through `setVehicleDriver` (its own audited action).
   * Org engine Stage 2: `orgUnitId` is the VALIDATED branch (resolved by the controller); a change is propagated to the vehicle's custody sub-location and custody
   * treasury account so custody stays inside the branch. The legacy `branch` text is only accepted for a vehicle in a Company without branches (resolved `orgUnitId` null).
   */
  async updateVehicle(
    vehicleId: string,
    updates: { plateNumber?: string; branch?: string | null; orgUnitId?: string | null },
    actorUserId: string,
    manager?: EntityManager,
  ): Promise<Vehicle> {
    const runner = manager ?? this.dataSource;
    const repo = runner.getRepository(Vehicle);
    const vehicle = await this.getVehicle(vehicleId, manager);
    const before = { plateNumber: vehicle.plateNumber, branch: vehicle.branch, orgUnitId: vehicle.orgUnitId };
    if (updates.plateNumber !== undefined) vehicle.plateNumber = updates.plateNumber;
    if (updates.orgUnitId !== undefined && updates.orgUnitId !== vehicle.orgUnitId) {
      vehicle.orgUnitId = updates.orgUnitId;
      if (updates.orgUnitId) vehicle.branch = await this.branchNameOf(updates.orgUnitId, manager);
      if (vehicle.warehouseId) await runner.query(`UPDATE "warehouses" SET "orgUnitId" = $1 WHERE "id" = $2`, [updates.orgUnitId, vehicle.warehouseId]);
      if (vehicle.custodyAccountId) await runner.query(`UPDATE "treasury_accounts" SET "orgUnitId" = $1 WHERE "id" = $2`, [updates.orgUnitId, vehicle.custodyAccountId]);
    } else if (updates.branch !== undefined && !vehicle.orgUnitId) {
      vehicle.branch = updates.branch;
    }
    const saved = await repo.save(vehicle);
    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'shipment.vehicle.updated',
        resource: 'vehicle',
        resourceId: vehicleId,
        result: 'success',
        correlationId: null,
        before,
        after: { plateNumber: saved.plateNumber, branch: saved.branch, orgUnitId: saved.orgUnitId },
      },
      manager,
    );
    return saved;
  }

  /**
   * Legacy mapping report (org engine D-8). For every vehicle that still has no validated branch: the old free text and what it could correspond to. NOTHING is applied
   * here — `proposed` (one active branch has exactly that name) still needs an owner to confirm through the normal edit; `ambiguous` / `unmatched` / `no_text` are never guessed.
   */
  async vehicleBranchMappingReport(manager?: EntityManager): Promise<{
    branchesAvailable: number;
    rows: Array<{ vehicleId: string; code: string; plateNumber: string; legacyText: string | null; status: 'proposed' | 'ambiguous' | 'unmatched' | 'no_text'; candidates: Array<{ id: string; name: string }> }>;
  }> {
    const runner = manager ?? this.dataSource;
    const vehicles = await runner.getRepository(Vehicle).find({ order: { code: 'ASC' } });
    const branches: Array<{ id: string; name: string }> = await runner.query(`SELECT "id","name" FROM "org_units" WHERE "type" = 'branch' AND "status" = 'active'`);
    const norm = (v: string) => v.trim().replace(/\s+/g, ' ').toLowerCase();
    const rows = vehicles
      .filter((v) => !v.orgUnitId)
      .map((v) => {
        const text = v.branch && v.branch.trim() ? v.branch : null;
        if (!text) return { vehicleId: v.id, code: v.code, plateNumber: v.plateNumber, legacyText: null, status: 'no_text' as const, candidates: [] };
        const candidates = branches.filter((b) => norm(b.name) === norm(text));
        const status = candidates.length === 1 ? ('proposed' as const) : candidates.length > 1 ? ('ambiguous' as const) : ('unmatched' as const);
        return { vehicleId: v.id, code: v.code, plateNumber: v.plateNumber, legacyText: text, status, candidates };
      });
    return { branchesAvailable: branches.length, rows };
  }

  /** CTO directive §2 — "تغيير السائق" (change driver), its own explicit action distinct from a general edit. */
  async setVehicleDriver(vehicleId: string, driverUserId: string | null, actorUserId: string, manager?: EntityManager): Promise<Vehicle> {
    const repo = (manager ?? this.dataSource).getRepository(Vehicle);
    const vehicle = await this.getVehicle(vehicleId, manager);
    const before = { driverUserId: vehicle.driverUserId };
    vehicle.driverUserId = driverUserId;
    const saved = await repo.save(vehicle);
    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'shipment.vehicle.driver_changed',
        resource: 'vehicle',
        resourceId: vehicleId,
        result: 'success',
        correlationId: null,
        before,
        after: { driverUserId },
      },
      manager,
    );
    return saved;
  }

  /** CTO directive §2 — "إيقاف/إخراج السيارة من الخدمة" (take out of service): never deleted, only retired/reactivated. */
  async setVehicleStatus(vehicleId: string, status: 'active' | 'retired', actorUserId: string, manager?: EntityManager): Promise<Vehicle> {
    const repo = (manager ?? this.dataSource).getRepository(Vehicle);
    const vehicle = await this.getVehicle(vehicleId, manager);
    vehicle.status = status;
    const saved = await repo.save(vehicle);
    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'shipment.vehicle.status_changed',
        resource: 'vehicle',
        resourceId: vehicleId,
        result: 'success',
        correlationId: null,
        after: { status },
      },
      manager,
    );
    return saved;
  }

  /** Links (or clears) a vehicle's OWN settlement account — when unset, `DeliveryService.remitCollection` falls back to the owning shipping company's. */
  async setVehicleSettlementAccount(vehicleId: string, treasuryAccountId: string | null, actorUserId: string, manager?: EntityManager): Promise<Vehicle> {
    const repo = (manager ?? this.dataSource).getRepository(Vehicle);
    const vehicle = await this.getVehicle(vehicleId, manager);
    vehicle.settlementAccountId = treasuryAccountId;
    const saved = await repo.save(vehicle);
    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'shipment.vehicle.settlement_account_set',
        resource: 'vehicle',
        resourceId: vehicleId,
        result: 'success',
        correlationId: null,
        after: { treasuryAccountId },
      },
      manager,
    );
    return saved;
  }

  // ---- Custody visibility (CTO directive §8/§11) ----

  /**
   * Bundles a custodian's full operational picture from data that
   * already exists — nothing fabricated: goods under custody (the
   * sub-location warehouse's real stock report), money under custody
   * (the real Treasury account balance + its ledger), and how many
   * shipments currently route through it. Directive §8's exact example
   * (products/inventory value/COD outstanding) is this method's return
   * shape.
   */
  async getCustodianOverview(
    custodianType: 'company' | 'vehicle',
    custodianId: string,
    manager?: EntityManager,
  ): Promise<{
    warehouseId: string | null;
    custodyAccountId: string | null;
    stock: Array<{ warehouseId: string; productId: string; onHand: number; reserved: number; available: number }>;
    custodyBalance: string | null;
    activeShipmentsCount: number;
  }> {
    const custodian: { warehouseId: string | null; custodyAccountId: string | null } =
      custodianType === 'company' ? await this.getShippingCompany(custodianId, manager) : await this.getVehicle(custodianId, manager);

    const [stock, custodianShipments] = await Promise.all([
      custodian.warehouseId ? this.inventory.getStockReport(custodian.warehouseId, manager) : Promise.resolve([]),
      (manager ?? this.dataSource).getRepository(Shipment).find(
        custodianType === 'company' ? { where: { shippingCompanyId: custodianId } } : { where: { vehicleId: custodianId } },
      ),
    ]);

    // BUG FOUND AND FIXED (disclosed in MASTER_HANDOVER.md §2,
    // resolved here): this used to count EVERY shipment ever assigned to
    // this custodian, including long-`delivered`/`returned` ones — a
    // custodian that had ever handled a single shipment would show a
    // permanently nonzero "active shipments" count forever. Filter to the
    // shipment's actual current Process Engine state instead, same
    // "terminal = delivered/returned" definition `searchCustodyShipments`
    // already uses just above.
    const states = await Promise.all(custodianShipments.map((s) => this.processEngine.getState(SHIPMENT_PROCESS, ENTITY_TYPE, s.id, manager)));
    const activeShipmentsCount = states.filter((state) => state !== 'delivered' && state !== 'returned').length;

    const custodyBalance = custodian.custodyAccountId ? await this.treasury.getAccountBalance(custodian.custodyAccountId, manager) : null;

    return {
      warehouseId: custodian.warehouseId,
      custodyAccountId: custodian.custodyAccountId,
      stock,
      custodyBalance,
      activeShipmentsCount,
    };
  }

  // ---- Custody Transfer (CTO directive §5 — Chain of Custody) ----

  /**
   * Vehicle preferred over company (a vehicle is the more specific
   * custodian when both are set) — the SAME priority `getCustodianForShipment`
   * and `transferCustodyOnPickup` already used, now shared by both instead
   * of duplicated, and by `getCurrentCustodyWarehouseId` below (Delivery's
   * bridge for resolving where the goods physically sit at Customer
   * Delivery — CTO directive: the final ledger exit must happen at
   * whatever warehouse currently holds the goods, not wherever the
   * reservation was originally booked against, since one or more custody
   * transfers may have moved them since).
   */
  private async resolveCustodyWarehouseId(shipment: Shipment, manager?: EntityManager): Promise<string | null> {
    if (shipment.vehicleId) {
      const vehicle = await this.getVehicle(shipment.vehicleId, manager);
      return vehicle.warehouseId;
    }
    if (shipment.shippingCompanyId) {
      const company = await this.getShippingCompany(shipment.shippingCompanyId, manager);
      return company.warehouseId;
    }
    return null;
  }

  /**
   * Cross-domain read contract (Delivery's bridge — same pattern as
   * `getShipmentSnapshot`/`getCustodianForShipment`): where the goods
   * currently sit, for the final delivery-time ledger exit. `null` means
   * no custodian was ever assigned (a plain in-house driver delivery) —
   * the caller falls back to the Fulfillment Order's own warehouse in
   * that case, since custody never left it.
   */
  async getCurrentCustodyWarehouseId(shipmentId: string, manager?: EntityManager): Promise<string | null> {
    const shipment = await (manager ?? this.dataSource).getRepository(Shipment).findOne({ where: { id: shipmentId } });
    if (!shipment) return null;
    return this.resolveCustodyWarehouseId(shipment, manager);
  }

  /**
   * The physical handoff: goods leave wherever they ACTUALLY currently
   * sit and enter the assigned custodian's sub-location. Fired from
   * `transitionShipment` at the real-world moment of pickup, not at
   * shipment creation (before pickup, the goods are still physically
   * wherever Preparation left them).
   *
   * REAL BUG FOUND AND FIXED (CTO directive — reconcile the Preparation ->
   * Shipping handoff): this used to hard-code `FulfillmentOrder.warehouseId`
   * (the Main warehouse, snapshotted once at Fulfillment Order creation) as
   * the transfer's SOURCE, and route it through
   * `WarehouseTransactionsService`'s normal transfer pipeline. Two things
   * were wrong with that, independently:
   *   1. Once Item Preparation ships stock into the "تحت التجهيز"
   *      sub-location, the goods are no longer physically at
   *      `FulfillmentOrder.warehouseId` at all — that field is a
   *      creation-time snapshot, never updated as custody/location moves.
   *   2. `WarehouseTransactionsService`'s transfer availability check
   *      answers "is there enough FREE (unreserved) stock to move," which
   *      is the wrong question for stock already committed to this exact
   *      order — the same reasoning `InventoryService.relocateReservedStock`
   *      (built for Item Preparation) was already designed around.
   * Fixed by resolving the source from each of the order's own ACTIVE
   * reservations (`InventoryService.getActiveReservationsForOrder` — each
   * reservation's `warehouseId` always reflects wherever that line
   * currently sits, since Item Preparation moves the reservation WITH the
   * goods) and reusing `relocateReservedStock` per line — the exact same
   * primitive Preparation uses, never a second inventory mechanism. A
   * reservation already sitting at the destination (e.g. a retried
   * transition) is skipped, not re-transferred.
   */
  /**
   * Area 21 Operational Company Scoping Retrofit (2026-09-27): `manager?`
   * added — this method predates Area 21's own Company-routing
   * requirement (its own earlier doc comment on `transitionShipment`
   * explicitly deferred this as "out of scope" for a DIFFERENT reason —
   * atomicity with `DeliveryService.recordOutcome`'s transaction, not
   * Company-routing). The CTO's Area 21 authorization requires every
   * nested call to thread the Company-scoped manager regardless — see
   * `transitionShipment`'s own updated call site below.
   */
  private async transferCustodyOnPickup(shipmentId: string, actorUserId: string, manager?: EntityManager): Promise<void> {
    const shipment = await (manager ?? this.dataSource).getRepository(Shipment).findOne({ where: { id: shipmentId } });
    if (!shipment) return;

    const destinationWarehouseId = await this.resolveCustodyWarehouseId(shipment, manager);
    if (!destinationWarehouseId) return; // no custodian assigned — nothing to transfer

    const fulfillmentOrder = await this.fulfillment.getFulfillmentOrder(shipment.fulfillmentOrderId, manager);
    const reservations = await this.inventory.getActiveReservationsForOrder(fulfillmentOrder.salesOrderId, manager);

    for (const reservation of reservations) {
      if (reservation.warehouseId === destinationWarehouseId) continue; // already there
      await this.inventory.relocateReservedStock(
        fulfillmentOrder.salesOrderId,
        reservation.productId,
        reservation.warehouseId,
        destinationWarehouseId,
        reservation.quantity,
        'shipment_custody_transfer',
        shipmentId,
        actorUserId,
        manager,
      );
    }
  }

  // ---- Custody Returns (Returns Engine Phase B — CTO directive) ----

  /**
   * Backs a custody return (`ReturnsService.initiateCustodyReturn`) —
   * records the reversal as a tracking event only, NEVER a Process Engine
   * transition. A shipment is 1:1 with a fulfillment order, not
   * line-level, so a custody return may cover only one product out of a
   * multi-line shipment — force-transitioning the whole waybill to the
   * terminal `returned` state on a partial reversal would be wrong and
   * would block the rest of the shipment from later delivering. Whether
   * to transition the WHOLE waybill to `returned` stays a separate, human
   * dispatcher decision via the existing `return_to_sender` action.
   */
  /** Area 21 Operational Company Scoping Retrofit (2026-09-27): `manager?` added — called cross-domain from `ReturnsService.initiateCustodyReturn`. */
  async recordCustodyReversal(shipmentId: string, productId: string, quantity: number, actorUserId: string, manager?: EntityManager): Promise<void> {
    const shipment = await (manager ?? this.dataSource).getRepository(Shipment).findOne({ where: { id: shipmentId } });
    if (!shipment) throw new NotFoundException(`Shipment "${shipmentId}" not found.`);
    const state = await this.processEngine.getState(SHIPMENT_PROCESS, ENTITY_TYPE, shipmentId, manager);
    if (state === 'delivered' || state === 'returned') {
      throw new ConflictException(`Cannot record a custody reversal for a shipment in state "${state}".`);
    }

    await this.recordTrackingEvent(shipmentId, 'custody_reversed', `${quantity} × product ${productId} reversed out of custody (return).`, manager);
    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'shipment.custody_reversed',
        resource: 'shipment',
        resourceId: shipmentId,
        result: 'success',
        correlationId: null,
        after: { productId, quantity },
      },
      manager,
    );
  }

  /**
   * Returns Engine Phase B (CTO directive §"مرتجعات الشحن") — the search
   * screen's own backing read: Customer/Customer-Code/Shipment/Waybill for
   * a Shipping-Company custody return, or Customer/Customer-Code/RSH/
   * Vehicle for a Company-Vehicle one, resolving the full chain the
   * directive asks for (Customer → Sales Order → RSH/Shipment → Shipping
   * Company/Vehicle → items/quantities/current custody status). Only
   * shipments actually routed through a custodian are candidates — a
   * plain in-house delivery has nothing here to search. Small-N per-result
   * enrichment (this codebase's own "N calls fine at V1 scale" precedent,
   * e.g. `ReturnsService.listAvailableCredits`) rather than a cross-domain
   * SQL join.
   */
  async searchCustodyShipments(
    filters: {
      customerId?: string;
      customerCode?: string;
      shipmentId?: string;
      waybillNumber?: string;
      rshNumber?: string;
      shippingCompanyId?: string;
      vehicleId?: string;
    },
    actorUserId: string,
    manager?: EntityManager,
  ): Promise<
    Array<{
      shipmentId: string;
      waybillNumber: string;
      rshNumber: string | null;
      salesOrderId: string;
      salesOrderNumber: string | null;
      salesRepUserId: string | null;
      customerId: string;
      customerCode: string | null;
      customerName: string | null;
      custodianType: 'company' | 'vehicle';
      custodianId: string;
      custodianName: string;
      custodyWarehouseId: string | null;
      currentCustodyStatus: string;
      items: Array<{ productId: string; quantity: number }>;
    }>
  > {
    const access = await this.authorization.workflowAccess(actorUserId, manager);
    if (!access.allows('logistics.shipment.custody_query')) {
      throw new ForbiddenException('Role required: admin, warehouse_worker, or sales_supervisor.');
    }

    let resolvedCustomerId = filters.customerId ?? null;
    if (!resolvedCustomerId && filters.customerCode) {
      const customer = await this.customers.findByCode(filters.customerCode, manager);
      if (!customer) return [];
      resolvedCustomerId = customer.id;
    }

    const where: FindOptionsWhere<Shipment> = {};
    if (filters.shipmentId) where.id = filters.shipmentId;
    if (filters.waybillNumber) where.waybillNumber = filters.waybillNumber;
    if (filters.rshNumber) where.rshNumber = filters.rshNumber;
    if (filters.shippingCompanyId) where.shippingCompanyId = filters.shippingCompanyId;
    if (filters.vehicleId) where.vehicleId = filters.vehicleId;

    const candidates = await (manager ?? this.dataSource).getRepository(Shipment).find({ where, order: { createdAt: 'DESC' } });
    const withCustodian = candidates.filter((s) => s.shippingCompanyId || s.vehicleId);

    const results: Array<{
      shipmentId: string;
      waybillNumber: string;
      rshNumber: string | null;
      salesOrderId: string;
      salesOrderNumber: string | null;
      salesRepUserId: string | null;
      customerId: string;
      customerCode: string | null;
      customerName: string | null;
      custodianType: 'company' | 'vehicle';
      custodianId: string;
      custodianName: string;
      custodyWarehouseId: string | null;
      currentCustodyStatus: string;
      items: Array<{ productId: string; quantity: number }>;
    }> = [];

    for (const shipment of withCustodian) {
      if (!shipment.salesOrderId) continue;
      const order = await this.salesOrders.getOrderSnapshot(shipment.salesOrderId, manager);
      if (!order) continue;
      if (resolvedCustomerId && order.customerId !== resolvedCustomerId) continue;

      const customerSnapshot = await this.customers.getCustomerSnapshot(order.customerId, manager);
      const custodianType: 'company' | 'vehicle' = shipment.vehicleId ? 'vehicle' : 'company';
      const custodianId = shipment.vehicleId ?? shipment.shippingCompanyId!;
      const custodianName =
        custodianType === 'vehicle' ? (await this.getVehicle(custodianId, manager)).plateNumber : (await this.getShippingCompany(custodianId, manager)).name;
      const custodyWarehouseId = await this.resolveCustodyWarehouseId(shipment, manager);
      const state = await this.processEngine.getState(SHIPMENT_PROCESS, ENTITY_TYPE, shipment.id, manager);

      const reservations = custodyWarehouseId ? await this.inventory.getActiveReservationsForOrder(shipment.salesOrderId, manager) : [];
      const items = reservations
        .filter((r) => r.warehouseId === custodyWarehouseId)
        .map((r) => ({ productId: r.productId, quantity: r.quantity }));

      results.push({
        shipmentId: shipment.id,
        waybillNumber: shipment.waybillNumber,
        rshNumber: shipment.rshNumber,
        salesOrderId: shipment.salesOrderId,
        salesOrderNumber: shipment.salesOrderNumber,
        salesRepUserId: shipment.salesRepUserId,
        customerId: order.customerId,
        customerCode: customerSnapshot?.code ?? null,
        customerName: customerSnapshot?.name ?? null,
        custodianType,
        custodianId,
        custodianName,
        custodyWarehouseId,
        currentCustodyStatus: state,
        items,
      });
    }

    return results;
  }
}
