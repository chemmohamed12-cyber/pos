import { ModuleManifest } from '../module-manifest.type';

/**
 * ERP Foundation — P1. `logistics` module manifest.
 * Groups dispatch → tracking → delivery outcome → returns.
 *
 * `depends_on: ['sales', 'inventory', 'finance']` — the ACTUAL non-spec code
 * graph (C-8):
 *   - shipment/delivery/returns → sales-orders (SalesOrdersService), crm (CustomersService)
 *   - shipment/delivery/returns → inventory-warehouse (InventoryService), fulfillment (FulfillmentService)
 *   - shipment/delivery/returns → treasury (TreasuryService), customer-finance (CustomerLedger/Invoice services)
 * `tracking` has no controller of its own (wired through `shipment`); its
 * entities carry the `logistics` migration tag. Decoupled in P4 (logistics
 * is step 3 in the CTO's decoupling order).
 */
export const logisticsManifest: ModuleManifest = {
  module_code: 'logistics',
  // 1.1.0 — F09-H2 (ADR-042 D3): `remitCollection` now publishes `collection.remitted` (a NEW
  // event; it published nothing at remittance time before) — the sole GL trigger for a COD
  // collection, consumed by `accounting`'s Financial Event Engine via the Transactional Outbox
  // (no new manifest dependency edge — events, never imports, same as `collection.recorded`
  // already establishes). No operational behavior change to `delivery`/`remitCollection` itself.
  // 1.2.0 — Sales/Shipment/Returns workflow review (CTO directive, 2026-09-16): +6 permission
  // nodes (logistics.shipment_return.*, logistics.sales_return.*), +1 config key
  // (logistics.sales_return_eligibility_window_days). ShipmentReturn/SalesReturn are new,
  // additive aggregates in the `returns` business_domain -- ReturnRequest and its existing
  // nodes/events are completely untouched. Neither new aggregate publishes an EventBusService
  // event in V1 (no automatic financial posting was ratified for this batch), so
  // public_contract.events is deliberately NOT extended here -- declaring an event nothing
  // publishes would repeat the exact manifest/code mismatch the RBW already found on
  // sales.manifest.ts.
  // 1.3.0 — D4 (Returns accounting, 2026-10-05, CTO-approved): completing a Sales Return / Shipment Return of an
  // INVOICED sale now publishes `returns.sale_return.credited` (Revenue/AR/tax reversal) — a real publisher exists, so
  // the event is declared (1.2.0's note above no longer applies). Additive columns only (migration
  // `AddReturnFinancialSnapshot`); no new permission node, no new dependency edge (events + contracts, never imports).
  manifest_version: '1.3.0',
  title_code: 'module.logistics',
  business_domains: ['shipment', 'tracking', 'delivery', 'returns'],
  depends_on: ['sales', 'inventory', 'finance'],

  permission_nodes: [
    { node: 'logistics', title_code: 'perm.logistics' },

    { node: 'logistics.shipment', title_code: 'perm.logistics.shipment', parent: 'logistics' },
    { node: 'logistics.shipment.view', title_code: 'perm.logistics.shipment.view', parent: 'logistics.shipment' },
    { node: 'logistics.shipment.create', title_code: 'perm.logistics.shipment.create', parent: 'logistics.shipment' },
    { node: 'logistics.shipment.assign', title_code: 'perm.logistics.shipment.assign', parent: 'logistics.shipment' },
    { node: 'logistics.shipment.edit', title_code: 'perm.logistics.shipment.edit', parent: 'logistics.shipment' },

    { node: 'logistics.carrier', title_code: 'perm.logistics.carrier', parent: 'logistics' },
    { node: 'logistics.carrier.view', title_code: 'perm.logistics.carrier.view', parent: 'logistics.carrier' },
    { node: 'logistics.carrier.create', title_code: 'perm.logistics.carrier.create', parent: 'logistics.carrier' },
    { node: 'logistics.carrier.edit', title_code: 'perm.logistics.carrier.edit', parent: 'logistics.carrier' },

    { node: 'logistics.vehicle', title_code: 'perm.logistics.vehicle', parent: 'logistics' },
    { node: 'logistics.vehicle.view', title_code: 'perm.logistics.vehicle.view', parent: 'logistics.vehicle' },
    { node: 'logistics.vehicle.create', title_code: 'perm.logistics.vehicle.create', parent: 'logistics.vehicle' },
    { node: 'logistics.vehicle.edit', title_code: 'perm.logistics.vehicle.edit', parent: 'logistics.vehicle' },

    { node: 'logistics.tracking', title_code: 'perm.logistics.tracking', parent: 'logistics' },
    { node: 'logistics.tracking.view', title_code: 'perm.logistics.tracking.view', parent: 'logistics.tracking' },

    { node: 'logistics.delivery', title_code: 'perm.logistics.delivery', parent: 'logistics' },
    { node: 'logistics.delivery.view', title_code: 'perm.logistics.delivery.view', parent: 'logistics.delivery' },
    { node: 'logistics.delivery.post', title_code: 'perm.logistics.delivery.post', parent: 'logistics.delivery' },

    { node: 'logistics.collection', title_code: 'perm.logistics.collection', parent: 'logistics' },
    { node: 'logistics.collection.view', title_code: 'perm.logistics.collection.view', parent: 'logistics.collection' },
    { node: 'logistics.collection.post', title_code: 'perm.logistics.collection.post', parent: 'logistics.collection' },

    { node: 'logistics.return', title_code: 'perm.logistics.return', parent: 'logistics' },
    { node: 'logistics.return.view', title_code: 'perm.logistics.return.view', parent: 'logistics.return' },
    { node: 'logistics.return.create', title_code: 'perm.logistics.return.create', parent: 'logistics.return' },
    { node: 'logistics.return.approve', title_code: 'perm.logistics.return.approve', parent: 'logistics.return' },
    { node: 'logistics.return.reject', title_code: 'perm.logistics.return.reject', parent: 'logistics.return' },
    // P4 Tranche-2 (2026-09-06) — `applyCreditToInvoice` doesn't fit
    // create/approve/reject (it's a financial write, applying an
    // existing Return Credit's amount to an invoice's AR, not a return-
    // request lifecycle transition); 'adjust' is the closed-list verb
    // that actually matches.
    { node: 'logistics.return.adjust', title_code: 'perm.logistics.return.adjust', parent: 'logistics.return' },

    // Sales/Shipment/Returns workflow review (CTO directive, 2026-09-16) — new, additive nodes.
    // 'post' mirrors this same manifest's own logistics.delivery.post/logistics.collection.post
    // precedent for "commits a real inventory/ledger effect", not a new verb.
    { node: 'logistics.shipment_return', title_code: 'perm.logistics.shipment_return', parent: 'logistics' },
    { node: 'logistics.shipment_return.view', title_code: 'perm.logistics.shipment_return.view', parent: 'logistics.shipment_return' },
    { node: 'logistics.shipment_return.create', title_code: 'perm.logistics.shipment_return.create', parent: 'logistics.shipment_return' },
    { node: 'logistics.shipment_return.post', title_code: 'perm.logistics.shipment_return.post', parent: 'logistics.shipment_return' },

    { node: 'logistics.sales_return', title_code: 'perm.logistics.sales_return', parent: 'logistics' },
    { node: 'logistics.sales_return.view', title_code: 'perm.logistics.sales_return.view', parent: 'logistics.sales_return' },
    { node: 'logistics.sales_return.create', title_code: 'perm.logistics.sales_return.create', parent: 'logistics.sales_return' },
    { node: 'logistics.sales_return.post', title_code: 'perm.logistics.sales_return.post', parent: 'logistics.sales_return' },
  ],

  feature_codes: [
    { code: 'logistics.shipment', title_code: 'feat.logistics.shipment', default: true, toggleable: false },
    { code: 'logistics.tracking', title_code: 'feat.logistics.tracking', default: true, toggleable: true },
    { code: 'logistics.cod_collection', title_code: 'feat.logistics.cod_collection', default: true, toggleable: true },
    { code: 'logistics.returns', title_code: 'feat.logistics.returns', default: true, toggleable: true },
    { code: 'logistics.own_fleet', title_code: 'feat.logistics.own_fleet', default: true, toggleable: true },
  ],

  limit_keys: [
    { key: 'logistics.max_carriers', title_code: 'limit.logistics.max_carriers', unit: 'count', default: null },
    { key: 'logistics.max_vehicles', title_code: 'limit.logistics.max_vehicles', unit: 'count', default: null },
    { key: 'logistics.shipments_per_month', title_code: 'limit.logistics.shipments_per_month', unit: 'per_month', default: null },
  ],

  config_keys: [
    {
      key: 'logistics.auto_create_shipment_on_release',
      type: 'bool',
      default: false,
      scope_levels: ['platform', 'edition', 'installation'],
    },
    {
      key: 'logistics.remittance_grace_days',
      type: 'int',
      allowed: { min: 0, max: 30 },
      default: 3,
      scope_levels: ['platform', 'edition', 'installation'],
    },
    /**
     * Sales/Shipment/Returns workflow review (CTO ratification, 2026-09-16):
     * "Return Eligibility Window = 1 Year" must be a configurable Business
     * Rule, never a hardcoded UI literal. Read by `SalesReturnsService.
     * getEligibilityWindowDays()`. Anchor date is the sold order's own
     * `createdAt` (V1 disclosed fallback), window computed backward from
     * the RETURN date — never today's date, never the order date alone.
     */
    {
      key: 'logistics.sales_return_eligibility_window_days',
      type: 'int',
      allowed: { min: 1, max: 3650 },
      default: 365,
      scope_levels: ['platform', 'edition', 'installation'],
    },
  ],

  migration_tag: 'logistics',

  public_contract: {
    commands: ['CreateShipmentRequest', 'AssignDriver', 'RecordTrackingEvent', 'RecordDeliveryOutcome', 'RecordCollection', 'RequestReturn', 'AuthorizeReturn', 'RecordInspection', 'CreateShipmentReturn', 'CompleteShipmentReturn', 'CreateSalesReturn', 'CompleteSalesReturn'],
    queries: ['GetShipmentStatus', 'GetWaybillHistory', 'GetLiveLocation', 'GetDeliveryOutcome', 'GetReturnStatus', 'GetShipmentDetail', 'ListEligibleReturnPurchaseLines', 'ListShipmentReturns', 'ListSalesReturns'],
    // F09-H2 — 'collection.remitted' added.
    events: ['shipment.offer.created', 'shipment.assignment.accepted', 'shipment.dispatched', 'waybill.status.changed', 'delivery.completed', 'delivery.failed', 'collection.recorded', 'collection.remitted', 'return.completed', 'return.disposition.recorded', 'returns.sale_return.credited'],
  },
};
