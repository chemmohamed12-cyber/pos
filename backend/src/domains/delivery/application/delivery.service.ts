import { Inject, BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, Not } from 'typeorm';
import { DeliveryOutcome } from '../infrastructure/delivery-outcome.entity';
import { Collection } from '../infrastructure/collection.entity';
import { ShipmentCustody } from '../infrastructure/shipment-custody.entity';
import { DeliveryOutcomeType } from '../domain/delivery-outcome-type';
import { ShipmentService } from '../../shipment/application/shipment.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import {
  FULFILLMENT_CONTRACT,
  FulfillmentContract,
  INVENTORY_LOGISTICS_CONTRACT,
  InventoryLogisticsContract,
} from '../../../foundation/module-registry/contracts/inventory.contract';
import { FINANCE_TREASURY_CONTRACT, FinanceTreasuryContract, FINANCE_CUSTOMER_LEDGER_CONTRACT, FinanceCustomerLedgerContract, FINANCE_INVOICE_CONTRACT, FinanceInvoiceContract } from '../../../foundation/module-registry/contracts/finance.contract';
import { SALES_ORDERS_READ_CONTRACT, SalesOrdersReadContract } from '../../../foundation/module-registry/contracts/sales.contract';
import { LogisticsDeliveryContract } from '../../../foundation/module-registry/contracts/logistics.contract';

const OUTCOME_TO_SHIPMENT_ACTION: Record<DeliveryOutcomeType, string | null> = {
  delivered: 'deliver',
  failed: 'fail_delivery',
  refused: 'fail_delivery',
  returned: 'return_to_sender',
};

/**
 * Delivery — Stage 2 build-order item 31. Daii/architecture/DAII_DOMAIN_BOUNDARIES.md §10.
 * Drives Shipment's state transition through its published contract
 * (`ShipmentService.transitionShipment`, which already enforces the
 * assigned-driver-or-admin scope check) — never touches the shipments
 * table directly.
 */
@Injectable()
export class DeliveryService implements LogisticsDeliveryContract {
  constructor(
    private readonly dataSource: DataSource,
    private readonly shipments: ShipmentService,
    @Inject(FULFILLMENT_CONTRACT) private readonly fulfillment: FulfillmentContract,
    @Inject(SALES_ORDERS_READ_CONTRACT) private readonly salesOrders: SalesOrdersReadContract,
    @Inject(FINANCE_TREASURY_CONTRACT) private readonly treasury: FinanceTreasuryContract,
    @Inject(INVENTORY_LOGISTICS_CONTRACT) private readonly inventory: InventoryLogisticsContract,
    private readonly audit: AuditService,
    private readonly events: EventBusService,
    private readonly numbering: NumberingService,
    @Inject(FINANCE_CUSTOMER_LEDGER_CONTRACT) private readonly customerLedger: FinanceCustomerLedgerContract,
    @Inject(FINANCE_INVOICE_CONTRACT) private readonly invoices: FinanceInvoiceContract,
  ) {}

