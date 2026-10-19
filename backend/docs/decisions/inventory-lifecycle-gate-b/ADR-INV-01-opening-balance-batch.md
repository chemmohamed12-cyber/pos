# ADR-INV-01 - Opening Balance Batch (dated, approved, locked)

**Status: PROPOSED (Gate B) - awaiting CTO review. No code, schema or data changed.** Numbering is provisional; an official ADR number is assigned on approval.
**Answers:** D-INV-1 (opening cycle). **Gate A evidence:** G-OB-1, G-OB-2, G-OB-3, G-DATE-1 (`INVENTORY-LIFECYCLE-GATE-A-DISCOVERY-2026-10-17.md`, measurements O1-O3).

## 1. Context
Stock enters as "opening" through two ungoverned doors: the Excel opening-stock import (one guard: one import per warehouse x product) and any manual receipt whose reason maps to an opening-equity account (auto-posts on submit, no approval, dated today). Neither has a cut-off date, control totals, approval, lock or correction path. The GL already has the machinery needed (fiscal-period gate, maker/checker through FA-01 with `opening_balance` kinds for AR/AP/Cash, the `inventory_opening_balance_account_code` configuration key, the `opening_stock` event kind) - what is missing is the governing document.

## 2. Decision
Introduce an **Opening Balance Batch** document in the inventory module, and make it the only way to bring opening stock in once the cut-over flag is on.

### 2.1 Model (additive, Company database, inventory tag)
- `inventory_opening_batches`: `id`, `batchNumber` (Numbering series `inventory_opening_batch`), `kind` (`opening` | `reversal`), `warehouseId`, `cutOffDate` (date), `currencyCode`, `declaredLineCount`, `declaredTotalQuantity`, `declaredTotalValueBase` (maker-entered control totals), `computedTotalValueBase`, `reversalOfBatchId` (nullable), `reason` (text, required for `reversal`), `approvalRequestId`, `createdByUserId`, `submittedAt`, `postedAt`, `notes`. **No status column** - lifecycle lives in the Process Engine like every other document (`inventory_opening_batch`: `draft -> submitted -> approved -> posted`, `submitted -> draft` on reject/recall, `posted -> reversed` only through a reversal batch).
- `inventory_opening_batch_lines`: `id`, `batchId`, `productId`, `quantity` (int > 0), `unitCostBase` (numeric(20,4) > 0), `lineValueBase` (= quantity x unitCost, stored and re-checked), `stockMovementId` (set on posting), `isActive` (true once posted, false when reversed) and a **partial unique index on (`warehouseId`, `productId`) WHERE `isActive`** (the line carries `warehouseId` for that purpose). This is the database-level guarantee against a second opening for the same pair.
- Reused unchanged: Numbering, Process Engine, FA-01 Approval Engine, `InventoryService.recordMovement`, the valuation engine, the Financial Event path, the existing configuration key `accounting.inventory_opening_balance_account_code`, the Excel service (the import template stays).

### 2.2 Rules
1. **Eligibility (checked at submit and again at posting).** A (warehouse, product) pair is eligible only if it has **no stock movement of any type** and no active opening line. An exception (`allowExistingActivity`) needs the permission `inventory.opening_batch.override`, a written reason and is recorded in the batch and audit; it is never the default.
2. **Cut-off.** `cutOffDate` must not be in the future and must fall in an open fiscal period (pre-check through the existing posting-policy gate, see ADR-INV-02). A closed period rejects the submit; nothing is created.
3. **Control totals.** The maker enters line count, total quantity and total value; submit fails unless they equal what the lines add up to. The same totals are shown to the approvers.
4. **Cost.** Every line needs a positive unit cost. No quantity without value (Gate A directive item); no fallback cost.
5. **Approval.** FA-01 request type `inventory.opening_batch`, always gated, **2 approvers**, node `inventory.opening_batch.approve` (same shape as AR/AP/Cash openings, `domain/ar.ts:38`). The engine already enforces maker != checker.
6. **Posting is a separate explicit action after approval** (`post`), not work done inside the approval callback. This keeps failures visible and retryable: approved-but-unposted is a legitimate state, and `post` is idempotent. It runs in ONE transaction under an advisory lock on the batch id: re-validate eligibility, period, accounts; for each line `recordMovement(receipt, referenceType 'opening_batch', referenceId batchId, businessDate = cutOffDate, unitCost, reason 'opening_balance')` with idempotency key `opening:batch:<batchId>:line:<lineId>`; set `stockMovementId`/`isActive`; transition to `posted`. Any failure rolls the whole batch back.
7. **Accounting.** The existing event kind `opening_stock` posts `Dr 1120 / Cr configured opening-balance account` dated `cutOffDate`, once per line (idempotent keys). `glKindFor` gains the pair `receipt + 'opening_batch'`; the legacy pair `receipt + 'excel_import'` keeps working for history.
8. **Lock.** A posted batch is immutable. The reason code `opening_balance` becomes **reserved**: manual receipts and documents may no longer use it (ADR-INV-04). The legacy direct import endpoint stays but is refused when the configuration flag `inventory.opening_batch_required` is on (default off until the cut-over is approved).
9. **Excel.** A new endpoint loads the existing template into a **draft** batch with row-level validation (unknown SKU/warehouse, cost, eligibility); the user reviews, enters control totals and submits.

