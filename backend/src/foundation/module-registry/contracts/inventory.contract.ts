import { EntityManager } from 'typeorm';

/**
 * ERP Foundation — P4 Tranche-2. Public contract INVENTORY exposes to
 * SALES's `sales-orders` business domain — breaks the
 * `sales-orders → inventory` edge of the `sales ↔ inventory` cycle
 * (F-MOD-2) via dependency inversion (ADR-024 §4, the same pattern
 * `sales.contract.ts` uses for the reverse `inventory → sales` edge).
 *
 * Bound in inventory-warehouse.module.ts via `useExisting: InventoryService`.
 * Consumed by sales-orders.service.ts and preliminary-hold-expiry.scheduler.ts.
 *
 * Transactional methods take a shared `EntityManager` (a `typeorm` type —
 * neutral third-party, not a coupling to inventory's own code) so
 * sales-orders' multi-step order-edit transactions and inventory's
 * reservation writes still commit atomically in one DB transaction,
 * exactly as before this refactor. `reserveStockInTransaction` /
 * `adjustReservationQuantityInTransaction` return `Promise<unknown>`
 * (never `void`, never the domain's own `StockReservation` entity type —
 * `npm run lint`'s `no-restricted-imports` blocks importing ANYTHING,
 * type-only included, from `domains/*\/infrastructure/**`; `unknown` is
 * correct here anyway since sales-orders never reads the resolved value,
 * only `await`s these calls for their side effect / thrown exception).
 * TypeScript's `implements` check (P4 Task 2 contract-conformance
 * verification) rejects a `Promise<X>` method satisfying a declared
 * `Promise<void>` interface member — `unknown` avoids that pitfall
 * without leaking a domain-internal type across the boundary.
 */

export type ReservationStatusContract = 'preliminary' | 'active' | 'released' | 'fulfilled';

export interface WarehouseSnapshot {
  code: string;
  name: string;
}

export interface InventoryReservationContract {
  /** Rejects (never resolves null) when the warehouse doesn't exist — callers that need a soft-fail already `.catch()` this themselves, unchanged from the pre-refactor direct-import behavior. Area 21 Operational Company Scoping Retrofit (2026-09-27) — `manager?` added, same additive shape as `releasePreliminaryHoldsForOrder` below. */
  getWarehouse(warehouseId: string, manager?: EntityManager): Promise<WarehouseSnapshot>;

  reserveStockInTransaction(
    manager: EntityManager,
    warehouseId: string,
    productId: string,
    quantity: number,
    salesOrderId: string,
    actorUserId: string | null,
    status?: ReservationStatusContract,
  ): Promise<unknown>;

  adjustReservationQuantityInTransaction(
    manager: EntityManager,
    warehouseId: string,
    productId: string,
    salesOrderId: string,
    newQuantity: number,
    actorUserId: string | null,
  ): Promise<unknown>;

  releaseReservationForOrderProductInTransaction(
    manager: EntityManager,
    productId: string,
    salesOrderId: string,
    actorUserId: string | null,
  ): Promise<void>;

  /** Area 21 Operational Company Scoping Retrofit (2026-09-27) — `manager?` added, same additive shape as `releasePreliminaryHoldsForOrder` below. */
  confirmReservationsForOrder(salesOrderId: string, actorUserId: string | null, manager?: EntityManager): Promise<void>;

  /** Multi-Company Area 9 (2026-09-22) — `manager?` added so a company-scoped caller (e.g. `PreliminaryHoldExpiryScheduler`, via `SalesOrdersService.expireHoldForOrder`) can run this against that Company's own connection instead of the ambient one. Falls back to the ambient `DataSource` when omitted, unchanged for every existing caller. */
  releasePreliminaryHoldsForOrder(salesOrderId: string, actorUserId: string | null, reason: string, manager?: EntityManager): Promise<void>;

  /** Multi-Company Area 9 (2026-09-22) — `manager?` added, same reason as `releasePreliminaryHoldsForOrder` above. */
  findExpiredPreliminaryHoldOrderIds(olderThan: Date, manager?: EntityManager): Promise<string[]>;
}
export const INVENTORY_RESERVATION_CONTRACT = Symbol('INVENTORY_RESERVATION_CONTRACT');

/**
 * P4 Tranche-2 (`P4_T2_BLUEPRINT.md` §3) — public contract INVENTORY
 * exposes to LOGISTICS (`shipment`/`delivery`/`returns`) — a materially
 * different surface than `InventoryReservationContract` above (that one
 * is sales-orders' narrow reservation-transaction API; this one is
 * warehouse/stock/relocation operations logistics domains actually call).
 * Grown incrementally, one method set per domain's own migration commit
 * (Blueprint §6 — no domain's PR pre-adds another domain's not-yet-needed
 * methods) — currently covers `shipment` and `delivery`.
 */
export type MovementTypeContract =
  | 'receipt'
  | 'dispatch'
  | 'adjustment'
  | 'transfer_in'
  | 'transfer_out'
  | 'return'
  | 'return_in'
  | 'assembly_consumption'
  | 'assembly_output';

export interface WarehouseView {
  id: string;
  code: string;
  name: string;
  kind: 'main' | 'operational';
  status: 'active' | 'inactive';
}

export interface ReservationView {
  warehouseId: string;
  productId: string;
  quantity: number;
}

export interface StockReportRow {
  warehouseId: string;
  productId: string;
  onHand: number;
  reserved: number;
  available: number;
}

