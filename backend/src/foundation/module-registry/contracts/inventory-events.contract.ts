import { EntityManager } from 'typeorm';

/**
 * F07 — Inventory Accounting (ADR-040 D2/D3/D9). The Inventory↔GL event
 * boundary. Defined here in `foundation/module-registry/contracts/` — the
 * one place `inventory-warehouse` (the publisher, F07-H1) and `accounting`
 * (the consumer, F08's handler bridge) may both import from
 * (`no-restricted-imports` blocks a direct cross-domain import).
 *
 * `inventory.movement.recorded` is NOT a new topic — it was already
 * reserved by F03 (`SUBSCRIBED_TOPICS`, `DOMAIN_OF_TOPIC['inventory.movement.recorded']
 * = 'inventory'`), subscribed-but-`IGNORED` since F03 shipped, then given a
 * real handler by F07 (fail-closed, `no_valuation_source`), then a real
 * cost source by F08.
 *
 * **`InventoryValuationContract` (ADR-041 D18a/D18b) — extended once,
 * proven necessary during F08 implementation, recorded here per the rule
 * "don't change the contract unless implementation proves it necessary":**
 * `getUnitCost` keeps its EXACT original shape and is genuinely pure — no
 * mutation, ever — used only for read-only reference (e.g. an FA-01 maker
 * consulting the current cost before typing an adjustment amount). The
 * original shape had no way to express "consume N units, exactly once,"
 * so a NEW method, `consumeIssueCost`, was added for that — the ONLY
 * method F07's ingest-time handler bridge calls, always inside the SAME
 * transaction as GL posting (its `manager` parameter — also new, additive,
 * on every method here — is how that transaction is threaded through).
 */

/** Common envelope on every Inventory event. */
export interface InventoryEventBase {
  /** REQUIRED, unique per real occurrence — `inventory:movement:<stockMovementId>:recorded` (ADR-040 D9). */
  idempotencyKey: string;
  /** ISO date — drives fiscal-period resolution in F03's posting gate. */
  businessDate: string;
  orgUnitId: string | null;
  sourceEntityType: 'stock_movement';
  sourceEntityId: string;
  /** Generic external-document reference at emission time (E-02) — not set by F07 today. */
  externalDocument: { type: string; id: string; status: string | null; secondaryId: string | null } | null;
  payloadVersion: number;
}

/**
 * D3 (2026-10-04) — which accounting treatment a published movement gets (the handler routes on this, never on
 * inference). See `D3-INVENTORY-POSTING-POLICY-2026-10-04.md`. `'dispatch'` is also the meaning of an event with no
 * `glKind` (events published before D3).
 */
export type InventoryGlKind = 'dispatch' | 'opening_stock' | 'manual_receipt' | 'adjustment' | 'return_in';

/**
 * `inventory.movement.recorded` — one allow-listed stock movement (ADR-040 D2, extended by D3 to opening stock,
 * adjustments and return-in; see `glKindFor` in `inventory.service.ts`). Quantity is always present. Cost fields
 * are `null` except for `'opening_stock'`, where they carry the maker-SUPPLIED unit cost and its total (an input,
 * never a derived value); every other kind sources cost from the valuation engine at ingest time.
 */
export interface InventoryMovementRecordedEvent extends InventoryEventBase {
  movementType: string;
  /** D3 — routing key for the accounting handler; absent on pre-D3 events (= dispatch). */
  glKind?: InventoryGlKind;
  /** D3-B — the controlled reason code of a `'manual_receipt'` (drives the configured offset account). */
  reasonCode?: string | null;
  productId: string;
  warehouseId: string;
  /** signed — negative for a dispatch (stock leaving). */
  quantity: number;
  referenceType: string | null;
  referenceId: string | null;
  /** D3 — always `null` in F07; F08's attachment point. */
  unitCostBase: string | null;
  /** D3 — always `null` in F07; F08's attachment point. */
  totalCostBase: string | null;
}

export const INVENTORY_EVENT_TOPICS = {
  movementRecorded: 'inventory.movement.recorded',
} as const;

/** The Inventory topics with a real publisher wired in F07 (F07-H1). */
export const INVENTORY_EVENT_TOPICS_V1: readonly string[] = [INVENTORY_EVENT_TOPICS.movementRecorded] as const;

/**
 * F07's own internal event type for an approved inventory financial
 * adjustment — emitted (via `FinancialEventService.ingest`) by F07's FA-01
 * approval subscriber and consumed by F07's own handler → the F03 posting
 * gate → GL. Not cross-domain (`sourceDomain: 'accounting'`).
 */
export const INVENTORY_ADJUSTMENT_APPROVED_EVENT = 'accounting.inventory.adjustment.approved';

// ---------------------------------------------------------------------------
// Valuation contract (for F08 to provide) — dormant
// ---------------------------------------------------------------------------

/**
 * `InventoryReconciliationService` MAY inject this `@Optional()`.
 * **Unbound today** (ADR-040 D3/D10) — F07's reconciliation reports
 * `no_valuation_source` and shows the GL `inventory` control-account
 * balance for reference only, never `matched`. The future F08 (Inventory
 * Valuation — FIFO/moving-average/standard cost) domain binds an
 * implementation to light this up, with zero F07 change.
 */
export interface ValuedPositionFilter {
  warehouseIds?: string[];
  productId?: string;
}

