# DAII — Final Verification, Capacity Benchmark & Release Readiness (2026-10-10)

Base commit: `cff8a53` + the change set committed with this report. Environment: dedicated local cluster 127.0.0.1:5546 (PostgreSQL 18.6, system identifier 7695079006474257732), role `daii_biz_test` (non-superuser, CREATEDB only), Windows 10, Intel i7-7600U 2C/4T, 15.9 GB. No credentials in code, logs or evidence. No hosting, production, 5433, 5656, LA-1, protected baseline, or deployment touched. Frozen criteria unchanged.
Status vocabulary: PASS / FAIL-DEFECT / BLOCKED / NOT RUN.

## 1. Workstream A — F-INV-001 API consumers: **BLOCKED (external dependency)**
The documented read-only queries (`F-INV-001-USAGE-MEASUREMENT-QUERIES-2026-10-10.md`, Q1–Q4) must run against a real Company database. No such database is available inside the authorised local scope, no authorised operator is identified in the record, and repository searches are not accepted as proof of absence of external usage.
Missing authority/dependency: (a) a named operator with read-only access to the target Company database(s) (D-9); (b) the observation period (suggested: all history, plus the last 90 days separately); (c) approval to release the 410 change afterwards.
VERIFIED internal facts only: the frontend and repository scripts never POST non-receipt types; internal callers use the service layer. External integrations: UNKNOWN. The 410 contract change must not be deployed.

## 2. Workstream B — Capacity (T-16, HTTP level): measurements only, **no PASS/FAIL (targets unapproved)**
Assumptions and proposed targets, each labelled VERIFIED / MEASURED / ASSUMED: `CAPACITY-WORKLOAD-ASSUMPTIONS-AND-PROPOSED-TARGETS-2026-10-10.md` (approval **pending**). Reproducible profile: `tools/testing/capacity-profile.json`.
Method: node `fetch` (keep-alive) → real `PaymentsController`, `TreasuryController`, `InventoryController` → real PermissionGuard, RequireModuleGuard, ValidationPipe, AllExceptionsFilter → real services → real PostgreSQL. Test doubles: authentication and Company-context resolution only. Two Companies (A, B), 8 treasury accounts and 40 products each (opening funding 1,000,000.00 per account), mixed workload (35 % on-account payments, 20 % stock receipts, 12.5 % cash-in, 12.5 % cash-out, 20 % reads), a unique Idempotency-Key on every write, closed-loop virtual users. Raw data: `evidence-2026-10-10-biz/T-16/T-16-20261010T204619Z-535df6/` (`T-16-capacity-http.json`, `T-16-resource-samples.json` every 2 s, manifest).

| Phase | Users | Requests | 2xx | Errors | req/s | p50 ms | p95 ms | p99 ms | System CPU avg / max % | PG connections max |
|---|---|---|---|---|---|---|---|---|---|---|
| ramp (spread over 2 Companies x 8 accounts) | 5 | 508 | 508 | 0 | 33.6 | 149 | 345 | 634 | 56.2 / 83.2 | 29 |
| ramp (spread over 2 Companies x 8 accounts) | 10 | 539 | 539 | 0 | 35.1 | 208 | 771 | 1461 | 56.4 / 82.1 | 27 |
| ramp (spread over 2 Companies x 8 accounts) | 25 | 597 | 597 | 0 | 38.1 | 507 | 1861 | 2772 | 53 / 58.6 | 27 |
| ramp (spread over 2 Companies x 8 accounts) | 50 | 626 | 626 | 0 | 38.6 | 877 | 3765 | 5189 | 48.7 / 54.1 | 27 |
| ramp, one hot account/product | 5 | 516 | 516 | 0 | 34.2 | 181 | 264 | 676 | 44.1 / 56.9 | 27 |
| ramp, one hot account/product | 25 | 481 | 481 | 0 | 30.7 | 644 | 1857 | 2696 | 43.5 / 56.5 | 17 |
| ramp, one hot account/product | 50 | 513 | 513 | 0 | 31 | 1087 | 3596 | 5710 | 43.3 / 50.6 | 17 |
| sustained 90 s | 20 | 3533 | 3533 | 0 | 39 | 356 | 1492 | 2060 | 49.9 / 73.4 | 27 |
| peak 45 s | 60 | 1577 | 1577 | 0 | 33.3 | 1050 | 5793 | 9178 | 55.6 / 77.7 | 27 |
| recovery 45 s | 5 | 1605 | 1605 | 0 | 35.6 | 136 | 301 | 624 | 49.7 / 58.9 | 27 |

Recovery (5 users after the 60-user peak), p95 per 5 s window: 306, 281, 282, 320, 279, 326, 354, 298 ms — back at the pre-peak level (5-user ramp p95 345 ms) from the first window.

Totals: 10,495 requests, 0 non-2xx.
Integrity oracle after the run (both Companies): **PASS** — every treasury balance exact (opening funding ± successful movements), payment rows = successful payments, on-hand = successful receipts, 0 unposted financial events, 0 unbalanced journals, both audit hash chains valid, 0 negative stock, outbox drained; the idempotency probe (15 keys × 3 concurrent HTTP requests, payments and cash-in) produced exactly 15 stored effects; Company A reconciliation R1–R10 all PASS.
Run history: the first run showed 10 % HTTP 500, caused by a test-fixture fault (a stubbed scope resolver behind the treasury READ endpoint), not a product defect; the fixture was corrected and the test re-run. Evidence of run 1 is kept (`run-logs/t16-1.log`).

