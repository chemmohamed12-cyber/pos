# N-02 — `fulfillReservation` remediation and verification report (verification track)

Date: 2026-10-11. Scope: **local, non-production**, dedicated cluster 127.0.0.1:5546 only. Separate from N-01 (closed locally, scope as stated there). No hosting, production, protected port or protected file was touched; `company-audit-access.real-pg.spec.ts` and the LA-1 files were not modified by this work.
**Status: IMPLEMENTED AND VERIFIED BY THE IMPLEMENTING TRACK — NOT CLOSED.** Closure requires the independent evidence review (reviewer session) that the directive asks for. Only `fulfillReservation` / `fulfillReservationsForOrder` are covered; the other N-02 diagnostic findings (limit engine, `releaseReservedQuantity`, process-engine `start`, shipment transition) are **not** remediated here.

## 1. Baseline (defect reproduced, evidence preserved)
| Evidence | Result |
|---|---|
| T-20 H3, clean snapshot of `a6002fa` (`evidence-clean-snapshot-2026-10-11/a6002fa/T-20/T-20-20261011T033446Z-44935f`) | plain and transaction manager: **6 calls succeeded, 6 dispatch movements for a reservation of 3, on-hand −18** (FAIL-DEFECT) |
| T-21 on the unfixed code (`evidence-2026-10-10-biz/T-21/T-21-20261011T040605Z-fe3f35`; header commit `ce924e2`, spec uncommitted at the time) | inside a transaction: **8 of 8 fulfilments succeeded, 8 dispatch movements, on-hand −24**; order-level (`fulfillReservationsForOrder`, 4 concurrent callers, 3 reservations): **4 movements per product, on-hand −8 each**; global consistency FAIL (30 dispatch movements for 14 fulfilled reservations). The plain-manager case happened to pass in that run (the race window is narrow without a transaction: non-deterministic, as the earlier T-20 run showed) |

## 2. Root cause
`InventoryService.fulfillReservation` read the reservation, checked `status === 'active'`, posted the dispatch movement and then flipped the status — with **no lock** covering the check and the flip. Any number of concurrent calls (even inside transactions) all read 'active' and each posted a dispatch. With a plain `EntityManager` (no open transaction) each statement also auto-committed separately, and `fulfillReservationsForOrder` was not atomic. `reserveStock` and `releaseReservedQuantity` already serialise on `pg_advisory_xact_lock(hashtext('<warehouseId>:<productId>'))`; fulfilment did not.

