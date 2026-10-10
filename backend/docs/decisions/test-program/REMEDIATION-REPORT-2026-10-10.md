# Defect Remediation & Verification — before/after (2026-10-10)

Baseline: `a55ed87` (tests at `28829d9`). Cluster: dedicated 127.0.0.1:5546 (credentials not exposed). No migration, no data change, no API contract change, frozen criteria untouched, LA-1 untouched.

## Root cause (shared)
`AuditService.record`, `TreasuryService.run` (cashIn/cashOut/transfer cores) and `PaymentsService.applyPayment` did `manager ? fn(manager) : dataSource.transaction(fn)`. Controllers/tests pass `req.companyContext.dataSource.manager` — a plain manager with NO open transaction — so `pg_advisory_xact_lock` ran in its own implicit transaction, was released at once, and check-then-insert raced. Same pattern already used safely in `journal-entry.service.ts`, `purchase-order.service.ts`.

## Changes (3 files, +9/-3 lines; same one-line rule in each)
`manager ? (manager.queryRunner?.isTransactionActive ? fn(manager) : manager.transaction(fn)) : dataSource.transaction(fn)`
- `src/foundation/audit/audit.service.ts` (F-AUD-002)
- `src/domains/treasury/application/treasury.service.ts` `run()` (F-TRS-001)
- `src/domains/customer-finance/application/payments.service.ts` `applyPayment` (F-PAY-001)
Callers already inside a transaction behave exactly as before (they join it); only no-transaction managers now get one. Other companies are unaffected (per-Company manager/DB, locks are per-DB).

## Before / After
| Test | Before (28829d9) | After |
|---|---|---|
| T-05 treasury | FAIL-DEFECT (overdraft in some runs) | PASS 13/13: exactly 3 of 10 withdrawals succeed, balance 10.00, GL balanced |
| T-08 payment apply | STOP (unapplied −100.00) | PASS 13/13: 10+10 rounds one application, unapplied 200.00 |
| F-AUD-002 reproducer (T-13) | plain manager FAIL-DEFECT | PASS: chain valid, 0 forks |
| F-TRS-001 reproducer (T-14) | plain manager FAIL-DEFECT | PASS: 15 rounds, 0 overdrafts, balances 10.00 |
| T-10 reconciliation R1–R10 | STOP | PASS (all frozen runs, all differences zero) |
| T-03 audit-chain probe, T-05/T-08 audit-chain | FAIL-DEFECT | PASS |
| T-00, T-01, T-03, T-06, T-07, T-11, T-12 | PASS | PASS (no regression); T-02d still BLOCKED |
| T-09 (F-INV-001) | FAIL-DEFECT | **unchanged — not fixed (see below)** |
| Unit regression `test:unit` | 59/59, 430 | 59/59, 430 |
| `test:db-guard` | 50/50 | 50/50 |
Evidence: `evidence-2026-10-10-biz/<T-id>/<latest runId>/`, logs `run-logs/remed-run-1.log`, `remed-run-FULL.log`, `remed-unit.log`.

## STOPPED: F-INV-001 not fixed
The only fix defined for F-INV-001 (CTO-direction doc `F-INV-001-FINAL-CONTRACT-AND-T09-CRITERIA`) is to reject dispatch/adjustment/transfer_in/transfer_out/return on `POST /api/inventory/movements` (410) — a change of API contract with UNVERIFIED external consumers. This is a stop condition of the directive, so no code was changed. T-09 still shows FAIL-DEFECT E3–E9-1 (movements accepted → negative on-hand), plus E10/E13 HTTP 500 instead of 404. Decision needed: authorize the contract closure (after the usage measurement in §3 of that doc) or an alternative.

## Residual risks
- `real-pg` specs of audit/treasury/payments in the main suite cannot run under the guard (only `daii_test_biz_t..` is approved), so the wider regression relies on unit suite + business suite; running them needs an approved pattern.
- Same plain-manager pattern remains in unfixed paths (T-06x: recordPayment/recordOnAccountPayment idempotency, other services); outside the four defects, not changed.
- Local only: not hosting/production readiness.

## Verdict
Locally verified: F-AUD-002, F-TRS-001, F-PAY-001 fixed and reconciliation clean. F-INV-001 open (awaiting contract decision). Local readiness for the next stage: **conditional — NOT ready until F-INV-001 is decided and T-09 re-run.**