export interface ValuedPosition {
  warehouseId: string;
  productId: string;
  quantity: number;
  totalValueBase: string;
  /** `totalValueBase / quantity` at 4 dp, or NULL when the quantity is not positive. */
  averageCostBase: string | null;
}

export interface HistoryInconsistency {
  warehouseId: string;
  productId: string;
  stateQuantity: number;
  historyQuantity: number;
  stateValueBase: string;
  historyValueBase: string;
}

export interface InventoryValuationContract {
  /** The valued on-hand position per warehouse, as of a date. Read-only. */
  getValuedOnHandTotal(asOfDate?: string, manager?: EntityManager): Promise<Array<{ warehouseId: string; totalValueBase: string }>>;
  /** C1 (ADR-INV-08) - OPTIONAL, read-only: the valued position per warehouse and product, current (no date / today) or rebuilt from the dated history. */
  getValuedPositions?(asOfDate?: string, filter?: ValuedPositionFilter, manager?: EntityManager): Promise<ValuedPosition[]>;
  /** C1 - OPTIONAL, read-only: every (warehouse, product) whose running state disagrees with the sum of its own dated history. */
  checkHistoryConsistency?(manager?: EntityManager): Promise<HistoryInconsistency[]>;
  /** PURE — no mutation, ever. The current running unit cost for one product/warehouse, for reference (e.g. an FA-01 maker's read-only lookup — Blueprint D11). */
  getUnitCost(productId: string, warehouseId: string, asOfDate?: string, manager?: EntityManager): Promise<{ unitCostBase: string } | null>;
  /**
   * NEW (ADR-041 D18a/D18b) — MUTATING, idempotent on `idempotencyKey`. Resolves AND applies the
   * cost of a real dispatch/issue consumption. The ONLY method F07's ingest-time handler bridge
   * calls, always with the active posting transaction's `manager` so the mutation commits or rolls
   * back together with the GL journal it feeds.
   */
  consumeIssueCost(
    productId: string,
    warehouseId: string,
    quantity: number,
    idempotencyKey: string,
    manager?: EntityManager,
    /** C2 (ADR-INV-02) - the accounting-facing date of the history row it writes (YYYY-MM-DD); omitted = the processing date (today, UTC), exactly as before. */
    businessDate?: string,
  ): Promise<{ unitCostBase: string; totalCostBase: string } | { rejected: 'negative_on_hand' } | null>;
  /**
   * D4 (2026-10-05) — PURE read. The cost an ORIGINAL issue (dispatch) was actually charged, looked up by the idempotency
   * key it was consumed under (`inventory:movement:<stockMovementId>:recorded`). Only keys that have a real `issue` row are
   * returned — a key with no row (dispatch GL event not posted / rejected) is simply absent, so the caller can fail closed.
   */
  getIssueCostsByKeys(idempotencyKeys: string[], manager?: EntityManager): Promise<Array<{ idempotencyKey: string; quantity: number; valueBase: string }>>;
  /**
   * NEW (ADR-041 D18c) — MUTATING. The ONE approved opening-stock/receipt cost-input flow (D3/D7/D20):
   * a maker-supplied `unitCostBase` on the manual "Record Movement" receipt route in
   * `inventory-warehouse`. Recomputes the running weighted-average cost; never invents a cost of its
   * own. Called by `InventoryService.recordMovement`'s `receipt` branch ONLY, with that same call's
   * transaction manager, when a caller supplies `unitCostBase` — absent by default (additive, no
   * behavior change to any existing caller, including `importOpeningStockRows`, D20).
   */
  recordReceiptCost(
    productId: string,
    warehouseId: string,
    quantity: number,
    unitCostBase: string,
    idempotencyKey: string,
    manager?: EntityManager,
    /** C2 (ADR-INV-02) - the accounting-facing date of the history row (YYYY-MM-DD); omitted = the processing date (today, UTC), exactly as before. */
    businessDate?: string,
  ): Promise<void>;
  /**
   * ADR-061 (Manufacturing) — NARROWLY SCOPED to Manufacturing Finished
   * Goods Output. Every other consumer of this contract MUST keep using
   * `consumeIssueCost`, which always resolves cost from the resource's
   * own current average and cannot be overridden. This method exists
   * ONLY because ADR-061 §7 (CTO-ratified) requires applying a
   * Work-Order-POOLED cost (`WIP(WO).value_before ÷
   * remainingPlannedQty_before`) instead of a single component's own
   * natural average — a deliberate, explicitly-ratified exception, never
   * a general-purpose valuation bypass. The caller must have already
   * derived `appliedValueBase` from that ratified formula; this method
   * performs no costing computation of its own. Fails closed (no
   * mutation) with `{ rejected: 'negative_on_hand' }` if `quantity`
   * exceeds on-hand, or `{ rejected: 'value_exceeds_on_hand' }` if
   * `appliedValueBase` exceeds the resource's current total value.
   */
  consumeManufacturingPooledCost(
    productId: string,
    warehouseId: string,
    quantity: number,
    appliedValueBase: string,
    idempotencyKey: string,
    manager?: EntityManager,
  ): Promise<{ appliedValueBase: string } | { rejected: 'negative_on_hand' | 'value_exceeds_on_hand' } | null>;
}

export const INVENTORY_VALUATION_CONTRACT = Symbol('INVENTORY_VALUATION_CONTRACT');