  /**
   * Gap Resolution Package 3 (2026-09-14, row 37) — the shipment transition, the inventory
   * fulfillment (only for a genuine `delivered` outcome), and the `DeliveryOutcome` row + event now
   * share ONE transaction. Previously up to 4 independently-committing steps: a crash after
   * inventory fulfillment but before the outcome row left stock already dispatched with no
   * `DeliveryOutcome` record at all, and the shipment already flipped to `delivered` even if nothing
   * after it succeeded. `manager` is optional (Mandatory Implementation Invariant) — `transitionShipment`
   * and `fulfillReservationsForOrder` both receive OUR manager, so neither opens an independent
   * transaction beneath this one.
   */
  async recordOutcome(
    shipmentId: string,
    outcome: DeliveryOutcomeType,
    failureReason: string | null,
    actorUserId: string,
    manager?: EntityManager,
  ): Promise<DeliveryOutcome> {
    const record = await (manager ?? this.dataSource).transaction(async (txManager) => {
      // Stage C / F-2 (2026-10-22): a cash-on-delivery shipment is never confirmed delivered without the collection that the delivery is for (enforced here, on the server — a UI
      // restriction is not enough). The collection keeps its own lifecycle (recorded -> remitted -> GL at remittance); this only refuses a "delivered" outcome that has none.
      if (outcome === 'delivered') {
        const snapshot = await this.shipments.getShipmentSnapshot(shipmentId, txManager);
        if (snapshot && snapshot.codAmount !== null && Number(snapshot.codAmount) > 0) {
          const collected = await this.getCollectionForShipmentUnscoped(shipmentId, txManager); // latest NON-rejected one
          if (!collected) {
            throw new ConflictException(
              `Shipment "${shipmentId}" is cash on delivery (${snapshot.codAmount}): record the collection before confirming the delivery. Nothing was changed.`,
            );
          }
        }
      }
      const action = OUTCOME_TO_SHIPMENT_ACTION[outcome];
      if (action) {
        await this.shipments.transitionShipment(shipmentId, action, actorUserId, txManager);
      }

      // CTO directive (reconcile the Preparation -> Shipping handoff, "no
      // premature inventory deduction"): the ONE point where an order's
      // stock finally leaves the company's tracked inventory for good —
      // moved here from Fulfillment's pack-close step, which fired far too
      // early (before Shipment/pickup/custody transfer even existed). Only
      // on a genuine 'delivered' outcome — 'failed'/'refused'/'returned'
      // mean the goods never actually reached the customer, so they stay
      // exactly where they physically are (still `active` reservations,
      // still visible, still company property); reconciling those back into
      // free stock is a Returns-domain concern, not this directive's scope.
      if (outcome === 'delivered') {
        const shipment = await this.shipments.getShipmentSnapshot(shipmentId, txManager);
        const fulfillmentOrder = await this.fulfillment.getFulfillmentOrder(shipment!.fulfillmentOrderId, txManager);
        const currentWarehouseId = (await this.shipments.getCurrentCustodyWarehouseId(shipmentId, txManager)) ?? fulfillmentOrder.warehouseId;
        await this.inventory.fulfillReservationsForOrder(fulfillmentOrder.salesOrderId, currentWarehouseId, actorUserId, txManager);
      }

      const repo = txManager.getRepository(DeliveryOutcome);
      const saved = await repo.save(repo.create({ shipmentId, outcome, failureReason, recordedByUserId: actorUserId }));
      // Finance-ready event per ADR-018 — self-contained payload, no callback into Shipment needed later.
      await this.events.publish(txManager, `delivery.${outcome === 'delivered' ? 'completed' : outcome}`, {
        shipmentId,
        outcome,
        failureReason,
        businessDate: new Date().toISOString(),
      });
      return saved;
    });
    await this.events.dispatchAfterCommit(manager);

    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: `delivery.outcome.${outcome}`,
        resource: 'delivery_outcome',
        resourceId: record.id,
        result: 'success',
        correlationId: null,
        after: { shipmentId, outcome, failureReason },
      },
      manager,
    );

    return record;
  }

  /**
   * CTO directive ("SHIPPING & CUSTODY MANAGEMENT" §7 — "Customer →
   * Driver/Shipping Company Custody → Company Treasury"): the collected
   * cash posts into the custodian's Custody account THE MOMENT it's
   * collected — not deferred to a later remittance step. Resolved via
   * `ShipmentService.getCustodianForShipment` (vehicle preferred over
   * company, same priority as the custody stock transfer at pickup); a
   * plain in-house driver delivery (no custodian) has no custody leg at
   * all, same as before this directive — `remitCollection` falls back to
   * its old direct-`cashIn` behavior for that case.
   */
  async recordCollection(
    shipmentId: string,
    amount: string,
    method: string,
    collectorUserId: string,
    manager?: EntityManager,
    clientKey?: string | null,
  ): Promise<Collection> {
    // V1 Release Audit MEDIUM fix — unlike recordOutcome (which delegates
    // to transitionShipment's own check), this had no assigned-driver/
    // admin verification at all; any authenticated user could record a
    // fabricated cash collection against any shipment.
    await this.shipments.assertDriverOrAdmin(shipmentId, collectorUserId, manager);
    if (clientKey !== undefined && clientKey !== null && !/^[A-Za-z0-9_.:-]{8,64}$/.test(clientKey)) {
      throw new BadRequestException('clientKey must be 8-64 characters (letters, digits, _ . : -).');
    }

    // Stage C / F-2 (2026-10-22): the whole recording is ONE transaction serialised per shipment. Before, the custody `cash_in` committed first and the collection row afterwards (a
    // failure in between left cash in the custody account with no collection record) and the "already collected?" check was an unlocked read, so concurrent submits could post
    // the cash twice. Now: lock -> check -> validate -> custody cash_in -> collection row -> event, all or nothing.
    // Stage C / C1 (D-2): a cash-on-delivery shipment may be collected in several instalments (a driver who takes the money in two goes); the server invariant is that the
    // collections still counting (recorded + confirmed - a rejected one leaves the sum) never exceed the expected amount. A shipment WITHOUT an expected amount keeps the legacy
    // rule of at most one collection. A retry carrying the same `clientKey` returns the first result instead of recording the cash again.
    let replayed = false;
    const collection = await (manager ?? this.dataSource).transaction(async (txManager) => {
      await txManager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`delivery:collection:${shipmentId}`]);
      const repo = txManager.getRepository(Collection);

      if (clientKey) {
        const prior = await repo.findOne({ where: { clientKey } });
        if (prior) {
          if (prior.shipmentId !== shipmentId || prior.collectorUserId !== collectorUserId || Number(prior.amount) !== Number(amount)) {
            throw new ConflictException('This clientKey was already used for a different collection.');
          }
          replayed = true;
          return prior;
        }
      }

      if (!/^\d+(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) {
        throw new BadRequestException('The collected amount must be a positive number with at most two decimals.');
      }
      const shipmentSnapshot = await this.shipments.getShipmentSnapshot(shipmentId, txManager);
      const expected = shipmentSnapshot && shipmentSnapshot.codAmount !== null && Number(shipmentSnapshot.codAmount) > 0 ? shipmentSnapshot.codAmount : null;
      const live = (await repo.find({ where: { shipmentId }, order: { occurredAt: 'ASC' } })).filter((c) => c.verificationStatus !== 'rejected');
      const liveCents = live.reduce((sum, c) => sum + toCents(c.amount), 0);
      if (expected === null) {
        // Shipping Screen Redesign directive §8/§13 — no expected amount: at most one real COD collection event (the invariant `ReturnsService.initiateCustodyReturn` relies on).
        if (live.length > 0) throw new ConflictException(`Shipment "${shipmentId}" already has a recorded collection (${live[0].id}) — cannot record a second one.`);
      } else if (liveCents + toCents(amount) > toCents(expected)) {
        const remaining = Math.max(0, toCents(expected) - liveCents) / 100;
        throw new ConflictException(
          `The collected amount ${amount} would exceed the cash-on-delivery amount ${expected} of this shipment (already collected ${(liveCents / 100).toFixed(2)}, remaining ${remaining.toFixed(2)}). Nothing was recorded.`,
        );
      }

      const custody = await this.ensureCustodyRecord(shipmentId, shipmentSnapshot, expected, collectorUserId, txManager);
      const custodian = await this.shipments.getCustodianForShipment(shipmentId, txManager);
      let custodyTransactionId: string | null = null;
      if (custodian) {
        const fulfillmentOrder = await this.fulfillment.getFulfillmentOrder(shipmentSnapshot!.fulfillmentOrderId, txManager);
        const orderSnapshot = await this.salesOrders.getOrderSnapshot(fulfillmentOrder.salesOrderId, txManager);
        const custodyTxn = await this.treasury.cashIn(
          custodian.custodyAccountId,
          amount,
          orderSnapshot?.customerId ?? null,
          fulfillmentOrder.salesOrderId,
          shipmentId,
          'cod_collection_custody',
          collectorUserId,
          txManager,
        );
        custodyTransactionId = custodyTxn.id;
      }

      const saved = await repo.save(
        repo.create({
          shipmentId,
          amount,
          method,
          collectorUserId,
          custodyAccountId: custodian?.custodyAccountId ?? null,
          custodyTransactionId,
          verificationStatus: 'recorded',
          clientKey: clientKey ?? null,
          custodyId: custody.id,
        }),
      );
      // Finance-ready event (ADR-018) — amount, currency-implicit (EGP, same as Deposit Control), party, and date all present without a Finance callback into Delivery.
      //
      // ADR-042 D3 (F09) — purely operational, by design: this topic NEVER gets a GL handler (that is `collection.remitted`'s job, at `remitCollection` time — see ADR-042 D3a-D3h).
      // The `idempotencyKey` below is still added (ADR-042 D0) purely for hygiene: even an `IGNORED` (handler-less) `FinancialEvent` row should carry the right identity.
      await this.events.publish(txManager, 'collection.recorded', {
        idempotencyKey: `collection:${saved.id}:recorded`,
        shipmentId,
        amount,
        method,
        collectorUserId,
        businessDate: new Date().toISOString(),
      });
      return saved;
    });
    if (replayed) return collection;
    // F09-H2 (RBW Gap 2) — matches every other financial-event publisher in this codebase.
    await this.events.dispatchAfterCommit(manager);

    await this.audit.record(
      {
        actorUserId: collectorUserId,
        organizationId: null,
        action: 'delivery.collection.recorded',
        resource: 'collection',
        resourceId: collection.id,
        result: 'success',
        correlationId: null,
        after: { shipmentId, amount, method, custodyAccountId: collection.custodyAccountId, custodyTransactionId: collection.custodyTransactionId, custodyId: collection.custodyId },
      },
      manager,
    );

    return collection;
  }

  /**
   * Stage C / C1 - the per-shipment custody record, created by the first collection (never for a shipment that carries no cash). Runs inside the caller's transaction, which already
   * holds the per-shipment advisory lock, so two collections cannot both create it; the unique index on `shipmentId` is the backstop. Vehicle, driver and the vehicle's free-text
   * branch are copied at that moment (D-6: no branch entity, no branch security).
   */
  private async ensureCustodyRecord(
    shipmentId: string,
    snapshot: { vehicleId: string | null; driverUserId: string | null } | null,
    expectedAmount: string | null,
    actorUserId: string,
    txManager: EntityManager,
  ): Promise<ShipmentCustody> {
    const repo = txManager.getRepository(ShipmentCustody);
    const existing = await repo.findOne({ where: { shipmentId } });
    if (existing) return existing;
    let branch: string | null = null;
    if (snapshot?.vehicleId) branch = (await this.shipments.getVehicle(snapshot.vehicleId, txManager)).branch ?? null;
    await this.numbering.registerDocumentType('shipment_custody', 'CUS', true, txManager);
    const custodyNumber = await this.numbering.getNextNumber('shipment_custody', txManager);
    return repo.save(
      repo.create({ custodyNumber, shipmentId, vehicleId: snapshot?.vehicleId ?? null, driverUserId: snapshot?.driverUserId ?? null, branch, expectedAmount, openedByUserId: actorUserId }),
    );
  }

  /**
   * Stage C / C1 (D-3) - someone OTHER than the collector confirms that the cash the driver recorded was really received. Operational only: nothing is posted (the cash already sits
   * in the custody account since recording; the GL entry happens at remittance). Idempotent for an already-confirmed row; refused for a rejected or remitted one.
   */
  async confirmCollection(collectionId: string, actorUserId: string, manager?: EntityManager): Promise<Collection> {
    const found = await (manager ?? this.dataSource).getRepository(Collection).findOne({ where: { id: collectionId } });
    if (!found) throw new NotFoundException(`Collection "${collectionId}" not found.`);
    await this.shipments.getShipment(found.shipmentId, actorUserId, manager); // same scope check as remit
    const saved = await (manager ?? this.dataSource).transaction(async (txManager) => {
      await txManager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`delivery:collection:${found.shipmentId}`]);
      const repo = txManager.getRepository(Collection);
      const c = await repo.findOne({ where: { id: collectionId } });
      if (!c) throw new NotFoundException(`Collection "${collectionId}" not found.`);
      if (c.verificationStatus === 'confirmed') return null; // idempotent - nothing changes, nothing audited twice
      if (c.verificationStatus === 'rejected') throw new ConflictException(`Collection "${collectionId}" was rejected - it cannot be confirmed.`);
      if (c.collectorUserId === actorUserId) throw new ForbiddenException('A collection must be confirmed by someone other than the person who recorded it.');
      c.verificationStatus = 'confirmed';
      c.confirmedByUserId = actorUserId;
      c.confirmedAt = new Date();
      return repo.save(c);
    });
    if (!saved) return (await (manager ?? this.dataSource).getRepository(Collection).findOne({ where: { id: collectionId } }))!;
    await this.audit.record(
      { actorUserId, organizationId: null, action: 'delivery.collection.confirmed', resource: 'collection', resourceId: saved.id, result: 'success', correlationId: null, after: { shipmentId: saved.shipmentId, amount: saved.amount } },
      manager,
    );
    return saved;
  }

  /**
   * Stage C / C1 (D-3) - the confirmer says the cash was NOT received. The custody `cash_in` leg is reversed through the Treasury's owner-reversal (an append-only offsetting leg;
   * it refuses when the custody account no longer holds the money - fail closed) and the collection stops counting toward the expected total. A reason is mandatory. Refused once
   * the collection is confirmed or remitted: from then on finance's own reversal path applies.
   */
  async rejectCollection(collectionId: string, reason: string, actorUserId: string, manager?: EntityManager): Promise<Collection> {
    const why = (reason ?? '').trim();
    if (why.length < 3 || why.length > 255) throw new BadRequestException('A rejection reason of 3-255 characters is required.');
    const found = await (manager ?? this.dataSource).getRepository(Collection).findOne({ where: { id: collectionId } });
    if (!found) throw new NotFoundException(`Collection "${collectionId}" not found.`);
    await this.shipments.getShipment(found.shipmentId, actorUserId, manager);
    const saved = await (manager ?? this.dataSource).transaction(async (txManager) => {
      await txManager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`delivery:collection:${found.shipmentId}`]);
      const repo = txManager.getRepository(Collection);
      const c = await repo.findOne({ where: { id: collectionId } });
      if (!c) throw new NotFoundException(`Collection "${collectionId}" not found.`);
      if (c.verificationStatus === 'rejected') return null; // idempotent
      if (c.verificationStatus !== 'recorded' || c.remittanceStatus === 'remitted') {
        throw new ConflictException(`Collection "${collectionId}" is already confirmed or remitted - it can no longer be rejected here.`);
      }
      if (c.collectorUserId === actorUserId) throw new ForbiddenException('A collection must be rejected by someone other than the person who recorded it.');
      if (c.custodyTransactionId) await this.treasury.reverseOwnedLeg(c.custodyTransactionId, `collection ${c.id} rejected: ${why}`, actorUserId, txManager);
      c.verificationStatus = 'rejected';
      c.rejectionReason = why;
      c.confirmedByUserId = actorUserId;
      c.confirmedAt = new Date();
      return repo.save(c);
    });
    if (!saved) return (await (manager ?? this.dataSource).getRepository(Collection).findOne({ where: { id: collectionId } }))!;
    await this.audit.record(
      { actorUserId, organizationId: null, action: 'delivery.collection.rejected', resource: 'collection', resourceId: saved.id, result: 'success', correlationId: null, after: { shipmentId: saved.shipmentId, amount: saved.amount, reason: why } },
      manager,
    );
    return saved;
  }

  /**
   * Backs the Delivery print document — didn't exist before (outcomes/
   * collections were write-only). V1 Release Audit MEDIUM fix (IDOR):
   * had no assigned-driver/admin check; reused from ShipmentService
   * rather than duplicated (see recordCollection).
   */
  async getOutcomeForShipment(shipmentId: string, actorUserId: string, manager?: EntityManager): Promise<DeliveryOutcome | null> {
    await this.shipments.assertDriverOrAdmin(shipmentId, actorUserId, manager);
    return (manager ?? this.dataSource).getRepository(DeliveryOutcome).findOne({ where: { shipmentId }, order: { occurredAt: 'DESC' } });
  }

  async getCollectionForShipment(shipmentId: string, actorUserId: string, manager?: EntityManager): Promise<Collection | null> {
    await this.shipments.assertDriverOrAdmin(shipmentId, actorUserId, manager);
    return (manager ?? this.dataSource).getRepository(Collection).findOne({ where: { shipmentId, verificationStatus: Not('rejected') }, order: { occurredAt: 'DESC' } });
  }

  /** Every collection of a shipment (rejected ones included), oldest first - driver-or-admin scoped like the single read above. */
  async listCollectionsForShipment(shipmentId: string, actorUserId: string, manager?: EntityManager): Promise<Collection[]> {
    await this.shipments.assertDriverOrAdmin(shipmentId, actorUserId, manager);
    return this.listCollectionsForShipmentUnscoped(shipmentId, manager);
  }

  async listCollectionsForShipmentUnscoped(shipmentId: string, manager?: EntityManager): Promise<Collection[]> {
    return (manager ?? this.dataSource).getRepository(Collection).find({ where: { shipmentId }, order: { occurredAt: 'ASC', id: 'ASC' } });
  }

  /**
   * Backs a finance/admin "awaiting settlement" queue — every Collection
   * not yet remitted to Treasury. Unscoped by driver/admin on purpose:
   * finance staff reviewing what's owed were never the assigned driver
   * on any of these shipments.
   */
  async listPendingRemittances(manager?: EntityManager): Promise<Collection[]> {
    return (manager ?? this.dataSource).getRepository(Collection).find({ where: { remittanceStatus: 'pending', verificationStatus: Not('rejected') }, order: { occurredAt: 'ASC' } });
  }

  /**
   * Same "unscoped by driver/admin" precedent as `listPendingRemittances`
   * above — Custody/COD Reporting (CTO directive, Phase 5) needs every
   * Collection ever recorded, grouped by `custodyAccountId`, not one
   * driver's own deliveries.
   */
  async listAllCollections(manager?: EntityManager): Promise<Collection[]> {
    return (manager ?? this.dataSource).getRepository(Collection).find({ order: { occurredAt: 'ASC' } });
  }

  /**
   * Same "unscoped by driver/admin" precedent as `listPendingRemittances`
   * above — the Customer Account statement (CTO directive — Customer
   * Account Foundation) needs a shipment's collection for a cross-order
   * financial history view, not a driver acting on their own delivery.
   */
  async getCollectionForShipmentUnscoped(shipmentId: string, manager?: EntityManager): Promise<Collection | null> {
    // Stage C / C1: the latest collection that still counts (a rejected one was never collected).
    return (manager ?? this.dataSource).getRepository(Collection).findOne({ where: { shipmentId, verificationStatus: Not('rejected') }, order: { occurredAt: 'DESC' } });
  }

  /**
   * CTO directive ("SHIPPING & CUSTODY MANAGEMENT" §6/§7 — "DHL Custody
   * -20,000 / Company Bank/Cash +20,000") — closing the loop
   * `recordCollection` opened. Two distinct paths:
   *
   * 1. The collection HAS a custody leg (`custodyAccountId` set at
   *    collection time): this is now a `TreasuryService.transfer` out of
   *    custody into the settlement account (the custodian's own, or an
   *    explicit override) — never a bare `cashIn`, which would double-
   *    count money that's already sitting in the ledger via the custody
   *    leg.
   * 2. No custody leg (a plain in-house driver collection, predating
   *    this directive, or a shipment with no custodian at all): falls
   *    back to the ORIGINAL direct-`cashIn` behavior — `treasuryAccountId`
   *    is then required, a deliberate `BadRequestException`, never a
   *    silent skip, so a remittance is never accidentally posted nowhere.
   *
   * Either way, posted through the SAME `TreasuryService` calls
   * `DepositsService.approveDeposit` already uses — no new ledger engine.
   * Never before the Collection is marked remitted (validate-before-
   * commit) — a Treasury failure never leaves a Collection silently
   * marked settled when it wasn't.
   */
  async remitCollection(
    collectionId: string,
    actorUserId: string,
    treasuryAccountId?: string | null,
    manager?: EntityManager,
  ): Promise<Collection> {
    const repo = (manager ?? this.dataSource).getRepository(Collection);
    const collection = await repo.findOne({ where: { id: collectionId } });
    if (!collection) throw new NotFoundException(`Collection "${collectionId}" not found.`);
    // AUDIT-SEC-28 remediation (S21 — Security Assurance Gate, 2026-09-10,
    // found by an independent sweep for the AUDIT-SEC-27 gap shape): this
    // method had NO Scope check at all — any actor holding
    // `logistics.collection.post` could remit (post a real Treasury
    // cash-in/transfer, mark as settled) ANY collection in the system,
    // regardless of branch/order ownership. `collection` is a
    // parent-derived-from-sales_order scoped resource
    // (`SCOPE_DERIVATION_REGISTRY`) — `ShipmentService.getShipment`
    // already resolves and scope-checks a shipment's parent order via
    // its own `assertCanReadShipment`, the exact same mechanism the
    // sibling reads on this shipment already trust; reused here for the
    // write path, called purely for its scope-check side effect.
    await this.shipments.getShipment(collection.shipmentId, actorUserId, manager);
    if (collection.remittanceStatus === 'remitted') {
      throw new ConflictException(`Collection "${collectionId}" has already been remitted.`);
    }
    if (collection.verificationStatus === 'rejected') {
      throw new ConflictException(`Collection "${collectionId}" was rejected - it cannot be remitted.`);
    }

    // --- Pre-transaction reads only (ADR-042 D3c) — resolve WHICH settlement account and WHAT
    // Customer Ledger entry this remittance will post, before opening the one atomic transaction
    // below. None of this mutates anything; every cross-domain call here is the SAME read this
    // method already made before F09, only reordered to happen before the write section instead of
    // interleaved with it.
    let isTransfer: boolean;
    let settlementAccountId: string;
    let cashInCustomerId: string | null = null;
    let cashInSalesOrderId: string | null = null;

    if (collection.custodyAccountId) {
      // Path 1 — transfer OUT of the custody leg already posted at collection time.
      let resolvedSettlementAccountId = treasuryAccountId ?? null;
      if (!resolvedSettlementAccountId) {
        const custodian = await this.shipments.getCustodianForShipment(collection.shipmentId, manager);
        resolvedSettlementAccountId = custodian?.settlementAccountId ?? null;
      }
      if (!resolvedSettlementAccountId) {
        throw new BadRequestException(
          'No settlement Treasury account to remit into — either supply treasuryAccountId, or set one on this custodian first.',
        );
      }
      isTransfer = true;
      settlementAccountId = resolvedSettlementAccountId;
    } else {
      // Path 2 — no custody leg exists (custodian-less collection); original direct-cashIn behavior.
      if (!treasuryAccountId) {
        throw new BadRequestException(
          'No Treasury account to remit into — this collection has no custody account, so treasuryAccountId is required.',
        );
      }
      const shipment = await this.shipments.getShipmentSnapshot(collection.shipmentId, manager);
      if (!shipment) throw new NotFoundException(`Shipment "${collection.shipmentId}" not found.`);
      const fulfillmentOrder = await this.fulfillment.getFulfillmentOrder(shipment.fulfillmentOrderId, manager);
      const orderSnapshot = await this.salesOrders.getOrderSnapshot(fulfillmentOrder.salesOrderId, manager);
      isTransfer = false;
      settlementAccountId = treasuryAccountId;
      cashInCustomerId = orderSnapshot?.customerId ?? null;
      cashInSalesOrderId = fulfillmentOrder.salesOrderId;
    }

    // Customer Financial Account / AR (CTO directive) — bridges the EXISTING COD/Collection flow
    // into the Customer Ledger: money already left the custodian and lands in a real company
    // Treasury account at THIS point, so this is where AR actually gets reduced, not at mere
    // collection time (the custody leg posted at `recordCollection` is Treasury-internal, not yet
    // "money the company can call its own"). Silently skipped (never invented) when the shipment/
    // order chain can't be resolved — unchanged from the original behavior.
    let ledgerCustomerId: string | null = null;
    let ledgerSalesOrderId: string | null = null;
    let linkedInvoiceId: string | null = null;
    const shipmentForLedger = await this.shipments.getShipmentSnapshot(collection.shipmentId, manager);
    if (shipmentForLedger) {
      const fulfillmentOrderForLedger = await this.fulfillment.getFulfillmentOrder(shipmentForLedger.fulfillmentOrderId, manager);
      const orderSnapshotForLedger = await this.salesOrders.getOrderSnapshot(fulfillmentOrderForLedger.salesOrderId, manager);
      if (orderSnapshotForLedger) {
        const existingInvoice = await this.invoices.findOpenInvoiceForOrder(fulfillmentOrderForLedger.salesOrderId, manager);
        const existingInvoiceState = existingInvoice ? await this.invoices.getStatus(existingInvoice.id, manager) : null;
        linkedInvoiceId = existingInvoiceState === 'posted' || existingInvoiceState === 'partially_paid' ? existingInvoice!.id : null;
        ledgerCustomerId = orderSnapshotForLedger.customerId;
        ledgerSalesOrderId = fulfillmentOrderForLedger.salesOrderId;
      }
    }

    // F09-H2 (ADR-042 D1) — resolve the settlement account's mapped GL code via the EXISTING
    // `getAllTreasuryBalances` read (no new contract method). `null` when unmapped; the event is
    // still published (never silently skipped) so F09's handler can reject with a specific,
    // re-drivable reason.
    const { balances } = await this.treasury.getAllTreasuryBalances(undefined, manager);
    const glAccountCode = balances.find((b) => b.treasuryAccountId === settlementAccountId)?.glAccountCode ?? null;

    // --- ADR-042 D3c: ONE transaction — Treasury settlement leg + Collection status + AR ledger +
    // Outbox row all commit together, or none of them do. F09-H3's additive `manager?` on
    // `FinanceTreasuryContract.cashIn`/`.transfer` is what makes this possible without any new
    // transaction architecture. ---
    const saved = await (manager ?? this.dataSource).transaction(async (txManager) => {
      // Stage C / C1: serialise with record/confirm/reject on this shipment and re-read the row under the lock - a concurrent rejection (or a second remit) must not be overtaken
      // by a stale copy. A collection still only `recorded` is confirmed by the remittance itself (finance receiving the money is the strongest confirmation; legacy flow preserved).
      await txManager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`delivery:collection:${collection.shipmentId}`]);
      const fresh = await txManager.getRepository(Collection).findOne({ where: { id: collectionId } });
      if (!fresh) throw new NotFoundException(`Collection "${collectionId}" not found.`);
      if (fresh.remittanceStatus === 'remitted') throw new ConflictException(`Collection "${collectionId}" has already been remitted.`);
      if (fresh.verificationStatus === 'rejected') throw new ConflictException(`Collection "${collectionId}" was rejected - it cannot be remitted.`);
      if (fresh.verificationStatus === 'recorded') {
        fresh.verificationStatus = 'confirmed';
        fresh.confirmedByUserId = actorUserId;
        fresh.confirmedAt = new Date();
      }
      collection.verificationStatus = fresh.verificationStatus;
      collection.confirmedByUserId = fresh.confirmedByUserId;
      collection.confirmedAt = fresh.confirmedAt;

      let settlementTransactionId: string;
      if (isTransfer) {
        const { out } = await this.treasury.transfer(
          collection.custodyAccountId!,
          settlementAccountId,
          collection.amount,
          collection.id,
          'shipping_collection_settlement',
          actorUserId,
          txManager,
        );
        settlementTransactionId = out.id;
      } else {
        const txn = await this.treasury.cashIn(
          settlementAccountId,
          collection.amount,
          cashInCustomerId,
          cashInSalesOrderId,
          collection.id,
          'shipping_collection_remittance',
          actorUserId,
          txManager,
        );
        settlementTransactionId = txn.id;
      }

      collection.remittanceStatus = 'remitted';
      collection.remittedAt = new Date();
      collection.treasuryTransactionId = settlementTransactionId;
      const savedCollection = await txManager.getRepository(Collection).save(collection);

      if (ledgerCustomerId && ledgerSalesOrderId) {
        await this.customerLedger.postEntry(
          {
            customerId: ledgerCustomerId,
            entryType: 'cod_collection',
            direction: 'credit',
            amount: collection.amount,
            salesOrderId: ledgerSalesOrderId,
            invoiceId: linkedInvoiceId,
            shipmentId: collection.shipmentId,
            treasuryTransactionId: settlementTransactionId,
            reference: collection.id,
            reason: `COD remitted (${collection.method})`,
            createdByUserId: actorUserId,
          },
          txManager,
        );
      }

      // ADR-042 D3 — the SOLE GL trigger for a COD collection (`collection.recorded` never gets one,
      // by design). ADR-042 D0 — publisher-built idempotencyKey from this Collection's own real,
      // stable, unique row id.
      await this.events.publish(txManager, 'collection.remitted', {
        idempotencyKey: `collection:${collection.id}:remitted`,
        collectionId: collection.id,
        shipmentId: collection.shipmentId,
        amount: collection.amount,
        businessDate: new Date().toISOString(),
        glAccountCode,
        treasuryTransactionId: settlementTransactionId,
      });

      return savedCollection;
    });
    // F09-H2 (RBW Gap 2) — every other financial-event publisher in this codebase calls this
    // immediately after its transaction commits; `remitCollection` previously did not.
    await this.events.dispatchAfterCommit(manager);

    // A derived, idempotent recalculation (not a source-of-truth write) — kept outside the atomic
    // unit above, same as ADR-042 D3c's own stated scope (Treasury + Collection status + AR ledger
    // + Outbox only).
    if (linkedInvoiceId) await this.invoices.recomputeStatus(linkedInvoiceId, actorUserId, manager);

    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'delivery.collection.remitted',
        resource: 'collection',
        resourceId: collection.id,
        result: 'success',
        correlationId: null,
        after: { treasuryTransactionId: saved.treasuryTransactionId },
      },
      manager,
    );

    return saved;
  }
}

/** Whole cents of a 2-decimal amount string (integer arithmetic for the collected-total invariant - never float sums of money). */
function toCents(amount: string): number {
  return Math.round(Number(amount) * 100);
}