/**
 * Area 21 Operational Company Scoping Retrofit (2026-09-27): `manager?`
 * added to `createWarehouse`/`listWarehouses`/`getStockReport`/
 * `getActiveReservationsForOrder` — the concrete `InventoryService`
 * implementations gained it during `inventory.controller.ts`'s own
 * retrofit (§21); this contract was never widened to match. Discovered
 * while evaluating `shipment.controller.ts`/`returns.controller.ts`
 * (§23/§26), both of which call `createWarehouse`/`findOperationalSubLocation`
 * through this same contract.
 */
export interface InventoryLogisticsContract {
  createWarehouse(
    code: string,
    name: string,
    location: string | null,
    responsibleUserId: string | null,
    parentWarehouseId: string | null,
    kind: 'main' | 'operational',
    manager?: EntityManager,
  ): Promise<{ id: string }>;

  listWarehouses(manager?: EntityManager): Promise<WarehouseView[]>;

  getStockReport(warehouseId?: string, manager?: EntityManager): Promise<StockReportRow[]>;

  getActiveReservationsForOrder(salesOrderId: string, manager?: EntityManager): Promise<ReservationView[]>;

  /** Gap Resolution Package 3 (2026-09-14, row 37) — `manager?` added so `ReturnsService.recordDisposition` can make this call part of its one atomic operation. */
  relocateReservedStock(
    salesOrderId: string,
    productId: string,
    fromWarehouseId: string,
    toWarehouseId: string,
    quantity: number,
    referenceType: string,
    referenceId: string,
    actorUserId: string | null,
    manager?: EntityManager,
  ): Promise<void>;

  /** P4 Tranche-2 (delivery domain). Gap Resolution Package 3 (2026-09-14, row 37) — `manager?` added. */
  fulfillReservationsForOrder(salesOrderId: string, currentWarehouseId: string, actorUserId: string | null, manager?: EntityManager): Promise<void>;

  /**
   * D4 (2026-10-05) — the ORIGINAL cost of a sold product (Σ issue value ÷ Σ issue qty of the order's dispatches), or `null`
   * when it cannot be determined deterministically (the caller fails closed). Pure read.
   */
  resolveOriginalSaleCost(salesOrderId: string, productId: string, manager?: EntityManager): Promise<{ unitCostBase: string; quantity: number } | null>;

  /** D4 (2026-10-05) — returned stock back into the ledger at the ORIGINAL cost (valuation restored, `Dr Inventory / Cr COGS` event). */
  recordSaleReturnIn(
    warehouseId: string,
    productId: string,
    quantity: number,
    unitCostBase: string,
    referenceType: 'sales_return' | 'shipment_return',
    referenceId: string,
    actorUserId: string | null,
    manager?: EntityManager,
  ): Promise<unknown>;

  /** P4 Tranche-2 (returns domain) — only `.id` of the found sub-location is ever read. Area 21: `manager?` added — concrete `InventoryService.findOperationalSubLocation` gained it in the same pass (had none at all before, a genuine concrete gap, not just interface drift). */
  findOperationalSubLocation(parentWarehouseId: string, codePrefix: string, manager?: EntityManager): Promise<{ id: string } | null>;

  /** P4 Tranche-2 (returns domain) — return value never read at any call site. Gap Resolution Package 3 (2026-09-14, row 37) — `manager?` added. */
  recordMovement(
    warehouseId: string,
    productId: string,
    quantity: number,
    movementType: MovementTypeContract,
    referenceType: string | null,
    referenceId: string | null,
    actorUserId: string | null,
    manager?: EntityManager,
  ): Promise<unknown>;

  /** P4 Tranche-2 (returns domain). Gap Resolution Package 3 (2026-09-14, row 37) — `manager?` added so `ReturnsService.recordDisposition` can make this call part of its one atomic operation. */
  releaseReservedQuantity(salesOrderId: string, productId: string, warehouseId: string, quantity: number, actorUserId: string | null, manager?: EntityManager): Promise<void>;
}
export const INVENTORY_LOGISTICS_CONTRACT = Symbol('INVENTORY_LOGISTICS_CONTRACT');

/**
 * P4 Tranche-2 — public contract FULFILLMENT (business domain, `inventory`
 * module) exposes to LOGISTICS. Lives here (not a separate
 * `fulfillment.contract.ts`) because it is small — one method today —
 * matching `finance.contract.ts`'s precedent of holding multiple
 * providing-domains' interfaces in one module-level file.
 */
export interface FulfillmentOrderView {
  salesOrderId: string;
  warehouseId: string;
}

/**
 * Area 21 Operational Company Scoping Retrofit (2026-09-27): `manager?`
 * added to both methods — the concrete `FulfillmentService` implementations
 * gained it during `treasury.controller.ts`'s own retrofit pass (discovered
 * as one of `shipment.controller.ts`'s STOP/ESCALATE blockers,
 * AREA21-RETROFIT-MATRIX.md §26 — Fulfillment has no controller of its own
 * in the 43, so this fix has no other "owning turn" to defer to).
 */
export interface FulfillmentContract {
  getFulfillmentOrder(fulfillmentOrderId: string, manager?: EntityManager): Promise<FulfillmentOrderView>;
  /** P4 Tranche-2 (reports domain) — only `.id` is ever read. */
  getFulfillmentOrderBySalesOrderId(salesOrderId: string, manager?: EntityManager): Promise<{ id: string } | null>;
}
export const FULFILLMENT_CONTRACT = Symbol('FULFILLMENT_CONTRACT');
