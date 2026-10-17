# ADR-INV-09 - Inventory-to-GL reconciliation v2 (read-only, itemised, explained)

**Status: PROPOSED (Gate B) - awaiting CTO review.** **Answers:** D-INV-9. **Gate A evidence:** G-RECON-3, G-RECON-2, G-VAL-3, G-ADJ-1, G-EVT-2.

## 1. Context
`InventoryReconciliationService` exists (run entity, close action, permissions, called by the closing audit) but compares only totals, honours the as-of date on the GL side only, reports exact-equality `matched | drift_found`, and its breakdown is a note plus per-warehouse values. It cannot say *why* the two sides differ. The directive: itemised by warehouse and item, differences attributed with their status, no automatic correction, last result visible.

## 2. Decision - keep the service, run table and permissions; extend the computation
### 2.1 Two views in one run
- **Total view (as today):** valuation total as of D (ADR-INV-08) vs the posted balance of the `inventory` control account(s) as of D.
- **Event view (new, the source of explanations):** for every inventory financial event up to D, compare the valuation effect (by idempotency key in `inventory_valuation_movements`) with the posted journal amount (by `journalEntryId`). Because the GL has one inventory account, per-item comparison is **valuation vs the sum of the events attributable to that item**, which is exact and needs no per-item GL account.
### 2.2 Difference categories (each with count, amount, and a drill list)
1. `rounding` - valuation delta vs journal base amount (ADR-INV-06).
2. `event_rejected` - movement committed, event REJECTED (reason shown), no journal.
3. `event_pending` - outbox row not yet dispatched / `processing` / `failed` after 5 attempts.
4. `f07_without_valuation_effect` - approved F07 entries before ADR-INV-05 (and any after, if the flag is off).
5. `movement_without_event` - movements of an event-bearing kind with no event and none pending (expected for history before D3; the cut-over date is stated).
6. `event_without_valuation` / `valuation_without_event` - history inconsistencies.
7. `manual_journal_on_inventory_account` - blocked by policy; reported if one exists.
8. `wip_reclass` - the existing Manufacturing WIP exclusion, shown instead of hidden.
9. `unexplained` - whatever remains. **Status:** `matched` (difference 0), `explained` (difference fully covered by categories 1-8), `drift_found` (unexplained != 0). Only `drift_found` is an alarm.
### 2.3 Presentation and operation
- Breakdown stored in the existing `driftBreakdown` JSON plus three additive nullable columns `explainedBase`, `unexplainedBase`, `basis` (migration, accounting tag). Run history and `close` unchanged.
- **Where it shows:** a card on Warehouse Overview and Trial Balance ("last reconciliation: date, status, unexplained amount"), and the existing Inventory Accounting screen gets the itemised view.
- **When it runs:** on demand (existing), at month-end through the existing closing audit (existing call), and an optional scheduled nightly run per Company behind flag `accounting.inventory_reconciliation_schedule` (same scheduler shape as the other sweeps). Runs are read-only: **no correcting entry is ever created** (unchanged rule).
- Permissions: existing `accounting.inventory.view/create`; the as-of date and warehouse scope respect F6 visibility for non-administrators.

## 3. Alternatives
*Per-item GL accounts* - rejected (Model A: one control account). *Tolerance bands* - rejected (ADR-INV-06). *A second reconciliation table* - rejected (extend, do not duplicate).

## 4. Impact / compatibility / rollback
Service + 1 migration + UI. Old runs remain readable (new columns null). Rollback = ignore the new fields; the old comparison logic stays as the `total view`. Tests: construct each category deliberately on a real database (rounding via fractional averages, a REJECTED event by removing a configuration key, a pending outbox row, an F07 entry, a legacy movement without an event, a manual journal) and assert exact amounts and statuses; a clean ledger yields `matched`; as-of past date equals an independent recomputation; no journal is created by running it; A/B isolation; F6 scope.