### 2.3 Exceptional correction (reversal batch)
- Only for lines whose pair has **no later movement**. Kind `reversal`, references the original batch, requires `inventory.opening_batch.correct`, a written reason, the same 2-approver gate, and its own period check.
- Posting uses a new event kind `opening_reversal`: `Dr opening-balance account / Cr 1120` at the **original line value**, and the valuation engine's existing `applyReversal` (appends an offsetting row, never edits). The original lines become `isActive = false`, which re-opens the pair for a corrected batch.
- For pairs that **already moved**, a reversal is not possible without distorting later costs. Such a correction is made with a normal approved adjustment document whose reason is `opening_correction` and whose reference is the original batch (ADR-INV-04). **Open accounting decision O-1:** which account receives that difference - recommended: a new configuration key `accounting.inventory_opening_correction_account_code` (equity-side), so a wrong opening does not distort P&L. Until O-1 is decided this path is not built (the reversal-batch path is independent).

## 3. Alternatives considered
- *Hide the `opening_balance` option in the UI only* - rejected (the directive: control at Company/batch/cut-off level, not UI).
- *Post openings as manual journals (`OPENING` source type)* - rejected: the journal would exist without stock or valuation, recreating the drift the reconciliation is meant to catch.
- *Do the posting inside the approval callback (the F07 pattern)* - rejected for batches: a bulk effect that can fail after approval would leave an approved request without effect and no clear retry.
- *Extend `JournalSourceType` with a new value* - rejected: the CHECK constraint and `USER_CREATABLE_SOURCE_TYPES` are part of the GL contract; the existing `FINANCIAL_EVENT` path with a back-dated `businessDate` is sufficient (the day-count rule applies only to `MANUAL`).

## 4. Impact
- **New:** 2 tables, 1 process definition, 1 FA-01 request type + matrix rule, 4 permission nodes (`inventory.opening_batch.create`, `.approve`, `.correct`, `.override`), Numbering series, 1 controller + service, 1 screen (list/detail/import/approve/post), terminology rows, 2 configuration keys/flags.
- **Changed (additive):** `glKindFor`, `recordMovement` (optional `businessDate`, ADR-INV-02), valuation contract (optional `businessDate`), event payload (`batchId`, optional), `ItemDetails` opening-balance field (reads batch lines).
- **Unchanged:** Event Engine / outbox, journal posting and period gate, GL and TB contracts, GRNI path, existing `excel_import` history, Model A.

## 5. Compatibility, data protection, migration, rollback
Existing openings stay valid and make their pairs ineligible, which is exactly the duplicate protection wanted. No existing row is touched. Migrations are additive and reversible (`down()` drops the two tables); each ships with the Company fan-out instruction (lesson of the 1.1.10 incident: platform-only migration leaves Company databases behind). Rollback of the application keeps the tables; with the flag off the old import path works unchanged. No test data touches production.

## 6. Tests (Gate D, real PostgreSQL, A/B Companies)
Lifecycle and state guards; one batch posts once (retry and double-click idempotent); the partial unique index rejects a second active line; eligibility (pair with a prior movement refused; override needs permission + reason); control-total mismatch; cut-off in the future / closed period refused with nothing created; journal dated at the cut-off and `Dr 1120 / Cr opening` exactly once per line; valuation = batch value; maker != checker; approver permission; reversal only for untouched pairs and restores eligibility; reserved reason refused; legacy import refused when the flag is on and unchanged when off; Company B untouched and the Platform DataSource never requested.

## 7. Approval needed
D-INV-1 as written; decision O-1 (account for a post-activity opening correction); confirmation that the cut-over flag stays off until the Q1/Q2 queries on the real databases have been reviewed.
