import { ModuleManifest } from '../module-manifest.type';

/**
 * ERP Foundation — P1. `inventory` module manifest.
 * Groups the stock-ledger + warehouse-floor domains.
 *
 * `depends_on: ['sales']` — the ACTUAL non-spec code graph (C-8):
 *   - inventory-warehouse/application/inventory.service.ts imports ProductsService, BomService
 *   - inventory-warehouse/application/warehouse-transactions.service.ts imports ProductsService
 *   - inventory-warehouse/interface/inventory.controller.ts imports ProductsService
 * `commerce` (the product master) lives in `sales`, hence the edge. This is
 * the `sales ↔ inventory` cycle (F-MOD-2). Decoupled in P4.
 */
export const inventoryManifest: ModuleManifest = {
  module_code: 'inventory',
  // 1.1.0 — F08 (Inventory Valuation, ADR-041 D1/D24): +2 permission nodes
  //         (`inventory.valuation`, `inventory.valuation.view` — no
  //         `.create`, see §21 note below), +1 feature
  //         (`inventory.valuation`), +1 query. Ships as its own domain
  //         (`inventory-valuation`) under this EXISTING module — no new
  //         licensable module. Moving Average (Weighted Average Cost)
  //         only; no cost-layer/FIFO/Standard-Cost concept. Read-only
  //         reconciliation activation lives on the `accounting` side
  //         (F07's InventoryReconciliationService) — this manifest adds no
  //         reconciliation node of its own.
  manifest_version: '1.1.0',
  title_code: 'module.inventory',
  business_domains: ['inventory-warehouse', 'fulfillment', 'inventory-valuation'],
  depends_on: ['sales'],

  permission_nodes: [
    { node: 'inventory', title_code: 'perm.inventory' },

    { node: 'inventory.warehouse', title_code: 'perm.inventory.warehouse', parent: 'inventory' },
    { node: 'inventory.warehouse.view', title_code: 'perm.inventory.warehouse.view', parent: 'inventory.warehouse' },
    { node: 'inventory.warehouse.create', title_code: 'perm.inventory.warehouse.create', parent: 'inventory.warehouse' },
    { node: 'inventory.warehouse.edit', title_code: 'perm.inventory.warehouse.edit', parent: 'inventory.warehouse' },

    { node: 'inventory.stock', title_code: 'perm.inventory.stock', parent: 'inventory' },
    { node: 'inventory.stock.view', title_code: 'perm.inventory.stock.view', parent: 'inventory.stock' },
    { node: 'inventory.stock.export', title_code: 'perm.inventory.stock.export', parent: 'inventory.stock' },

    { node: 'inventory.movement', title_code: 'perm.inventory.movement', parent: 'inventory' },
    { node: 'inventory.movement.view', title_code: 'perm.inventory.movement.view', parent: 'inventory.movement' },
    { node: 'inventory.movement.create', title_code: 'perm.inventory.movement.create', parent: 'inventory.movement' },

    { node: 'inventory.transaction', title_code: 'perm.inventory.transaction', parent: 'inventory' },
    { node: 'inventory.transaction.view', title_code: 'perm.inventory.transaction.view', parent: 'inventory.transaction' },
    { node: 'inventory.transaction.create', title_code: 'perm.inventory.transaction.create', parent: 'inventory.transaction' },

    { node: 'inventory.stock_count', title_code: 'perm.inventory.stock_count', parent: 'inventory' },
    { node: 'inventory.stock_count.create', title_code: 'perm.inventory.stock_count.create', parent: 'inventory.stock_count' },
    { node: 'inventory.stock_count.adjust', title_code: 'perm.inventory.stock_count.adjust', parent: 'inventory.stock_count' },

    { node: 'inventory.reservation', title_code: 'perm.inventory.reservation', parent: 'inventory' },
    { node: 'inventory.reservation.view', title_code: 'perm.inventory.reservation.view', parent: 'inventory.reservation' },
    // P4 Tranche-2 (2026-09-06): 2 leaf nodes added — P1's first-pass list
    // had .view only; reserveStock/releaseReservation need their own
    // action nodes (P1's own handoff note: "P4 finalizes the exact
    // node↔route mapping when it applies @RequirePermission per domain").
    { node: 'inventory.reservation.create', title_code: 'perm.inventory.reservation.create', parent: 'inventory.reservation' },
    { node: 'inventory.reservation.release', title_code: 'perm.inventory.reservation.release', parent: 'inventory.reservation' },

    { node: 'inventory.assembly', title_code: 'perm.inventory.assembly', parent: 'inventory' },
    { node: 'inventory.assembly.create', title_code: 'perm.inventory.assembly.create', parent: 'inventory.assembly' },

    { node: 'inventory.fulfillment', title_code: 'perm.inventory.fulfillment', parent: 'inventory' },
    { node: 'inventory.fulfillment.view', title_code: 'perm.inventory.fulfillment.view', parent: 'inventory.fulfillment' },
    { node: 'inventory.fulfillment.assign', title_code: 'perm.inventory.fulfillment.assign', parent: 'inventory.fulfillment' },
    { node: 'inventory.fulfillment.edit', title_code: 'perm.inventory.fulfillment.edit', parent: 'inventory.fulfillment' },

    // F08 — Inventory Valuation (ADR-041 D24, revised during implementation — CTO §21: no node
    // without a real route behind it). Exactly ONE node: `.view` gates the one real endpoint this
    // domain ships, `GET /inventory/valuation/current-cost` (Blueprint §8/§9). Reconciliation
    // RUNS through F07's EXISTING `accounting.inventory.create`/`.view` nodes
    // (`InventoryAccountingController`, built in F07) — F08 adds no second reconciliation route of
    // its own, so no `.create` node is added here. No `.adjust`/`.approve` node either — the only
    // write path for inventory financial adjustments stays inside F07's existing
    // `accounting.inventory.adjust`/`.approve` nodes (D11/D21) — F08 does not duplicate FA-01.
    { node: 'inventory.valuation', title_code: 'perm.inventory.valuation', parent: 'inventory' },
    { node: 'inventory.valuation.view', title_code: 'perm.inventory.valuation.view', parent: 'inventory.valuation' },
  ],

  feature_codes: [
    { code: 'inventory.warehouse', title_code: 'feat.inventory.warehouse', default: true, toggleable: false },
    { code: 'inventory.stock_ledger', title_code: 'feat.inventory.stock_ledger', default: true, toggleable: false },
    { code: 'inventory.stock_count', title_code: 'feat.inventory.stock_count', default: true, toggleable: true },
    { code: 'inventory.assembly', title_code: 'feat.inventory.assembly', default: false, toggleable: true },
    { code: 'inventory.fulfillment', title_code: 'feat.inventory.fulfillment', default: true, toggleable: true },
    { code: 'inventory.excel_import', title_code: 'feat.inventory.excel_import', default: true, toggleable: true },
    // F08 — Moving-Average valuation mechanism + the one read-only current-cost endpoint. Part of
    // the module, not a separate SKU (mirrors F04-F07's own `accounting.*` non-toggleable features).
    { code: 'inventory.valuation', title_code: 'feat.inventory.valuation', default: true, toggleable: false },
  ],

  limit_keys: [
    { key: 'inventory.max_warehouses', title_code: 'limit.inventory.max_warehouses', unit: 'count', default: null },
    { key: 'inventory.movements_per_month', title_code: 'limit.inventory.movements_per_month', unit: 'per_month', default: null },
  ],

  config_keys: [
    {
      key: 'inventory.negative_stock_allowed',
      type: 'bool',
      default: false,
      scope_levels: ['platform', 'edition', 'installation'],
    },
    // C3 (ADR-INV-03) - segregation of duties on warehouse documents with a financial effect: `off` = no check (pre-C3), `warn` = allow and audit
    // `warehouse_transaction.sod_violation`, `on` = refuse the creator approving / posting their own document. Staged: C3 ships `warn`; the switch to `on` is C5.
    {
      key: 'inventory.document_sod_enforced',
      type: 'enum',
      allowed: ['off', 'warn', 'on'],
      default: 'warn',
      scope_levels: ['platform', 'edition', 'installation'],
    },
    // C3 (ADR-INV-03) - a manual receipt (a receipt document with a reason code, i.e. with a financial effect) waits for approval instead of auto-posting on
    // submit. `off` (default) keeps today's straight-through behaviour; `on` makes it draft -> submitted -> approved -> posted. Reversal documents are unaffected.
    {
      key: 'inventory.receipt_approval_required',
      type: 'enum',
      allowed: ['off', 'on'],
      default: 'off',
      scope_levels: ['platform', 'edition', 'installation'],
    },
    {
      key: 'inventory.reservation_hold_minutes',
      type: 'int',
      allowed: { min: 5, max: 1440 },
      default: 60,
      scope_levels: ['platform', 'edition', 'installation'],
    },
  ],

  migration_tag: 'inventory',

  public_contract: {
    commands: ['RecordMovement', 'ReserveStock', 'ReleaseReservation', 'TransferStock', 'CreateFulfillmentOrder', 'CompletePick', 'CompletePack'],
    // F08 — GetCurrentValuationCost backs the one new read-only endpoint.
    queries: ['GetStockLevel', 'GetStockSummaryByWarehouse', 'GetReservationsByOrder', 'GetFulfillmentStatus', 'GetCurrentValuationCost'],
    events: ['inventory.stock.reserved', 'inventory.movement.recorded', 'inventory.transfer.completed', 'fulfillment.pick.completed', 'fulfillment.pack.completed', 'fulfillment.ready-for-dispatch'],
  },
};
