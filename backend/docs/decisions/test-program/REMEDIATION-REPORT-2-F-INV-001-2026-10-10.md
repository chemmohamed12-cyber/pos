# F-INV-001 Remediation & Local Readiness Closure (2026-10-10)

Base: `6814643`. Local isolated cluster 127.0.0.1:5546 only. No migration, no data change, no deployment, LA-1 untouched, frozen criteria untouched (T-09 expectations unchanged; one informational case T-06y added to the T-06 spec, nothing weakened).

## 1. Root cause and exact changes — F-INV-001
Root cause: `POST /inventory/movements` passed any of six `movementType` values straight to `InventoryService.recordMovement`, i.e. a raw ledger row with no document, reservation, valuation or negative-stock control (dispatch/adjustment/transfer/return accepted with 201, negative on-hand produced). Separately, an unknown/foreign warehouse or product id reached the insert and died on the foreign key (HTTP 500).
Changes (2 files):
- `inventory.controller.ts` `recordMovement`: any type other than `receipt` → `410 Gone`, body code `INVENTORY_MOVEMENT_TYPE_CLOSED`, thrown before any read or write. `receipt` keeps the existing manual-receipt path (cost + reason code validation unchanged). Decorators (permission, warehouse scope) are untouched and run first.
- `inventory.service.ts`: new `assertMovementTargetsExist(warehouseId, productId, manager)` (malformed/unknown warehouse or product → `404`, before any write), called by the controller for receipts.
Internal callers of `InventoryService.recordMovement` (warehouse transactions, work orders, goods receipt, returns) call the service directly and are NOT affected.

## 2. API usage and compatibility findings
VERIFIED (text search, this session and the earlier trace): the current frontend bundle and archived copies call only `GET /inventory/movements/:id` and `GET reports/movements`, never `POST`; the only repository script posting to the endpoint is `authz-tools/closure-http-verification.js:96`, a permission-denial probe (expects a refusal, body incomplete); tests seed via the service. All 14 in-repo production callers of `recordMovement` use the service, not HTTP.
NOT ESTABLISHED / UNVERIFIED: external API-key integrations and operator scripts at customers or on hosting; historical real-data usage of non-receipt types (the measuring query in `F-INV-001-FINAL-CONTRACT-AND-T09-CRITERIA §1` needs hosting/dev data, forbidden here, D-9). The sibling projects 2/3/4 are not present at the searched path in this session (their earlier trace result is cited, not re-measured).
**Backward compatibility is NOT proven.** This is an intentional contract change (410 on five types; 404 instead of 500 on unknown ids). It is local only and must not be deployed before the usage measurement/approval.

## 3. Test-by-test results (final full run, `run-logs/remed2-FULL.log`, exit 0; evidence `evidence-2026-10-10-biz/<T-id>/<latest run>/`)
T-00 PASS 1; T-01/T-02 PASS 17 + T-02d BLOCKED (unchanged); T-03/T-04 PASS 20; T-05 PASS 13; T-06 PASS 15 + T-06x-INFO FAIL-DEFECT (legacy composition, see §6); T-07 PASS 13; T-08 PASS 13; T-09 PASS 36 (E1–E14 incl. E3–E8 → 410 no trace, E10/E13 → 404, zero negative-stock pairs); T-10 PASS (R1–R10 over T-01,03,05,06,07,08); T-11 PASS 15; T-12 PASS 14; F-AUD-002 reproducer PASS 2; F-TRS-001 reproducer PASS 2. Unit `test:unit` 59/59 suites, 430 tests; `test:db-guard` 50/50.

## 4. Before / after, four defects
| Defect | Before (a55ed87) | After |
|---|---|---|
| F-AUD-002 | chain fork with plain manager | PASS: valid chain, 0 forks, audit probes PASS in all runs |
| F-TRS-001 | overdraft −20.00 observed | PASS: 15 rounds 0 overdrafts; T-05 3 of 10 succeed |
| F-PAY-001 | unapplied −100.00 | PASS: 20 rounds unapplied 200.00 |
| F-INV-001 | T-09: 15 FAIL-DEFECT, negative stock, HTTP 500 | T-09 all PASS, negative pairs 0, 404 on unknown ids |

## 5. Reconciliation & regression
R1–R10 PASS in every reconciling run (T-01,03,05,06,07,08 = T-10 verdict PASS); T-09/T-11/T-12 informational reconciliations also PASS; audit chain valid in every run. Concurrency assertions: treasury cannot exceed balance; payment applications ≤ unapplied; no audit fork; rejected inventory requests leave zero table-fingerprint difference.

## 6. T-06x status
Evidence: payment recording (`/payments`, `/payments/on-account`) already used `withIdempotencyInTransaction` → T-06 PASS (1 effect for 5 concurrent replays). The residual was the Treasury controller (`cash-in`, `cash-out`, `transfer`), which used the non-transactional, lock-free `withIdempotency`: 5 concurrent same-key requests produced 5 movements (T-06x-INFO, not resolved by the three earlier fixes). Fix: `treasury.controller.ts` now uses `withIdempotencyInTransaction` (per-key advisory lock; dedup record and cash legs commit together) and dispatches events after commit (EventBusService injected). Proof: new T-06y drives the REAL `TreasuryController.cashIn` 5× concurrently with one key → 1 movement, 1 distinct result id; different key → separate movement (PASS). T-06x-INFO still reports FAIL-DEFECT because it deliberately exercises the legacy `withIdempotency`; no production caller of it remains (grep), the method is kept.
Remaining risks: `withIdempotency` stays available for future misuse; cash-out/transfer endpoints are covered by the same code change but only cash-in has a dedicated concurrent test; `recordPayment`/`recordOnAccountPayment` called with a plain manager outside the controller (no transaction) were not changed; real-pg specs in the main suite (audit, treasury, payments, inventory) cannot run under the guard, so wider regression rests on unit + business suites.

## 7. Verdict: LOCAL READY — conditional
LOCAL READY for the frozen local scope: all executed business tests pass, reconciliation is clean, the four defects are fixed with preserved evidence. Outstanding blockers before any further stage: (1) the F-INV-001 contract change is not proven backward compatible — external consumers/historical usage UNVERIFIED, so it must not be released without the usage measurement and approval; (2) T-02d BLOCKED, capacity testing (D-10) and the wider real-pg regression not executed; (3) local result is not hosting/production readiness.
