# Inventory Lifecycle - consolidated completion report (2026-10-19)

Branch `feature/inventory-lifecycle`. Stages executed in order under the CTO directive "Inventory Lifecycle Completion". All data experimental; no production, hosting, migration or deployment action; hosting-incident owner tools not run; the main checkout and its uncommitted work were not modified in this phase.
**The whole lifecycle is NOT declared complete**: C5 is an owner decision, ADR-INV-04 was not in the directive's scope, and two pre-existing defects need a CTO decision (section 9).

## 1. Stage result (PASS / FAIL / BLOCKED / NOT TESTED)
| Stage | Scope | Result |
|---|---|---|
| C1 | observe-only: valuation as-of, reconciliation v2, posting status, refresh, GL/TB read models | PASS (accepted by CTO earlier) |
| C2 | in-request posting dispatch + explicit business-date propagation | **PASS** (spec 11/11). Original full-run failures preserved, see 5 |
| C3 | receipt approval + segregation of duties (ADR-INV-03) | **PASS** (spec 7/7); defaults `warn` / `off` |
| C4 | Opening Balance Batch (ADR-INV-01) incl. reversal and O-1 correction | **PASS** (spec 12/12, migration spec, HTTP smoke 27/27 on an isolated environment) |
| C5 | enforcement: switch `warn -> on` per flag after the owner's data review | **capability PASS** (every flag's `on` path is verified inside C3/C4/C6 specs); **the switch itself: BLOCKED on an owner decision** - no flag default was changed |
| C6 | F07 / D3 coexistence (ADR-INV-05) | **PASS** (spec 8/8 on a hand-computed chain, migration spec) |
Not started by design: ADR-INV-06 phase 2 (not approved), issue-reason accounting (G-ISS-1, not approved).
Not delivered (outside the directive's stage scope or not requested): ADR-INV-04 reason/reference validation, any frontend for C3-C6, application of C2-C6 to the :5173 stack.

## 2. Commits
| Stage | Commit |
|---|---|
| C1 | `4399f90` (+ closure `4ce6269`, `0cadcd0`, logs `05241ce`) |
| C2 | `18159cd` |
| C3 | `ee41a58` |
| C4 | `b0b4f22` |
| C6 | `925c9ca` |
| this report + final logs + policy-config spec expectation | the commit that carries this file |
Changed-file inventory per stage is in each commit and in `INVENTORY-LIFECYCLE-C1-GATE-CLOSURE-EVIDENCE-PACKAGE-2026-10-18.md` / `...-C2-EVIDENCE-REPORT-2026-10-19.md`. New code since C1: `inventory-posting-dispatch.service.ts`, `opening-batch.{service,controller}.ts`, `opening-batch(-line).entity.ts`, `opening-batch-process.ts`, `applyRevaluation`/`reverseReceiptCost`/optional `businessDate` in the valuation contract and engine, handler branches `opening_reversal` / `opening_correction` and the F07 valuation effect, policy hooks (`assertPostingDateOpen`, `financialStatusByReference`, `assertOpeningBatchPostable`), manifests (inventory flags and permission nodes, accounting keys).

## 3. Migrations and fan-out (nothing applied beyond C1)
| Migration | Tag | Effect | Fan-out |
|---|---|---|---|
| `AddValuationMovementBusinessDate1790017000000` (C1) | inventory | nullable `businessDate` + backfill | applied on `daii_dev` + 4 Companies (2026-10-17) |
| `AddInventoryReconciliationExplanation1790017100000` (C1) | accounting | 4 nullable columns | applied (same) |
| `SeedInventoryC1Terminology1790017200000` (C1) | core | 49 labels | applied (same) |
| `CreateInventoryOpeningBatches1790018000000` (C4) | inventory | 2 tables, partial unique index, numbering series `OB` | **required on every Company DB; NOT applied to `daii_dev`** |
| `SeedOpeningBatchTerminology1790018100000` (C4) | core | 10 labels | required; not applied |
| `AllowRevaluationValuationKind1790018200000` (C6) | inventory | replaces the valuation-kind CHECK with one extra value | required; not applied |
All reversible and idempotent (up/down/up specs; `down` of the C6 one refuses while `revaluation` rows exist: history is append-only). Config keys added (installation scope, registry sync, no migration): `inventory.document_sod_enforced` (default `warn`), `inventory.receipt_approval_required` (`off`), `inventory.opening_batch_required` (`false`), `accounting.inventory_opening_correction_account_code` (`''`), `accounting.inventory_f07_updates_valuation` (`false`), `accounting.inventory_physical_count_variance` (`allowed`). With the defaults, behaviour equals pre-C3 except SoD `warn` (audit only) and C2's dispatch/dates (below). Any release must follow the Company-database fan-out procedure and the owner's Stage-A check.

## 4. Evidence index (all under `backend/docs/decisions/`, logs stored as `.log.txt`)
`evidence-2026-10-17-inventory-c1/`, `...-c1-closure/` (controlled scenario 40/40 checks), `evidence-2026-10-19-inventory-c2/`, `...-c3/`, `...-c4/` (incl. `http-smoke-results.json`, `http-smoke.js.txt`), `...-c6/`, and `evidence-2026-10-19-inventory-final/` (final full regression and business suite). Every first failing run is kept next to the final one.

## 5. Test commands and results
| Check | Command | Result |
|---|---|---|
| Real-PG specs of this program | `node tools/testing/biz-run.js --regression <list>` | C1 14 + 2 + 8, C2 11, C3 7, C4 12 + 1, C6 8 + 1: all PASS |
| Full isolation regression (final, 111 specs) | whole list | **109 PASS, 2 not passing**: `release-migration-registry` BLOCKED (needs port 5544); `accounting-policy-config` FAILED on its pinned count of managed keys (12) because C4 added the 13th - expectation updated to 13, spec re-run solo **PASS 8/8**. The original failure is preserved (`final` folder); it was a legitimate consequence of C4, not a defect |
| Business suite T-00..T-31 incl. T-18 schema drift (after C6) | `node tools/testing/biz-run.js` | **all 29 steps PASS** |
| Unit tests | `npm run test:unit` | 60 suites / 436 PASS (re-run after C3, C4, C6) |
| Typecheck / build / eslint | `tsc --noEmit`, `npm run build`, `npm run lint` | clean / OK / 0 errors (5 pre-existing warnings); two lint-error sets in my own C3 and C6 specs found and fixed |
| Earlier C2 full run (102/106) | | preserved: 3 intermittent teardown failures (`permission denied to terminate process`) that PASS solo + 1 blocked; the same teardown error occurs on the baseline tree without these changes (1 in 10 runs) |
| db-guard test 36 | `npm run test:db-guard` | FAIL, pre-existing (owner tools unclassified; identical on the baseline tree); not touched |

## 6. Accounting scenarios (expected by hand = actual)
- **C2:** receipt document dated today-3 posts in the request: journal, event and valuation row dated today-3, stock row keeps record time; issue dated today-1 costed at ingest with the event date: -8.0000 (2 x 4.0000); as-of today-2 = 5 u / 20.0000, as-of today-1 = 3 u / 12.0000; reconciliation matched at every date; closed period / no fiscal year / future date refused with zero rows written; closed period after posting -> event REJECTED, response `rejected`, explained `unposted_value` 14.0000, re-drive posts once.
- **C3:** receipt 4 @ 5.00 waits `submitted` with nothing written; no-role user and the creator refused (zero writes); another user posts once: `Dr 1120 20.00 / Cr 4201 20.00`; parallel approvals = one effect; warn mode audits once; issue/adjustment refused for the creator, transfer allowed; closed-period failure leaves the document `approved`, creator still cannot post, supervisor posts once after reopening.
- **C4:** batch B1 (10 @ 5.00 + 4 @ 2.50): control totals 2 / 14 / 60.0000; approval writes nothing; after post journals dated at the cut-off `Dr 1120 50.00 / Cr 3105 50.00` and `10.00`; valuation = GL = 60.0000 at the cut-off and today; reversal of untouched WH2 batch: `Dr 3105 12.00 / Cr 1120 12.00` x2 at the original values, original -> `reversed`, pair re-opened, corrected opening 3 @ 4.50 = 13.5000; moved pair (P3 10 @ 3.00, dispatch 2 -> 8 u / 24.0000): reversal refused; correction +2 @ 3.00 `Dr 1120 6.00 / Cr 3110 6.00` -> 10 u / 30.0000, correction -1 at the average `Dr 3110 3.00 / Cr 1120 3.00` -> 9 u / 27.0000; no profit-and-loss line on any correction; a non-equity correction account is refused.
- **C6:** 10 u @ 5.00 (50.0000); legacy F07 write-down 4.00 (flag off) GL 46.00, valuation 50.0000 -> difference +4.00 itemised/explained; flag on: write-down 6.00 -> valuation 44.0000 (avg 4.4000) / GL 40.00, difference still exactly 4.00; write-up 2.00 -> 46.0000 / 42.00; closed period: revaluation rolled back with the refused posting (46.0000 / 42.00 unchanged), re-drive -> 45.0000 / 41.00 exactly once; D3 count document -2 at 4.5000 -> 8 u / 36.0000 / GL 32.00; combined F07 -3.00 -> 33.0000 (avg 4.1250) / 29.00; `physical_count_variance`: allowed accepted, warn accepted + audited, refused 409 with nothing created; historical entry byte-identical.

## 7. Failure / retry / idempotency, business date, authorization and isolation evidence
- **Posting failure and retry:** dispatch off -> `pending` (never `posted`); dispatch itself throws -> document committed, response `pending` with the error, events queued; rejected events re-driven once (second re-drive deduplicated); parallel dispatchers and parallel approvals/posts: exactly one effect; opening-batch post atomic (closed period after approval, activity that appeared after approval, failure injected mid-batch: nothing written, retry posts once); revaluation replay by key adds nothing.
- **Business date:** warehouse documents (receipt, issue, transfer, count/adjustment), `POST /inventory/movements`, opening batches; valuation history rows dated by the document; as-of valuation, GL and reconciliation consistent then-with-then; processing order of cost is unchanged (limitation 8.4).
- **Authorization (service/API boundary):** SoD and approval in the service; opening-batch routes verified through the real guards at HTTP level (401 without token, 400 validation, 404 for a user without the node, a create-only user cannot override/reverse/correct, the maker cannot decide, one approver is not enough, same approver twice 409, post before approval 409); FA-01 enforces two distinct approvers.
- **Company isolation:** every spec ends with Company B holding zero rows in all touched tables and the Platform DataSource never requested for B.

## 8. Known limitations and deferred work
1. **C5 switch (owner decision):** flags stay at their defaults until the owner reviews real data (the Q-pack plus the `warehouse_transaction.sod_violation` audit counts of the `warn` period) and authorises each flip per installation. A single-administrator Company would deadlock under SoD `on`.
2. **ADR-INV-04** (reason catalog, reference matrix, issue-reason capture; G-ISS-1 policy unchanged: issues still post COGS) is in the register's C3 but outside this directive's C3; not built. **Decision needed:** authorise it as its own slice.
3. **Not built / not tested:** any UI for opening batches, approval inbox, `financialPosting` display or the new flags; the opening-batch Excel upload and the reversal/correction routes were exercised at service level only (HTTP covered create, submit, decide, post, locks, permissions); `POST /inventory/movements` dispatch/dates at HTTP level; foreign-currency and manufacturing postings in the reconciliation; large-outbox performance.
4. Moving-average cost follows processing order, not business date (no retro-costing). Goods Receipt, shipment, returns and manufacturing keep their own dating (out of scope of C2).
5. The in-request dispatch has an environment switch (`INVENTORY_IN_REQUEST_DISPATCH`), not a per-Company flag; the C2 ADR's `inventory.document_business_date` flag was not implemented (dates always propagate for documents).
6. The direct `POST /inventory/movements` manual-receipt endpoint is not subject to the receipt-approval flag (an open policy question: should it be refused when approval is required?).
7. C4 deviation from ADR-INV-01 text: the post-movement correction is a `correction` batch kind (same two-approver gate, references the original batch, equity account) rather than a normal adjustment document, because ADR-INV-04's reason/reference mechanism does not exist yet.
8. The correction account's equity type is checked before posting; if configuration changed between posting and ingestion (seconds) the handler would still post to the then-configured postable account.
9. The opening-batch eligibility rule treats the movements of reversed lines as non-activity (so a reversal re-opens the pair, as the ADR states).

## 9. Decisions needed from the CTO
1. **Document reversal (pre-existing, found in C3):** `reverseTransaction` has failed at insert since the baseline (`movementDate` NOT NULL is never set). Fixing only that line would expose a second defect: reversing an **issue** document consumes valuation again while the GL restores inventory (difference of twice the cost). I reverted my one-line fix so reversal still fails closed. Decide the correct reversal semantics for issue documents (restore at the original issue cost) before unblocking.
2. Authorise ADR-INV-04 (item 8.2) and the receipt-endpoint question (8.6).
3. The C5 flag-switch plan per installation and the data review owner.
4. Whether the C4/C6 migrations and keys are to be applied to `daii_dev` and the C2-C6 code to the :5173 stack (not done; needs the same explicit go-ahead as C1).

## 10. Rollback
Every change is flag-gated or optional/additive: set the flags to their defaults (`inventory.document_sod_enforced=off`, others as listed) and `INVENTORY_IN_REQUEST_DISPATCH=off`; code rollback = revert the stage commit (no data repair: documents and batches created under the new rules remain valid ordinary movements, events and journals). Migrations are reversible except that the C6 `down` refuses while `revaluation` rows exist (keep them; the constraint extension is harmless). Posted opening batches stay posted; corrections are new batches, never edits.

## 11. Recommended next step
(1) Decide section 9; (2) owner data review and the C5 switch plan; (3) authorise ADR-INV-04; (4) apply C2-C6 to the :5173 workspace with the fan-out on `daii_dev` and verify there; (5) UI slice for opening batches, approval inbox and posting status.
