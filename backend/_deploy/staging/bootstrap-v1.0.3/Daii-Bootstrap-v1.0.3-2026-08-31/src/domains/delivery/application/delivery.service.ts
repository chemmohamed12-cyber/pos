import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DeliveryOutcome } from '../infrastructure/delivery-outcome.entity';
import { Collection } from '../infrastructure/collection.entity';
import { DeliveryOutcomeType } from '../domain/delivery-outcome-type';
import { ShipmentService } from '../../shipment/application/shipment.service';
import { FulfillmentService } from '../../fulfillment/application/fulfillment.service';
import { SalesOrdersService } from '../../sales-orders/application/sales-orders.service';
import { TreasuryService } from '../../treasury/application/treasury.service';
import { InventoryService } from '../../inventory-warehouse/application/inventory.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { CustomerLedgerService } from '../../customer-finance/application/customer-ledger.service';
import { InvoiceService } from '../../customer-finance/application/invoices.service';

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
export class DeliveryService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly shipments: ShipmentService,
    private readonly fulfillment: FulfillmentService,
    private readonly salesOrders: SalesOrdersService,
    private readonly treasury: TreasuryService,
    private readonly inventory: InventoryService,
    private readonly audit: AuditService,
    private readonly events: EventBusService,
    private readonly customerLedger: CustomerLedgerService,
    private readonly invoices: InvoiceService,
  ) {}

  async recordOutcome(
    shipmentId: string,
    outcome: DeliveryOutcomeType,
    failureReason: string | null,
    actorUserId: string,
  ): Promise<DeliveryOutcome> {
    const action = OUTCOME_TO_SHIPMENT_ACTION[outcome];
    if (action) {
      await this.shipments.transitionShipment(shipmentId, action, actorUserId);
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
      const shipment = await this.shipments.getShipmentSnapshot(shipmentId);
      const fulfillmentOrder = await this.fulfillment.getFulfillmentOrder(shipment!.fulfillmentOrderId);
      const currentWarehouseId = (await this.shipments.getCurrentCustodyWarehouseId(shipmentId)) ?? fulfillmentOrder.warehouseId;
      await this.inventory.fulfillReservationsForOrder(fulfillmentOrder.salesOrderId, currentWarehouseId, actorUserId);
    }

    const record = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(DeliveryOutcome);
      const saved = await repo.save(repo.create({ shipmentId, outcome, failureReason, recordedByUserId: actorUserId }));
      // Finance-ready event per ADR-018 — self-contained payload, no callback into Shipment needed later.
      await this.events.publish(manager, `delivery.${outcome === 'delivered' ? 'completed' : outcome}`, {
        shipmentId,
        outcome,
        failureReason,
        businessDate: new Date().toISOString(),
      });
      return saved;
    });

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: `delivery.outcome.${outcome}`,
      resource: 'delivery_outcome',
      resourceId: record.id,
      result: 'success',
      correlationId: null,
      after: { shipmentId, outcome, failureReason },
    });

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
  ): Promise<Collection> {
    // V1 Release Audit MEDIUM fix — unlike recordOutcome (which delegates
    // to transitionShipment's own check), this had no assigned-driver/
    // admin verification at all; any authenticated user could record a
    // fabricated cash collection against any shipment.
    await this.shipments.assertDriverOrAdmin(shipmentId, collectorUserId);

    // Shipping Screen Redesign directive §8/§13 — idempotency: nothing
    // previously stopped a double-click (or a retried request) from
    // calling this endpoint twice for the same shipment and posting two
    // Treasury cash-in entries for one real-world collection. A shipment
    // has at most one real COD collection event, same invariant
    // `ReturnsService.initiateCustodyReturn` already relies on via this
    // exact method — reused here as a guard, not duplicated.
    const existing = await this.getCollectionForShipmentUnscoped(shipmentId);
    if (existing) {
      throw new ConflictException(`Shipment "${shipmentId}" already has a recorded collection (${existing.id}) — cannot record a second one.`);
    }

    const custodian = await this.shipments.getCustodianForShipment(shipmentId);
    let custodyTransactionId: string | null = null;
    if (custodian) {
      const shipmentSnapshot = await this.shipments.getShipmentSnapshot(shipmentId);
      const fulfillmentOrder = await this.fulfillment.getFulfillmentOrder(shipmentSnapshot!.fulfillmentOrderId);
      const orderSnapshot = await this.salesOrders.getOrderSnapshot(fulfillmentOrder.salesOrderId);
      const custodyTxn = await this.treasury.cashIn(
        custodian.custodyAccountId,
        amount,
        orderSnapshot?.customerId ?? null,
        fulfillmentOrder.salesOrderId,
        shipmentId,
        'cod_collection_custody',
        collectorUserId,
      );
      custodyTransactionId = custodyTxn.id;
    }

    const collection = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(Collection);
      const saved = await repo.save(
        repo.create({
          shipmentId,
          amount,
          method,
          collectorUserId,
          custodyAccountId: custodian?.custodyAccountId ?? null,
          custodyTransactionId,
        }),
      );
      // Finance-ready event (ADR-018) — amount, currency-implicit (EGP, same as Deposit Control),
      // party, and date all present without a Finance callback into Delivery.
      await this.events.publish(manager, 'collection.recorded', {
        shipmentId,
        amount,
        method,
        collectorUserId,
        businessDate: new Date().toISOString(),
      });
      return saved;
    });

    await this.audit.record({
      actorUserId: collectorUserId,
      organizationId: null,
      action: 'delivery.collection.recorded',
      resource: 'collection',
      resourceId: collection.id,
      result: 'success',
      correlationId: null,
      after: { shipmentId, amount, method, custodyAccountId: collection.custodyAccountId, custodyTransactionId },
    });

    return collection;
  }

  /**
   * Backs the Delivery print document — didn't exist before (outcomes/
   * collections were write-only). V1 Release Audit MEDIUM fix (IDOR):
   * had no assigned-driver/admin check; reused from ShipmentService
   * rather than duplicated (see recordCollection).
   */
  async getOutcomeForShipment(shipmentId: string, actorUserId: string): Promise<DeliveryOutcome | null> {
    await this.shipments.assertDriverOrAdmin(shipmentId, actorUserId);
    return this.dataSource.getRepository(DeliveryOutcome).findOne({ where: { shipmentId }, order: { occurredAt: 'DESC' } });
  }

  async getCollectionForShipment(shipmentId: string, actorUserId: string): Promise<Collection | null> {
    await this.shipments.assertDriverOrAdmin(shipmentId, actorUserId);
    return this.dataSource.getRepository(Collection).findOne({ where: { shipmentId }, order: { occurredAt: 'DESC' } });
  }

  /**
   * Backs a finance/admin "awaiting settlement" queue — every Collection
   * not yet remitted to Treasury. Unscoped by driver/admin on purpose:
   * finance staff reviewing what's owed were never the assigned driver
   * on any of these shipments.
   */
  async listPendingRemittances(): Promise<Collection[]> {
    return this.dataSource.getRepository(Collection).find({ where: { remittanceStatus: 'pending' }, order: { occurredAt: 'ASC' } });
  }

  /**
   * Same "unscoped by driver/admin" precedent as `listPendingRemittances`
   * above — Custody/COD Reporting (CTO directive, Phase 5) needs every
   * Collection ever recorded, grouped by `custodyAccountId`, not one
   * driver's own deliveries.
   */
  async listAllCollections(): Promise<Collection[]> {
    return this.dataSource.getRepository(Collection).find({ order: { occurredAt: 'ASC' } });
  }

  /**
   * Same "unscoped by driver/admin" precedent as `listPendingRemittances`
   * above — the Customer Account statement (CTO directive — Customer
   * Account Foundation) needs a shipment's collection for a cross-order
   * financial history view, not a driver acting on their own delivery.
   */
  async getCollectionForShipmentUnscoped(shipmentId: string): Promise<Collection | null> {
    return this.dataSource.getRepository(Collection).findOne({ where: { shipmentId }, order: { occurredAt: 'DESC' } });
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
  async remitCollection(collectionId: string, actorUserId: string, treasuryAccountId?: string | null): Promise<Collection> {
    const repo = this.dataSource.getRepository(Collection);
    const collection = await repo.findOne({ where: { id: collectionId } });
    if (!collection) throw new NotFoundException(`Collection "${collectionId}" not found.`);
    if (collection.remittanceStatus === 'remitted') {
      throw new ConflictException(`Collection "${collectionId}" has already been remitted.`);
    }

    let settlementTransactionId: string;

    if (collection.custodyAccountId) {
      // Path 1 — transfer OUT of the custody leg already posted at collection time.
      let resolvedSettlementAccountId = treasuryAccountId ?? null;
      if (!resolvedSettlementAccountId) {
        const custodian = await this.shipments.getCustodianForShipment(collection.shipmentId);
        resolvedSettlementAccountId = custodian?.settlementAccountId ?? null;
      }
      if (!resolvedSettlementAccountId) {
        throw new BadRequestException(
          'No settlement Treasury account to remit into — either supply treasuryAccountId, or set one on this custodian first.',
        );
      }
      const { out } = await this.treasury.transfer(
        collection.custodyAccountId,
        resolvedSettlementAccountId,
        collection.amount,
        collection.id,
        'shipping_collection_settlement',
        actorUserId,
      );
      settlementTransactionId = out.id;
    } else {
      // Path 2 — no custody leg exists (custodian-less collection); original direct-cashIn behavior.
      if (!treasuryAccountId) {
        throw new BadRequestException(
          'No Treasury account to remit into — this collection has no custody account, so treasuryAccountId is required.',
        );
      }
      const shipment = await this.shipments.getShipmentSnapshot(collection.shipmentId);
      if (!shipment) throw new NotFoundException(`Shipment "${collection.shipmentId}" not found.`);
      const fulfillmentOrder = await this.fulfillment.getFulfillmentOrder(shipment.fulfillmentOrderId);
      const orderSnapshot = await this.salesOrders.getOrderSnapshot(fulfillmentOrder.salesOrderId);
      const txn = await this.treasury.cashIn(
        treasuryAccountId,
        collection.amount,
        orderSnapshot?.customerId ?? null,
        fulfillmentOrder.salesOrderId,
        collection.id,
        'shipping_collection_remittance',
        actorUserId,
      );
      settlementTransactionId = txn.id;
    }

    collection.remittanceStatus = 'remitted';
    collection.remittedAt = new Date();
    collection.treasuryTransactionId = settlementTransactionId;
    const saved = await repo.save(collection);

    // Customer Financial Account / AR (CTO directive) — bridges the
    // EXISTING COD/Collection flow (reconciled above, unchanged) into the
    // Customer Ledger: money already left the custodian and landed in a
    // real company Treasury account by this point, so this is where AR
    // actually gets reduced, not at mere collection time (the custody
    // leg posted at `recordCollection` is Treasury-internal, not yet
    // "money the company can call its own").
    const shipmentForLedger = await this.shipments.getShipmentSnapshot(collection.shipmentId);
    if (shipmentForLedger) {
      const fulfillmentOrderForLedger = await this.fulfillment.getFulfillmentOrder(shipmentForLedger.fulfillmentOrderId);
      const orderSnapshotForLedger = await this.salesOrders.getOrderSnapshot(fulfillmentOrderForLedger.salesOrderId);
      if (orderSnapshotForLedger) {
        const existingInvoice = await this.invoices.findOpenInvoiceForOrder(fulfillmentOrderForLedger.salesOrderId);
        const existingInvoiceState = existingInvoice ? await this.invoices.getStatus(existingInvoice.id) : null;
        const linkedInvoiceId = existingInvoiceState === 'posted' || existingInvoiceState === 'partially_paid' ? existingInvoice!.id : null;

        await this.customerLedger.postEntry({
          customerId: orderSnapshotForLedger.customerId,
          entryType: 'cod_collection',
          direction: 'credit',
          amount: collection.amount,
          salesOrderId: fulfillmentOrderForLedger.salesOrderId,
          invoiceId: linkedInvoiceId,
          shipmentId: collection.shipmentId,
          treasuryTransactionId: settlementTransactionId,
          reference: collection.id,
          reason: `COD remitted (${collection.method})`,
          createdByUserId: actorUserId,
        });
        if (linkedInvoiceId) await this.invoices.recomputeStatus(linkedInvoiceId, actorUserId);
      }
    }

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'delivery.collection.remitted',
      resource: 'collection',
      resourceId: collection.id,
      result: 'success',
      correlationId: null,
      after: { treasuryTransactionId: settlementTransactionId },
    });

    return saved;
  }
}
