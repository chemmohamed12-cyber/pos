# ADR-INV-02 - Business date of inventory postings

**Status: PROPOSED (Gate B) - awaiting CTO review.** **Answers:** D-INV-2. **Gate A evidence:** G-DATE-1 (a receipt document dated 2026-09-17 posted a journal dated 2026-10-17; O1/O3).

## 1. Context
`recordMovement` publishes `businessDate: new Date()...` (`inventory.service.ts:289`), so every inventory journal is dated the day the event was published. The warehouse document already carries `movementDate`; the opening batch (ADR-INV-01) has a cut-off date; neither reaches the journal. The fiscal-period gate and the GL ledger/TB filter on the journal's business date, so a back-dated document lands in the wrong period.

## 2. Decision
1. `InventoryService.recordMovement` (and `recordManualReceipt`, `recordTransfer`, `recordSaleReturnIn`) gain an **optional trailing parameter `businessDate?: string`** (`YYYY-MM-DD`, UTC business-date policy already used by `utcBusinessDate()`). Omitted = today = today's behaviour, so every existing caller (Goods Receipt, shipment, returns, tests) is unchanged.
2. The value is carried in the `inventory.movement.recorded` payload and in the valuation movement (ADR-INV-08). The costing handler already forwards `event.businessDate` to the journal draft, so no accounting code changes for dating.
3. Callers that pass it: warehouse documents (`movementDate` -> its UTC date), opening batches (`cutOffDate`). Goods Receipt keeps its own date handling (out of scope, unchanged).
4. **Validation:** not in the future; the date must fall in an **open fiscal period**. This is checked **before any mutation** through the existing cross-module pre-mutation gate (`InventoryPostingPolicyRegistry`, bound by accounting; a new method `assertPostingDateOpen(businessDate)` calling `FiscalPeriodService.assertOpenForPosting`). A closed period **rejects the document with a clear message; the date is never silently changed** (CTO direction). The handler-side period check remains as a backstop and still produces a visible REJECTED event.
5. The stock ledger keeps `createdAt` as its record time and the movements report keeps the owner-approved `createdAt` policy (D-CR7). No `businessDate` column is added to `stock_movements` (that would reopen D-CR7); the accounting-facing date lives on the event and the valuation row.

## 3. Alternatives
*Add `businessDate` to `stock_movements`* - rejected for now (reopens D-CR7, wider blast radius). *Use document `createdAt`* - rejected (that is the bug). *Silently move the date into the open period* - rejected by direction.

## 4. Impact
Services: `InventoryService`, `WarehouseTransactionsService.postTransaction`, `InventoryPostingPolicyRegistry` (one optional method), accounting's policy binder. Contracts: `InventoryValuationContract` (optional parameter), event payload (optional field). UI: document form shows the date and the closed-period message. **Unchanged:** posting gate, GL/TB, GR, returns.

## 5. Known limitation (stated, accepted)
Moving-average cost follows **processing order**, not business date. A back-dated receipt changes the GL period and the as-of valuation by date, but it does not re-cost issues that were already posted at the earlier average. This is the normal perpetual moving-average behaviour; retro-costing is explicitly out of scope.

## 6. Compatibility / rollback / tests
No schema change by itself (the valuation column is ADR-INV-08). Feature flag `inventory.document_business_date` (default off -> today's behaviour; on -> use `movementDate`). Rollback = flag off. Tests: document dated D posts a journal dated D exactly once; closed period rejected with zero rows written (stock, valuation, outbox, journal); future date rejected; omitted date = today for GR/shipment paths; period boundary dates; A/B isolation.
