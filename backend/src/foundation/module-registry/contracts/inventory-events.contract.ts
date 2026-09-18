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
 * `inventory.movement.recorded` — one allow-listed stock movement
 * (`dispatch` only in V1, ADR-040 D2). Quantity is always present; the
 * cost fields are always `null` until a valuation source exists (D3).
 */
export interface InventoryMovementRecordedEvent extends InventoryEventBase {
  /** `'dispatch'` in V1 — see `ALLOWED_GL_MOVEMENT_TYPES` in `inventory.service.ts`. */
  movementType: string;
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
export interface InventoryValuationContract {
  /** The valued on-hand position per warehouse, as of a date. Read-only. */
  getValuedOnHandTotal(asOfDate?: string, manager?: EntityManager): Promise<Array<{ warehouseId: string; totalValueBase: string }>>;
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
  ): Promise<{ unitCostBase: string; totalCostBase: string } | { rejected: 'negative_on_hand' } | null>;
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
  ): Promise<void>;
}

export const INVENTORY_VALUATION_CONTRACT = Symbol('INVENTORY_VALUATION_CONTRACT');
