# N-02 — diagnostic probes for the remaining plain-manager primitives (D-06, 2026-10-11)

**Decision D-06:** non-destructive local probes approved; isolated local database only; document hypothesis, setup, reproduction, expected and actual result; do not weaken guards; keep N-02 separate from N-01 and never use it to delay N-01 closure.
**Scope kept:** no product code changed; nothing in this document is a fix. **Environment:** dedicated cluster 127.0.0.1:5546 through the unchanged guard; disposable databases `daii_test_biz_t20_*`. **Code tested:** working tree at `153cd8c`+ (N-01 fix `23e5ec1` present, so numbering/process-engine are already protected); spec `src/foundation/testing/n02-probes.biz.real-pg.spec.ts` (`node tools/testing/biz-run.js --only T-20`). **Evidence:** `evidence-2026-10-10-biz/T-20/T-20-20261010T234629Z-8bd3a4/` (`result.json`, `N-02-probe-detail.json`, manifest), `evidence/t20-n02-run.log`.
**Method:** every probe runs the same concurrent workload in two calling styles — **A** plain manager (what controllers pass, `req.companyContext.dataSource.manager`) and **B** the same call inside `manager.transaction`. PASS = the guarantee held; FAIL-DEFECT = it was violated (a **candidate** defect for the CTO to judge; reproduction is the spec above).

| # | Hypothesis | Setup / reproduction | Expected (safe) | A — plain manager | B — in a transaction |
|---|---|---|---|---|---|
| H1 | `LimitService.consume(key, 1, manager)` never lets usage exceed the cap | limit profile cap = 10; 40 concurrent consumers | exactly 10 allowed, counter = 10 | **FAIL-DEFECT: 13 allowed** (cap exceeded by 3; counter ended at 10 — lost updates) | PASS (10 allowed) |
| H2 | `InventoryService.releaseReservedQuantity` can never release more than is reserved | 5 units reserved for one order; 12 concurrent releases of 1 | exactly 5 succeed, 0 left active | **FAIL-DEFECT: 11 of 12 releases succeeded** for 5 reserved units | PASS (5) |
| H3 | `InventoryService.fulfillReservation` fulfils one reservation exactly once | 1 reservation of 3 units; 6 concurrent fulfilments; 50 on hand | 1 success, 1 dispatch movement, on-hand −3 | **FAIL-DEFECT: 6 successes, 6 dispatch movements, on-hand −18** | **FAIL-DEFECT: identical (6 / 6 / −18)** — not a plain-manager effect |
| H4 | `ProcessEngineService.start` for one entity leaves exactly one instance and no database error | 10 concurrent starts of the same entity | 1 instance, 0 errors | integrity held (1 instance) but **1 database error** (unique violation) | integrity held (1 instance) but **9 database errors** |
| H5 | `ShipmentService.transitionShipment` under a plain manager | needs a full shipment fixture | — | **NOT RUN / BLOCKED** (no probe written; never counted as a pass) | — |
| H6 | Moving-average valuation under a plain manager | covered by T-01/T-03 (concurrent receipts and issues with the plain wide manager, valuation reconciled by R2) | — | PASS in those runs (VERIFIED earlier) | — |

## Interpretation
- **H1, H2** are the N-01 mechanism again (lock taken, then released at once because the manager has no transaction): the shared rule `runInTransaction` would fix both (B = PASS). Reach (INFERRED from call sites): `limits.consume` is called with a transaction manager by `customers.service` and `hr.service` (protected) and with `manager` by `gl-account.service` (lines 277, 687 — needs the same check as N-01); `releaseReservedQuantity` is exposed through the inventory contract; its direct callers were not found in `src/` (the work-order path uses `releaseReservedQuantityForReference`, not probed).
- **H3 is a different, more serious logic race** and is **not** fixed by a transaction: `fulfillReservation` reads the reservation without locking it, checks `status === 'active'`, writes the dispatch movement and only then marks it fulfilled, so concurrent callers each pass the check. Consequence: one reservation can deduct stock several times (here 6×). Reach (INFERRED): `fulfillReservationsForOrder` is called from `delivery.service` when a delivery is confirmed; whether two confirmations can race depends on the delivery state machine (which is itself protected only since N-01). Severity: **High if reachable concurrently** (stock and valuation corruption, not a loud error). Requires a row lock (or the existing per-product advisory lock held across the status check) — a code change; NOT made.
- **H4**: no duplicate rows (the unique constraint holds), but racing starts raise database errors; a transaction makes it worse. Severity Low–Medium (loud failure, no corruption).
- All FAIL-DEFECT results are about **candidate** defects; none was tested through HTTP endpoints, and the call sites that make them reachable are inferred from source.

## Status and what is needed
| Item | Status |
|---|---|
| Probes H1–H4 executed, evidence preserved | **PASS (executed)** |
| H5 shipment transition | **BLOCKED / NOT RUN** (fixture) |
| Any fix | **NOT RUN** — needs separate authorization; N-02 is independent of N-01 closure |
Proposed next steps (for the CTO, in priority order): (1) H3 fix design (reservation row lock) with a regression spec and a reachability check on the delivery path; (2) apply `runInTransaction` to `limit.service` and the inventory reservation methods (H1/H2) with the T-20 spec turned into assertions; (3) decide on H4 (idempotent `start` with `ON CONFLICT DO NOTHING`); (4) build the H5 fixture or probe the shipment transition through its existing spec.
