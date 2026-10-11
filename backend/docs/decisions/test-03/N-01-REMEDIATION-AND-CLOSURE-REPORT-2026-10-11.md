# N-01 — Remediation record and closure status (2026-10-11)

**Status: CODE CHANGE COMMITTED (`23e5ec1`) — CLOSURE NOT DECLARED.** The acceptance evidence that still has to land is listed in §6 (clean-snapshot regression, per-endpoint concurrency specs). Authority: CTO directive "TEST-03 Findings, Decisions & Authorized Next Steps" §1.

## 1. Root cause (VERIFIED)
`NumberingService.getNextNumber` and `ProcessEngineService.transition` took a row lock (`SELECT … FOR UPDATE`) and then wrote, using `manager ? run(manager) : dataSource.transaction(run)`. Controllers pass `req.companyContext.dataSource.manager`, a manager with **no open transaction**; every statement then auto-commits, the lock is released at once, and concurrent callers interleave. Same mechanism as F-AUD-002, F-TRS-001 and F-PAY-001.

## 2. Change (before / after)
| | Before (`f14f162` and earlier) | After (`23e5ec1`) |
|---|---|---|
| Rule | each primitive had its own `manager ? … : …` line; three of them had been patched one by one | one shared rule `runInTransaction(dataSource, manager, fn)` in `src/foundation/transaction/run-in-transaction.ts`: join the caller's manager **only if `queryRunner.isTransactionActive`**; otherwise open a transaction **on that manager's own connection** (Company routing preserved); with no manager the default DataSource opens it |
| Files | — | new `foundation/transaction/run-in-transaction.ts`; changed `numbering.service.ts`, `process-engine.service.ts` (the N-01 fix) and, for consistency, `audit.service.ts`, `treasury.service.ts`, `payments.service.ts` (their earlier inline fix replaced by the helper — same behaviour) |
| API / schema | — | no API change, no migration, no data change |
Existing business rules, transaction boundaries (callers inside a transaction behave exactly as before), authorization and audit calls are untouched.

## 3. Before / after evidence (T-17 plain-manager probes, same spec, same cluster 127.0.0.1:5546)
| Probe | Before — `T-17-20261010T214646Z-4d1886` | After — `T-17-20261010T222543Z-9db4cd` |
|---|---|---|
| Numbering, plain manager, 10 rounds × 20 concurrent | duplicates in 10/10 rounds; counter 30 of 200 | **no duplicates; counter 200/200** |
| Process transitions, plain manager, 15 rounds × 8 identical requests (legal max 2) | 8 of 8 accepted in 14/15 rounds | **exactly 2 in every round** |
| `CustomersService.createCustomer` on the controller's call shape, 8 × 15 concurrent | **12 of 120** succeeded, 108 × SQLSTATE 23505 (HTTP 500) | **120 of 120**, no errors |
| Same probes inside `manager.transaction` (control) | PASS | PASS |
Command: `node tools/testing/biz-run.js --only T-17` (log `evidence/t17-run-after-n01.log`). Spec: `src/foundation/testing/f-plain-probes.biz.real-pg.spec.ts`.

