# N-01 — Remediation record and closure status (2026-10-11)

**Status: CLOSED for the local scope (2026-10-11) — see §7 for the closure review; originally: code change committed (`23e5ec1`), closure not declared until the clean-snapshot evidence (§6A) was received.** The acceptance evidence that still has to land is listed in §6 (clean-snapshot regression, per-endpoint concurrency specs). Authority: CTO directive "TEST-03 Findings, Decisions & Authorized Next Steps" §1.

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

*(Superseded: the regression row and the per-endpoint specs are recorded in §6A and reviewed in §7 — N-01 is closed for the local scope.)*


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

## 7. Closure review (implementation session, 2026-10-11, after the verification session reported "done")
**Reviewer note:** the code under review was written by this session; the test evidence was produced by the separate verification session. The checks below are this session's independent re-examination of that evidence (not a re-run of the suites, which the cluster-exclusivity rule forbade while they ran). Final sign-off remains the CTO's.

### 7.1 What was re-checked and how
| Check | Method | Result |
|---|---|---|
| Tested commit is the one claimed, clean tree | `SOURCE_COMMIT.txt` = `a6002fa6534fd278d99263fdd01d0d61e23b50ec`; `run-header.json` of T-09, T-10, T-17, T-19 carry the same commit and `dirtyPaths: []` | confirmed |
| Snapshot code = current HEAD code | `git diff --name-only a6002fa HEAD -- backend/src backend/tools backend/package.json` is empty (only evidence/docs commits `a205666`, `4fece22` follow) | confirmed — HEAD `4fece22` has the product code that was tested |
| Contains both fixes | `a6002fa:…/numbering.service.ts` has `runInTransaction` and `ON CONFLICT`; `process-engine.service.ts` uses the helper | confirmed |
| Pre-fix contrast is really pre-fix | `74920fc` numbering and process-engine files contain no `runInTransaction`; the contrast snapshot's `SOURCE_COMMIT.txt` = `74920fc…`. Note: its per-run `run-header.json` shows `6d062cb` (the parent repository HEAD at that time, because the pinning feature was not yet in the snapshot) — attribution therefore rests on `SOURCE_COMMIT.txt`, the code check above and the failing behaviour itself | accepted, with this caveat |
| Isolation list complete | `git grep -l registerDocumentType` at `a6002fa` over spec files = 24; 4 are business-suite T-specs (T-07, T-16, T-17 probe, T-19), the other 20 equal `regression-specs-registerdoc.txt` line for line (empty `comm` both ways); `regression-registerdoc.log`: "REGRESSION DONE: 20/20 passed", exit 0 | confirmed |
| Business suite | `biz-full.log` "ALL REQUESTED STEPS PASSED", exit 0; T-17 6 PASS, T-19 15 PASS, T-10 1 PASS (one consistent commit), T-09 36 PASS | confirmed from result files |
| Unit and guard | `unit.log` 59 suites / 430 tests; `guard.log` 50/50 | confirmed |
| Final tree builds, lints and passes the CI script | clean `git archive HEAD` (`4fece22`) → `tools/ci/ci.sh` (offline cache): install 61 s · build 53 s · lint 42 s (0 errors) · structure · doc links (0 unresolved) · unit 144 s (59/430) · guard 4 s → **Overall PASS** (`evidence/ci-run-final-head-snapshot.log`) | PASS |
| Excluded evidence | `T-19-20261011T000719Z-1828a1` and `T-19-20261011T000721Z-2eb9e4` (overlapping runs / wiring defect) are not used anywhere above | excluded |

### 7.2 Closure criteria (CTO directive "N-01 Final Verification")
| Criterion | Status | Evidence |
|---|---|---|
| Final clean-snapshot pipeline passes all required checks | **PASS** | §6A; `evidence-clean-snapshot-2026-10-11/a6002fa/` |
| Supplier first-use concurrency scenario verified against the database | **PASS** — `T-19-supplier.create-plain` 80/80 (before: 9/80, 71 × 23505); `T-19-N02-registerDocumentType-plain/transaction` 0 errors, 1 row, 10 rounds | `a6002fa/T-19/…/result.json`, `74920fc-before-fix-T19/` |
| Numbering uniqueness and HTTP customer-creation behaviour | **PASS** — customer/supplier/price-list/sales-rep creates 80/80 with distinct codes (160/160, 160/160, 161/161, 160/160 incl. control style); `POST /api/customers` 120/120 → 201, 120 distinct codes; T-17 numbering 200/200 distinct, transitions capped at 2 | same |
| Relevant isolation and regression tests pass | **PASS** — 20/20 isolation specs, T-00…T-20 sequential run exit 0, unit, guard | §6A |
| Commit and working-tree reconciliation complete | **PASS** — `COMMIT-AND-EVIDENCE-RECONCILIATION-2026-10-11.md` + §7.1 (tested snapshot = HEAD product code; earlier working-tree runs labelled historical; other tracks' uncommitted files excluded from every snapshot) | — |
| Closure evidence independently reviewed | **PASS** — §7.1 (author ≠ test producer; CTO sign-off pending) | — |

### 7.3 Residual risks and what this closure does NOT claim
- Only the T-19 paths (customer, supplier, price list, sales rep), the HTTP customer endpoint and the primitives were exercised concurrently; the other 78 caller-manager call sites are protected **by construction** (they all reach the primitive) and by the 20 isolation specs, not by per-site concurrency tests.
- Concurrency was 15–20-way on a 2-core machine; no multi-instance run, no soak, no hosting evidence.
- `T-18` (schema drift) and `T-20` (N-02 probes) record **open FAIL-DEFECT findings that are not N-01** (limit engine, reservation release/fulfil double-dispatch, process-engine start errors, integration tables). They are tracked in `N-02-DIAGNOSTIC-PROBES-REPORT-2026-10-11.md` and are not remediated.
- Process-engine `start` (check-then-insert) still raises unique-violation errors under racing starts (N-02 H4); numbering and transitions do not.

### 7.4 Decision
**N-01: CLOSED for the local scope (2026-10-11)** — all closure criteria are met on clean-snapshot evidence of `a6002fa`, the product code is identical in HEAD `4fece22`, and the final tree passes the CI script. The closure does not extend to hosting, multi-instance operation or the N-02 findings. The earlier "NOT closed" wording in the status line of this document is superseded by this section.