## 3. Change (smallest fix, one file: `src/domains/inventory-warehouse/application/inventory.service.ts`, 11 insertions / 2 deletions, 4 hunks)
1. `fulfillReservation`: read the reservation only to learn its `(warehouseId, productId)`, take the **same** advisory lock key `reserveStock`/`releaseReservedQuantity` use, **re-read the reservation under the lock**, then check status, post the movement and flip the status as before. A second caller therefore sees 'fulfilled' and is refused (409) without writing anything.
2. `fulfillReservation` and `fulfillReservationsForOrder` return through the shared rule `runInTransaction(dataSource, manager, run)` (join an ACTIVE transaction, otherwise open one on the caller's manager): the lock, the movement, the audit record and the status flip share one transaction, and an order's fulfilment is atomic. Same rule as N-01 (`foundation/transaction/run-in-transaction.ts`).
Unchanged: movement and valuation behaviour of a successful single fulfilment, the movement type, references, audit actions, error messages, public signatures. Lock order: reservation key advisory lock → (inside `recordMovement`) valuation/audit locks, the same direction `reserveStock` uses.

## 4. Tests (spec `src/foundation/testing/t21-n02-fulfil-reservation.biz.real-pg.spec.ts`, registered as step T-21 in `tools/testing/biz-run.js`)
After the fix (working tree, `evidence-2026-10-10-biz/T-21/T-21-20261011T041223Z-a952b7`) and on the clean snapshot (§5):
| Case | Assertion | Result |
|---|---|---|
| A (plain and transaction manager) | 8 concurrent fulfilments of one reservation: exactly 1 succeeds, 7 get 409, 1 dispatch movement, on-hand −reserved quantity, status fulfilled, reserved 0 | PASS ×2 |
| B retries | 3 sequential retries after success: all 409, still 1 movement | PASS |
| C partial failure | the dispatch cannot be written (FK violation inside the unit): reservation stays active, 0 movements, on-hand and audit unchanged; the retry then succeeds exactly once | PASS |
| D outer rollback | outer transaction rolled back after a successful fulfilment: reservation active, 0 movements, reserved quantity restored; a later fulfilment succeeds once | PASS |
| E order level | 4 concurrent `fulfillReservationsForOrder` on one order with 3 reservations: 1 succeeds, 3 get 409, 1 movement per product, on-hand −2 each | PASS |
| F control | 6 different reservations fulfilled concurrently: all succeed (no over-serialisation, no deadlock) | PASS |
| G consistency | fulfilled reservations = dispatch movements = dispatch audit records, no active reservation left, no negative stock | PASS |
| H audit chain after A–C | hash chain valid after concurrency, retries and partial failure | PASS |
| H audit chain after D | **FAIL-DEFECT — see §6 (F-AUD-003, not N-02)** | FAIL-DEFECT |
Not covered: multi-instance deployment; delivery/shipment end-to-end flows beyond the isolation specs listed in §5; load above 8-way concurrency.

## 5. Clean-snapshot regression (HEAD `b591d1f`; includes `a798d9d` = the N-02 code, `60b9bdf` = the LA-1 track's commit, `b591d1f` = verification evidence)
Clean `git archive` snapshot of `b591d1f`, `dist` built from it (tsc 0 errors), evidence headers pinned to `b591d1f` with `dirtyPaths: []`; evidence `evidence-clean-snapshot-2026-10-11/b591d1f-n02/`. Commands: `DAII_SOURCE_COMMIT=<sha> node tools/testing/biz-run.js --continue-after-failure`; `REGRESSION_NS=biz_t91_ node tools/testing/biz-run.js --regression tools/testing/regression-specs-n02.txt`; `npm run test:unit`; `npm run test:db-guard`.
| Check | Result |
|---|---|
| Business suite T-00…T-22, one sequential run (`biz-full.log`, exit 0) | every step PASS at jest level; case-level: T-00…T-17 and T-19 as before (T-02d PASS, T-10 PASS with R1–R10, T-16 PASS), **T-21 9 PASS + 1 FAIL-DEFECT (F-AUD-003 case, §6)**, T-22 control PASS + rollback case FAIL-DEFECT (the reproducer, by design) |
| T-20 (parallel track's N-02 probes) | **H3 (fulfilReservation) flipped to PASS in plain and transaction style** (baseline: 6 movements, on-hand −18); H1-A, H2-A, H4-A/B still FAIL-DEFECT and H5 BLOCKED — the other N-02 findings, not remediated |
| T-01 / T-02 / T-03 (existing inventory results) | unchanged: PASS (18 / 20 cases) |
| 16 isolation specs on the reservation/fulfilment/dispatch paths (inventory, inventory-valuation, warehouse transactions, delivery, fulfillment, shipment, sales-orders, returns ×4, work-order, manual-receipt, inventory-posting, stock-report scope, warehouse-item-assignment) | **16/16 PASS** (`regression-n02.log`) |
| Unit | 59 suites / 430 tests PASS |
| Guard | 50/50 PASS |
| Successful single fulfilment unchanged | movement/valuation behaviour untouched by the diff (§3); R1–R10 stay PASS in T-10 and in the isolation specs above |
Not in this run: T-18 (parallel track's schema-drift probe) keeps its 3 FAIL-DEFECT — unrelated.

## 6. New finding surfaced by case D — F-AUD-003 (outside N-02, NOT fixed)
A transaction that wrote an audit record and is then **rolled back** permanently breaks the company audit hash chain: `audit_records.seq` is `SERIAL`, but `AuditService.record` hashes `seq = MAX(seq)+1` while the stored seq comes from the DB sequence; the rolled-back insert burns a sequence value, so every later record is stored with seq = hashed seq + 1 and verification fails from that record on. Minimal reproducer `f-aud-rollback-reproducer.biz.real-pg.spec.ts` (step T-22, `evidence-2026-10-10-biz/T-22/T-22-20261011T041117Z-4c03de`): control PASS (seqs 1,2); after one rolled-back audit write the next committed record is stored as seq 4 (hashed as 3), chain invalid, sequence last_value 4. Impact: any rollback after an audit write (outer transaction failures) makes `verifyCompanyChain` fail; no data is lost, the chain is no longer verifiable. Proposed remediation (needs authorisation; core component): hash the sequence value actually stored (draw `nextval` under the existing advisory lock and use it in the hash; verification does not require contiguity), with a migration-free change and a regression test (T-22 flips to PASS). Until then T-21 reports it as its own case and no fulfilment assertion depends on it.

## 7. Closure criteria
Satisfied (by the implementing track): defect reproduced with preserved baseline; root cause identified; smallest fix; concurrent fulfilment, retries, partial failure, transaction rollback and order-level cases pass; no duplicate movement possible for one reservation; reservation quantities, balances and audit/movement counts consistent; regression run recorded in §5.
Outstanding: independent evidence review by the reviewer session; resolution or explicit acceptance of F-AUD-003; remediation of the remaining N-02 findings (separate scope); multi-instance and hosting verification (not authorised, not run). **N-02 is not closed.**


## 8. Update after the CTO directive of 2026-10-11 (second round)
- **Provenance:** `a798d9d` is the complete `fulfillReservation`/`fulfillReservationsForOrder` fix: `inventory.service.ts` (4 hunks), `t21` spec, `f-aud-rollback-reproducer` spec, `biz-run.js` entries. `b591d1f` added evidence only; `inventory.service.ts` is unchanged between `a798d9d` and `b591d1f`. Tested tree: clean `git archive` of `b591d1f` (also contains the LA-1 track's `60b9bdf`). The patch was authored by the verification session; **which session ran `git commit` for `a798d9d` cannot be established** (both sessions share one identity and one working tree) — an earlier note attributing the commit to the reviewer is withdrawn.
- **Independent review:** `N-02-FULFIL-RESERVATION-INDEPENDENT-REVIEW-2026-10-11.md` (reviewer session). It is evidence for the CTO's decision, not an acceptance: the reviewer did not write the patch but wrote the shared rule the patch calls (`runInTransaction`, N-01) and the T-20 baseline probes, and shares the repository and cluster. It inspected lock keys/order, transaction ownership, re-read under lock, reachability and isolation-level assumptions, and raised a deadlock risk.
- **Deadlock risk raised by the review — reproduced and fixed:** T-21 case I (two orders sharing two products in opposite line order, fulfilled concurrently, 6 rounds × 4 callers): **12 deadlocks (40P01) in 24 calls** with the `a798d9d` code; after sorting and taking all per-(warehouse,product) keys up front in `fulfillReservationsForOrder` (commit `5c5b791`): 0 deadlocks, 24/24 movements. Residual: any transaction that wrote an audit record BEFORE entering a fulfilment can still form a cycle with one that locks reservation keys first and then audits (the global audit lock is held to the end of a transaction) — not probed, listed as residual risk.
- **F-AUD-003:** remediated in `c764fc5` (see the consolidated status report); T-21 case H-after-D now PASS.
- **Remaining N-02 findings are tracked separately** in `N-02-AND-F-AUD-003-CONSOLIDATED-STATUS-2026-10-11.md`. N-02 as a whole remains OPEN.