## 4. The flagged call sites, investigated individually
`tools/assessment/callsite-table.js` parses every call (argument actually passed, enclosing method, whether it declares `manager?: EntityManager`, whether a controller calls that method): `evidence/callsite-table.md` / `.json` (115 sites, 0 unclassified).
| Class | Sites | Meaning | Before | After |
|---|---|---|---|---|
| TX-CALLBACK | 37 | argument is a callback-scoped transaction manager | protected | protected (unchanged) |
| CALLER-MANAGER, name-reachable from a controller | 55 | method receives `manager?` and a controller calls it with the Company manager | **exposed** (plain manager) | protected by the primitive |
| CALLER-MANAGER, no direct controller caller | 23 | internal chains (event handlers, other services) | exposed if ever called with a plain manager | protected |
Largest exposed groups: procurement 12, returns 12, inventory-warehouse 9, customer-finance 7, sales-orders 7, accounting 6, payroll 5, shipment 5. Because every exposed site reaches the lock through one of the two primitives, the primitive fix covers all 78 CALLER-MANAGER sites by construction; the reasoning is INFERRED from code for each site and VERIFIED for the primitive (T-17) and for one live path (`createCustomer`). The site-by-site behavioural effect was reviewed: a plain-manager caller previously got three auto-committed statements (number draw / state update / history row); it now gets the same effects atomically. A failure after the draw still burns the number exactly as before (the draw commits with the primitive's own transaction). No caller depends on partial state, and callers already inside a transaction are unchanged.
Per-endpoint concurrency tests on further real paths (suppliers, price lists, purchase orders, warehouse transactions, returns, sales orders) are being added as **new spec files** by the verification session; until they pass, "full scope resolved" is **not** claimed — only "all 78 sites are protected by construction".

## 5. Not covered by N-01 (candidate N-02, NOT changed — no authority)
Other primitives still use the old join-without-check idiom: `inventory.service` reservation methods (`relocateReservedStock`, `releaseReservedQuantity`, `releaseReservedQuantityForReference`, `fulfillReservation`, `fulfillReservationsForOrder`), `moving-average-cost-engine.service` (`run`), `shipment.service.transitionShipment`, `limit.service` (`check`, `consume`). Evidence of risk is mixed: inventory reservation and valuation paths PASSED T-01…T-03 with plain managers (VERIFIED); the others have **no probe** (UNVERIFIED). Proposal: probe each with the T-17 method, then apply the same helper where a probe fails. Needs CTO authorisation for product-code changes.

## 6. Acceptance criteria — status
| Criterion | Status | Evidence |
|---|---|---|
| No duplicate document numbers under the defined concurrent workload | **PASS** (primitive, 200 calls × 20-way; `createCustomer` 120 × 15-way) | §3 |
| Process transitions enforce their legal limits | **PASS** (15 rounds × 8-way, exactly 2) | §3 |
| Customer creation produces no concurrency-related HTTP 500 | **PASS** at service level on the controller call shape; **HTTP-level re-check pending** | §3; per-endpoint spec by the verification session |
| Relevant regression passes (T-01…T-16 business suite, guard 50/50, unit 59/430, isolation specs) | **PENDING** — to be run from a clean `git archive` of `23e5ec1` by the verification session; this session ran only T-17 and typecheck | to be appended |
| Evidence and remaining limitations documented | this document | — |
Limitations: probes use 15–20-way concurrency on a 2-core machine; no multi-instance run; the 23 internal-only sites are covered by reasoning, not by individual tests; N-02 candidates are open.

**N-01 is not closed** until the regression row is PASS and the per-endpoint specs are recorded here.


## 6A. Verification-track results (appended 2026-10-11 by the verification session)

Clean `git archive` snapshot of `a6002fa` (= `23e5ec1` N-01 fix + `7097796` N-02 `registerDocumentType` fix + verification-track test commits), `dist` built from the snapshot (tsc 0 errors), evidence headers pinned to `a6002fa` with `dirtyPaths: []`. Evidence: `evidence-clean-snapshot-2026-10-11/a6002fa/`.
| Check | Result |
|---|---|
| Business suite T-00…T-20, single sequential run (`biz-full.log`, exit 0) | all steps PASS: T-00 1, T-01/T-02 18 (T-02d PASS), T-03/T-04 20, T-05 13, T-06 15 + T-06x-INFO FAIL-DEFECT (known legacy-wrapper probe), T-07 13, T-08 13, T-09 36, T-10 PASS (R1–R10, one consistent commit), T-11 15, T-12 14, T-13/T-14 2+2, T-15 13, T-16 13, T-17 6, **T-19 15/15** |
| T-19 (per-endpoint N-01) | customer / supplier / price-list / sales-rep creates 80/80 each in plain and transaction style with distinct codes; **HTTP `POST /api/customers` 120/120 → 201 with 120 distinct codes**; `registerDocumentType` first-use probe PASS (plain and transaction, 10/10 rounds, 1 row each). Contrast before the fix (`74920fc`): 18/80, 9/80, 8/80, 25/80 |
| Isolation specs that call `registerDocumentType` (20 of the 24 files that mention it; the other 4 are business-suite T-specs) | **20/20 PASS** (`regression-registerdoc.log`) |
| Unit suite | **59 suites / 430 tests PASS** |
| Guard suite | **50/50 PASS** |
| Not mine and not N-01: T-18 (schema-drift probe, 3 FAIL-DEFECT) and T-20 (parallel track's diagnostic probes: 6 FAIL-DEFECT, 2 PASS, 1 BLOCKED — limit engine, reservation release/fulfil double-dispatch, process start) | recorded, open, not remediated; outside the N-01 authorisation |

Reconciliation of commits and evidence: `docs/decisions/test-program/COMMIT-AND-EVIDENCE-RECONCILIATION-2026-10-11.md`. Per-endpoint spec: `src/foundation/testing/t19-n01-endpoint-concurrency.biz.real-pg.spec.ts`.

### Remaining unverified exposure (not closed by this evidence)
- Only the call paths in T-19 (customer, supplier, price list, sales rep), the HTTP customer endpoint and the primitives were exercised concurrently; the other numbering / transition call sites are covered by the primitive fix, not by individual tests.
- Multi-instance deployment, concurrency above 15-20-way on a 2-core machine and long soak were not run.
- Open findings outside N-01: T-20 diagnostics (limit engine, reservation release/fulfil double dispatch, process start), T-18 schema drift.

**Verification-track conclusion:** the N-01 acceptance rows for duplicate numbers, legal transition limits, the customer-creation path (service and HTTP level), the business regression, guard, unit and the isolation specs that call the changed primitives are **PASS on a clean snapshot of `a6002fa`**. Closure of N-01 itself is the reviewer decision.
