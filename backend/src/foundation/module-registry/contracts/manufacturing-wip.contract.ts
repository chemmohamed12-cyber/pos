import { EntityManager } from 'typeorm';

/**
 * ADR-061 (Manufacturing) Month-End dependency, closed here per the
 * independent post-implementation review's finding: `InventoryReconciliationService`
 * summed F08's `getValuedOnHandTotal()` across every warehouse — including
 * every Work Order's dedicated WIP sub-warehouse (ADR-061 §6) — and
 * compared that sum against ONLY the `inventory` GL control account. Since
 * Manufacturing correctly reclassifies value out of `inventory` into `wip`
 * (Dr WIP / Cr Inventory) on every Material Issue, any period with open WIP
 * produced a false `drift_found` — exactly the risk ADR-061 §17 flagged as
 * "requiring explicit confirmation during Phase 1 implementation" and left
 * unresolved.
 *
 * Defined here in `foundation/module-registry/contracts/` — the one place
 * both domains may import from (`no-restricted-imports` blocks a direct
 * cross-domain import) — the exact same pattern `GRNI_LEDGER_CONTRACT`
 * (`grni-events.contract.ts`) already established for an identical
 * "a second domain's data reconciled against a GL control account it
 * doesn't own" situation: `WipReconciliationService` injects this
 * `@Optional()` and reports `no_subledger_source` if Manufacturing is not
 * installed — never a mock ledger standing in for the real one.
 */
export interface WipBalanceEntry {
  workOrderId: string;
  workOrderNumber: string;
  wipWarehouseId: string;
  /** This Work Order's current WIP value — SQL NUMERIC, F08-sourced (never independently re-derived). */
  valueBase: string;
}

export interface ManufacturingWipContract {
  /**
   * Σ of every currently-open-or-closed Work Order's WIP sub-warehouse
   * value, as of "now" (F08 V1 has no historical reconstruction — same
   * `asOfDate`-accepted-but-unused convention `getValuedOnHandTotal`/
   * `getAllGrniBalances` already established). A completed or cancelled
   * Work Order's WIP sub-warehouse is always exactly $0.0000 by the time
   * it reaches that state (ADR-061 §3's completion guard / §5's
   * zero-issued cancellation guard) — including it unconditionally is
   * therefore always safe and never needs a lifecycle-state filter here.
   *
   * Multi-Company Area 9 (2026-09-22) — `manager?` added so a
   * company-scoped caller (`ClosingSnapshotService`) can run this against
   * that Company's own connection instead of the ambient one. Falls back
   * to the ambient connection when omitted, unchanged for every existing
   * caller.
   */
  getAllWipBalances(asOfDate?: string, manager?: EntityManager): Promise<{ balances: WipBalanceEntry[]; total: string }>;
}

export const MANUFACTURING_WIP_CONTRACT = Symbol('MANUFACTURING_WIP_CONTRACT');