Findings (measured, not verdicts):
- Throughput saturates at ~31–39 req/s from 5 virtual users upward and does not grow with concurrency; latency grows about linearly (p95 345 ms at 5 users → 3.8 s at 50 → 5.8 s at the 60-user peak). The Node process ran at ~93 % of one core while system CPU averaged ~49 %: load generator, application and PostgreSQL share this 2-core machine, so the observed ceiling is the single-threaded event loop of this in-process setup, not demonstrated PostgreSQL or lock exhaustion.
- Hot spot vs spread: with every operation on one account/product throughput was ~20 % lower at 25–50 users (31 vs 38 req/s) and p95 similar (3.6 s vs 3.8 s at 50 users): single-resource contention costs something but is not the dominant limit at this load.
- Correct and stable under saturation; recovery after the peak was immediate (p95 back to 280–350 ms in the first window; no stuck transactions).
- Resources: process RSS grew from 2.48 GB to 2.96 GB (+19 %) and PostgreSQL working set from 0.89 to 1.24 GB over the ~5-minute run. The node figure includes the jest/ts-jest harness, so a memory leak can neither be shown nor excluded. DB connections stayed ≤ 29 (max_connections 200).
- Not measured: separate load-generator process, multi-process app, real network, disk with fsync, large data volumes, a 30-minute soak (the sustained phase was 90 s), 200 or 1,000 concurrent users. **Hosting capacity: UNVERIFIED.**

## 3. Workstream C — real-Postgres coverage under the guard
Reason for the rejection: the main-suite harness created databases named `daii_test_<prefix>_*` (e.g. `daii_test_treasury_isolation_*`), but the only approved entry allows `^daii_test_biz_t[0-9]{2}…`, so the guard (correctly) refused them; two audit specs also used fixed names and defaulted to port 5433.
Narrow path built — the guard policy, approved entry and hard denials are **unchanged**: the harness and two audit specs honour an optional `DAII_TEST_DB_NS`, validated fail-closed to exactly `biz_tNN_` with a 63-character name limit; `node tools/testing/biz-run.js --regression tools/testing/regression-specs.txt` sets `biz_t90_`, so databases are `daii_test_biz_t90_<prefix>_*`. The drift-protection guard test was extended (stricter, not weaker): it now asserts the namespace validation, that all 74 spec prefixes produce an approved, ≤63-character business name, and that look-alike names stay refused. Guard suite 50/50.
Results (`run-logs/regression-1.log`): **16/16 PASS** — audit-chain-concurrency, area14-company-audit, treasury, treasury-bank-leg, payments, on-account-payment, customer-ledger, invoices, supplier-payment, inventory, warehouse-transactions, warehouse-item-assignment, stock-report-export scope, inventory-valuation, manual-receipt, inventory-posting.
Remaining gaps (all **NOT RUN**): `products_isolation` and `delivery_isolation` specs are refused by design (their prefix contains "prod"/"live"; renaming the prefix is a separate test-only change); `company-audit-access.real-pg.spec.ts` (carries uncommitted edits by others); the ~30 specs with their own connection logic (provisioning, pool, fan-out, restore; list in `run-logs/regression-coverage-inventory.txt`); 54 further namespaceable domain isolation specs outside audit/treasury/payments/inventory (runnable with the same command).

## 4. Workstream D — decisions and risks
- **D-1** (TEST-03 identity): OPEN — no evidence or decision supplied.
- **D-9** (hosting read-only queries, seq-1 audit-chain diagnosis, F-INV-001 historical usage): OPEN — blocked by missing authorisation and operator.
- **D-10**: targets proposed, approval pending (§2).
- T-06x: its FAIL-DEFECT is the deliberate probe of the deprecated, unused wrapper; the active controller path is verified by T-06y (1 effect for 5 concurrent same-key requests) and over HTTP by the T-16 idempotency probe (15 keys × 3 → 15 effects).
- Residual risks: `IdempotencyService.withIdempotency` remains in the code base (deprecated); the plain-manager pattern may exist in paths not exercised here; event dispatch drains 50 outbox events per call and runs inline in the request (known "Event Engine batching" scope) — a high-volume deployment must be tested for that.

## 5. Regression summary
Business suite T-00…T-12 + reproducers + T-15: all PASS (exit 0; T-02d PASS) after the latest product changes; T-16 integrity PASS; 16/16 real-Postgres module specs PASS; unit 59/59 suites (430 tests); guard 50/50; reconciliation R1–R10 PASS in every reconciling run.

## 6. Architectural impact and compatibility of this change set
Product code: not changed in this round. Test infrastructure only: harness name namespace (no effect when the variable is unset), two audit specs, runner `--regression` mode and `T-16` step, stricter guard drift test, profile and spec files. No migration, no API change. Rollback = revert the commit.

## 7. Verdict
| Dimension | Verdict |
|---|---|
| Local functional and integrity readiness | **READY** — business, concurrency, failure-recovery, isolation, reconciliation and module tests pass; integrity held under HTTP load on two Companies |
| Local capacity readiness | **NOT CLASSIFIED** — measurements recorded (~35 req/s ceiling for this single-process, shared-machine setup); targets pending approval; no PASS/FAIL |
| API compatibility readiness (F-INV-001 410 change) | **NOT READY** — BLOCKED on real-data usage evidence and approval |
| Hosting readiness | **UNVERIFIED** — no authorised environment |
| Overall release approval | **NOT APPROVED** |

## 8. Decisions that genuinely need CTO input
1. Name an operator and authorise the read-only usage queries (D-9) for F-INV-001, then approve or reject releasing the 410 change.
2. Approve or replace the workload assumptions and capacity targets in `CAPACITY-WORKLOAD-ASSUMPTIONS-AND-PROPOSED-TARGETS-2026-10-10.md` (D-10).
3. Provide an authorised staging/hosting-like environment, with a separate load-generator machine, or confirm that hosting capacity is out of scope.
4. Decide D-1, and whether to run the remaining 54 namespaceable isolation specs and rename the two refused prefixes.
