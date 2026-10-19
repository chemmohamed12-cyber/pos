# Inventory Lifecycle - Slice C2 evidence report (2026-10-19)

**Scope (CTO authorisation 2026-10-18):** (1) in-request posting dispatch, (2) explicit business-date propagation. C3, C4, C6 not started.
**Status: implemented and verified on isolated real-PostgreSQL databases; submitted for CTO review. Not applied to the :5173 workspace (see 7). No schema change, no migration.**
Branch `feature/inventory-lifecycle`, on top of the accepted C1 (`4399f90`, closure `4ce6269`, `0cadcd0`). Evidence folder: `backend/docs/decisions/evidence-2026-10-19-inventory-c2/`.

---

## 1. What C2 does

### A. In-request posting dispatch (ADR-INV-10 section 2.1)
- New `InventoryPostingDispatchService` (inventory-warehouse). After the document / movement transaction has **committed**, the controller dispatches the Company's outbox itself (`EventBusService.dispatchAfterCommit`, the same mechanism Goods Receipt, returns and treasury already use) and then **reports the truth** about the GL side.
- The response gains an additive field `financialPosting { status, dispatched, failed, dispatchEnabled, dispatchError?, message }`. `status` is read from the financial events themselves (through the posting policy that accounting binds), never assumed from the fact that a dispatch ran: `posted` only when every event of the record is POSTED; otherwise `pending`, `rejected`, `mixed`; `none` when no financial event exists (e.g. a transfer posts no journal under Model A, or an approval is awaited); `not_applicable` when accounting is not installed.
- Wired at the entry points: `POST /warehouse-transactions/:id/transition` (submit / approve / post / reverse), `POST /inventory/movements` (manual receipt), `POST /inventory/opening-stock/import`.
- Failure handling: the document is already committed, so a failure can never roll back or hide the stock effect. If the dispatch throws, the response is `pending` with `dispatchError`, events stay queued, the 30 s sweep (kept as the safety net) or the next dispatch posts them. If the status cannot be read the response is `pending`, never `posted`.
- Switch: environment variable `INVENTORY_IN_REQUEST_DISPATCH=off` restores sweep-only behaviour; the response then honestly says `pending`. Default on.
- Idempotency is unchanged and relied on: event key `inventory:movement:<id>:recorded`, `FOR UPDATE SKIP LOCKED` claiming, at most 5 attempts, re-drive.

### B. Explicit business-date propagation (ADR-INV-02)
- `InventoryService.recordMovement`, `recordManualReceipt`, `recordSaleReturnIn`, `recordTransfer`, `importOpeningStockRows` gain an **optional trailing `businessDate`** (omitted = today UTC = byte-for-byte today's behaviour for every unchanged caller).
- The date is carried on the `inventory.movement.recorded` event, on the **valuation history row** (`inventory_valuation_movements.businessDate`, the C1 column) for receipts at write time and for issues / transfers at ingest (the costing handler now passes `event.businessDate`), and therefore on the **journal** (handler already used the event date).
- Warehouse documents pass their own `movementDate` (UTC date) for receipt, issue, transfer and adjustment. `POST /inventory/movements` accepts an optional `businessDate`; the opening-stock import accepts `?businessDate=`.
- **Validated before any write:** real calendar date, not in the future, and an **open fiscal period** (accounting's gate, bound through the posting policy: `assertPostingDateOpen`). A closed / missing period rejects the whole document (409) with zero rows written; the date is never silently changed. A future movement date is refused when the document is created.
- The stock ledger keeps `createdAt` as its record time and the movements report keeps its owner-approved policy (D-CR7): no column was added to `stock_movements`.

## 2. Changed files (uncommitted until this report is committed; 15 modified + 2 new + 1 spec)
- **Dispatch (new):** `inventory-warehouse/application/inventory-posting-dispatch.service.ts`; registered in `inventory-warehouse.module.ts`.
- **Controllers:** `inventory-warehouse/interface/warehouse-transactions.controller.ts`, `.../inventory.controller.ts` (optional constructor dependency, response field, DTO `businessDate`, import query).
- **Services:** `inventory.service.ts` (date parameter, `resolveBusinessDate`), `warehouse-transactions.service.ts` (document date, one up-front gate, `financialReferenceIds`).
- **Valuation:** `foundation/module-registry/contracts/inventory-events.contract.ts`, `inventory-valuation/domain/cost-engine.ts`, `.../application/inventory-valuation.service.ts`, `.../moving-average-cost-engine.service.ts` (optional trailing `businessDate`).
- **Accounting:** `accounting/application/financial-events/inventory-costing-handler.service.ts` (passes the event date to the valuation), `inventory-posting-policy.service.ts` (implements the two new optional policy methods), `posting-status.service.ts` (match by source entity / id), `foundation/inventory-posting-policy/inventory-posting-policy.registry.ts` (two OPTIONAL methods + type).
- **Tests:** `accounting/interface/inventory-lifecycle-c2.company-isolation.spec.ts` (new, 11 tests), `tools/testing/regression-specs-all.txt` (+1).

## 3. Migration impact
**None.** No new column, table, constraint or seed. C2 uses the C1 column `inventory_valuation_movements.businessDate`, which `daii_dev` and its four Companies already have (verified 2026-10-17). Nothing was run against `daii_dev` or any shared database in C2.

## 4. Verification (real PostgreSQL, Company A with B as witness; no shared or demo data)
Spec `inventory-lifecycle-c2.company-isolation.spec.ts`. Real pipeline (service -> outbox -> event bus -> financial event -> costing handler -> journal -> ledger) with the **real posting policy and fiscal gate** bound; the controllers are called directly (guards not exercised). Fiscal calendar: one year [today-60, today+300]; period P1 [today-60, today-20] **closed**; P2 [today-19, today+300] open. Expected values were computed by hand. No tolerance.

| # | What is proven | Result |
|---|---|---|
| 1 | A receipt document dated today-3 posts **in the request** (no sweep): response `posted`; the journal exists immediately, event and journal dated today-3, valuation row dated today-3 (value 20.0000), the stock row keeps its record time (today); nothing left un-dispatched among inventory events; Platform DataSource never requested for B | PASS |
| 2 | Historical as-of: valuation before the date = nothing, from it 5 u / 20.0000; GL 0.0000 -> 20.0000; reconciliation at today-4, today-3, today = matched, drift 0.0000; history consistent | PASS |
| 3 | An **issue** dated today-1 (approval flow: submit -> `none`, approve -> `posted`): cost applied at ingest with the **event date**: valuation row issue -8.0000 dated today-1, COGS journal dated today-1; as-of today-2 = 5 u / 20.0000, as-of today-1 = 3 u / 12.0000, GL equal; matched at every date | PASS |
| 4 | A **transfer** dated today-2 dates both valuation rows (consume + carry) and posts no journal (Model A); a direct manual receipt with an explicit date and one with none (= today) post journals dated accordingly; history consistent; matched at today-3/-2/-1/today | PASS |
| 5 | **Validation before any write:** future date refused at creation; a closed-period document and a no-fiscal-year document (today-70) are refused at posting with the **snapshot of stock, valuation rows/state, outbox, events, journals unchanged**; after the period is reopened (fixture for the owner's reopen action) the same document posts **exactly once** dated today-30 (`approve` -> post), a second post is a no-op, stock +1 movement only | PASS |
| 6 | **Posting failure and recovery:** dispatch switched off -> response `pending` (not `posted`), no event yet; the period is closed before the sweep -> event REJECTED, report `rejected`; the C1 reconciliation shows it as an **explained** `unposted_value` difference of exactly 14.0000 (2 x 7.00), unexplained 0.0000; reopen + re-drive -> POSTED, a second re-drive is a deduplicated no-op, journal count +1 only; reconciliation matched | PASS |
| 7 | If the **dispatch itself throws**: document committed, response `pending` with the error, never `posted`, events stay queued; the next dispatch posts them once | PASS |
| 8 | **Duplicate / overlapping dispatch:** 3 documents, two parallel `dispatchAfterCommit` plus a third dispatcher and 3 repeats -> exactly 3 journals, one event per document, none left pending; re-driving a posted event is a deduplicated no-op | PASS |
| 9 | **Consistency and isolation:** stock quantity = valuation quantity; valuation = GL (matched); no unbalanced journal; history consistent; every financial event POSTED; Company B has zero rows in seven inventory/accounting tables, reconciliation matched, Platform `event_outbox` empty | PASS |
| 10 | Without accounting the report is `not_applicable`, never a posting claim | PASS |
| 11 | The **HTTP manual-receipt endpoint**: explicit `businessDate` -> response `posted`, event and journal dated that day; a closed-period date, a future date and an impossible date (2026-02-30) are each refused and the snapshot is unchanged; no date -> today | PASS |

Result: **11/11** (`c2-solo-rerun-incl-11-tests.log`; the 10-test run before the endpoint test was added is `c2-spec-run-10-tests.log`).

### Regression
| Check | Command | Result | Evidence |
|---|---|---|---|
| Typecheck / build / eslint | `npx tsc --noEmit`, `npm run build`, `npm run lint` | clean / OK / 0 errors (5 pre-existing warnings) | `backend-lint.log` |
| Unit tests | `npm run test:unit` | 60 suites / 436 tests PASS | `unit-tests.log` |
| **C1 specs** (C1 spec 14, migrations 2, controlled scenario 8) | inside the full run | PASS | `isolation-regression-full.log` |
| Existing inventory / accounting / returns / procurement / manufacturing real-PG specs | full isolation regression, 106 specs | **102 PASS, 4 FAIL** (classified below) | `isolation-regression-full.log` |
| Business suite T-00..T-31 incl. T-18 schema drift | `node tools/testing/biz-run.js` | **all 29 steps PASS** | `business-suite-run.log` |
| Doc-links | `node tools/validation/check-doc-links.js` | 0 unresolved | session |

### Classification of the 4 failing entries in the full run (none is a C2 assertion failure)
- `company-datasource-registry-isolation.spec.ts`, `company-migration-runner.spec.ts`, `restore-manager-audit-chain.real-pg.spec.ts`: **FAIL (intermittent teardown)**. Every test in each suite passed (3/3, 5/5, 3/3); the suite then failed in its own cleanup with `QueryFailedError: permission denied to terminate process`, the same class as the `area14` failure documented in the C1 closure package. They **PASS when re-run alone** (`c2-solo-rerun-incl-11-tests.log`). The earlier C1 evidence found the same teardown error 1 time in 10 on the tree without C1, so it is not caused by this change; the unit tests were running at the same time as this full run, which may have raised the load (not proven). They are NOT counted as passed in the full run.
- `release-migration-registry.real-pg.spec.ts`: **BLOCKED** (needs the isolated instance on port 5544, unavailable); not run.
- `area14-company-audit` passed in this run (intermittent, see the C1 package).
- `db-guard` test 36 (owner tools) was not re-run; nothing in C2 touches those tools (pre-existing FAIL, see C1 package).

## 5. PASS / FAIL / BLOCKED / NOT TESTED
**PASS:** the 11 C2 tests above; C1 specs; business suite 29/29; unit 436; lint/typecheck/build; 98 of 102 other real-PG specs in the full run plus the 3 re-run solo.
**FAIL:** 3 specs in the full run (intermittent teardown, pass solo) - section 4.
**BLOCKED:** `release-migration-registry` (port 5544); `ci.sh` as one command (its `npm ci` would empty the shared `node_modules` junction).
**NOT TESTED:**
- UI/browser: no frontend change was made, so the screens do not yet display `financialPosting` and C2 was **not verified on http://localhost:5173** (not applied there, see 7).
- The controllers were called directly: guards, validation pipes and the real HTTP layer (multipart opening-stock import with `?businessDate=`) were not exercised; the opening-stock import path is covered only at service level (`recordMovement` with a date, test 4 style).
- Two concurrent HTTP posts of the same document (the existing document-level advisory lock is untouched; only sequential duplicates were tested).
- Large outbox backlog (dispatch batch is 50): a record whose events sit behind a larger backlog reports `pending` (correct but untested at scale); performance not measured.
- Foreign-currency and manufacturing postings; Goods Receipt, shipment, return and manufacturing dating (see limitations).

## 6. Known limitations and design consequences
1. **Post-commit by design.** The dispatch runs after the document transaction commits, inside the same HTTP request. A document can therefore be `posted` operationally while its GL posting is `pending` or `rejected`; the API says so explicitly. It does not roll the stock back.
2. **After a refused post** (closed period, missing account) a no-approval receipt stays in `submitted` (existing workflow behaviour); the retry route is `approve` (approve -> post), not `post`. Documented in test 5.
3. **Date propagation covers** warehouse documents (receipt, issue, transfer, adjustment), `POST /inventory/movements`, and the opening-stock import. Goods Receipt, sales dispatch/shipment (fulfilment), returns and manufacturing keep the processing date (ADR-INV-02 section 2.3: out of scope); they were not changed.
4. **Moving-average cost follows processing order, not business date** (ADR-INV-02 section 5): a back-dated receipt changes the GL period and the as-of valuation by date but does not re-cost issues already posted at an earlier average. Not retro-costed.
5. A document's date defaults to its **creation** time. A document created in one period and approved after that period closes is refused at posting by design (nothing silently re-dated).
6. UTC date of the movement timestamp is the business date (consistent with the UTC business-date helper); the Cairo day boundary behaviour is the open CTO decision already recorded.
7. The dispatch also processes other pending events of the same Company (up to 50), exactly like the Goods Receipt / treasury call sites.
8. `INVENTORY_IN_REQUEST_DISPATCH` is process-wide (not per Company).
9. The C1 field `explained` classification still treats a REJECTED event as an explained unposted difference - intended, and now covered by test 6.

## 7. Rollback
- **Runtime:** `INVENTORY_IN_REQUEST_DISPATCH=off` restores the sweep-only behaviour immediately (restart required); no data change needed.
- **Code:** revert the C2 commit. No schema or data to undo; rows already written carry valid business dates and remain valid (their dates are simply the documents' dates).
- **Compatibility:** all new parameters, response fields and policy methods are optional/additive; callers that pass nothing behave exactly as before (asserted by tests 4 and 11 and by the unchanged regression).

## 8. Not applied to the :5173 workspace
C2 is committed on `feature/inventory-lifecycle` only. The main checkout serving :5173/:3500 was **not** modified in C2 (applying a patch there needs the same explicit go-ahead as C1, including the hand merge of `general-ledger.controller.ts`-style conflicts, a backend rebuild and restart). No production, hosting, migration or deployment action was taken.

---
**Submitted for CTO review. C3 is not started and awaits explicit authorisation.**
