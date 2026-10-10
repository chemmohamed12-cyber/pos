# DAII — Local Readiness Closure Report (2026-10-10)

Base: `fc9282d`. Scope: local isolated cluster 127.0.0.1:5546 only. Nothing deployed; LA-1, hosting, 5433, 5656 untouched; no credentials in evidence; frozen criteria unchanged.
This report separates: (A) local results, (B) compatibility, (C) performance, (D) what still requires verification on a real/hosting environment.

## A. Local results (executed)
| Item | Result | Evidence |
|---|---|---|
| Full business suite T-00…T-12 + reproducers (run after the latest changes) | ALL PASSED, exit 0 — T-01/T-02 now 18/18 PASS including **T-02d** | `run-logs/next-FULL.log` |
| T-02d (assemble with a missing component) | was BLOCKED (BOM not wired). Harness now wires the real `BomService`; refusal case: 409, zero fingerprint change, stock unchanged → PASS. Not covered: a *successful* assembly (the harness event bus is a stub; covered by Work Order specs) | `T-01/<run>/T-02d.json`, `run-logs/next-T01.log` |
| T-10 reconciliation R1–R10 | PASS in every reconciling run, including the capacity run | `T-10/<run>`, `T-15/<run>/reconciliation-R1-R10.json` |
| Unit regression | 59/59 suites, 430 tests | `npm run test:unit` |
| DB guard | 50/50 | `npm run test:db-guard` |
| Four defects | F-AUD-002, F-TRS-001, F-PAY-001, F-INV-001: fixed and verified (see REMEDIATION-REPORT-2026-10-10 and …-2-F-INV-001-…) | |

### T-06x / legacy wrapper (decided)
T-06y proves the real `TreasuryController` path is safe; it does not erase T-06x, which keeps FAILING by design because it exercises the legacy `IdempotencyService.withIdempotency`. Reference check (grep over `src`): **no production caller remains**; the only callers are two spec files (`treasury.company-isolation.spec.ts` for Company isolation of the idempotency table, and the T-06x probe). The method is **kept but marked `@deprecated`** with the observed hazard (not concurrency-safe: 5 same-key requests → 5 movements). Removing it would break those specs and gives no safety benefit now; a later removal is a separate, safe cleanup once the isolation spec uses the transactional variant.

## B. Compatibility of the F-INV-001 contract change — NOT PROVEN
The endpoint now returns 410 `INVENTORY_MOVEMENT_TYPE_CLOSED` for dispatch/adjustment/transfer_in/transfer_out/return and 404 for unknown warehouse/product (was 500). Verified: no internal or frontend caller POSTs those types. **Unverified**: external integrations and real-data usage. The agent cannot measure it (needs a real Company database; outside scope, D-9). Ready-to-run read-only queries and the decision rule: `F-INV-001-USAGE-MEASUREMENT-QUERIES-2026-10-10.md`. The change must not be deployed before an authorised operator runs them and the result is reviewed.

## C. Performance & capacity — local BASELINE only (T-15)
D-10 (target users/SLOs) still has no approved numbers, so **no pass/fail threshold was applied**; this is a measurement. "In-flight" = simultaneous service-layer operations through a plain Company manager (controller-equivalent), not HTTP users.
Environment: Intel i7-7600U (2 cores / 4 threads), 15.9 GB RAM, PostgreSQL 18 on the same machine as the test process, fsync=off, autovacuum=off, pool 60, max_connections 200 — **not representative of hosting**.
Correctness under load (all levels 1/5/10/25/50, 380 operations per path): **0 errors**; treasury balance exact (1,000,000.00 funding − cash-outs + payments); 380 payments = 380 successes; 380 reservations = 380 successes (hot product, on-hand unchanged); 380 audit rows with the hash chain valid; no negative stock; R1–R10 PASS after draining 760 outbox events.
| operation | in-flight | ok/total | errors | ops/s | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|---|---|
| audit.record | 1 | 20/20 | 0 | 312.5 | 3 | 9 | 9 |
| treasury.cashOut(hot account) | 1 | 20/20 | 0 | 143.9 | 6 | 21 | 21 |
| payment.on-account(tx) | 1 | 20/20 | 0 | 57.3 | 16 | 38 | 38 |
| inventory.reserveStock(hot product) | 1 | 20/20 | 0 | 243.9 | 4 | 14 | 14 |
| audit.record | 5 | 20/20 | 0 | 150.4 | 4 | 133 | 133 |
| treasury.cashOut(hot account) | 5 | 20/20 | 0 | 149.3 | 32 | 66 | 66 |
| payment.on-account(tx) | 5 | 20/20 | 0 | 60.4 | 74 | 112 | 112 |
| inventory.reserveStock(hot product) | 5 | 20/20 | 0 | 166.7 | 21 | 62 | 62 |
| audit.record | 10 | 40/40 | 0 | 231.2 | 18 | 162 | 173 |
| treasury.cashOut(hot account) | 10 | 40/40 | 0 | 200 | 36 | 86 | 98 |
| payment.on-account(tx) | 10 | 40/40 | 0 | 62.9 | 141 | 212 | 228 |
| inventory.reserveStock(hot product) | 10 | 40/40 | 0 | 186 | 45 | 85 | 89 |
| audit.record | 25 | 100/100 | 0 | 204.9 | 57 | 444 | 488 |
| treasury.cashOut(hot account) | 25 | 100/100 | 0 | 177 | 88 | 270 | 307 |
| payment.on-account(tx) | 25 | 100/100 | 0 | 75.4 | 307 | 385 | 446 |
| inventory.reserveStock(hot product) | 25 | 100/100 | 0 | 185.2 | 100 | 236 | 248 |
| audit.record | 50 | 200/200 | 0 | 222.7 | 136 | 816 | 889 |
| treasury.cashOut(hot account) | 50 | 200/200 | 0 | 210.3 | 164 | 415 | 465 |
| payment.on-account(tx) | 50 | 200/200 | 0 | 74.9 | 598 | 772 | 902 |
| inventory.reserveStock(hot product) | 50 | 200/200 | 0 | 205.1 | 186 | 412 | 447 |

Observations: throughput of each path plateaus at ~200 ops/s (audit, cash-out, reservation) and ~75 ops/s (on-account payment, which also writes ledger, treasury leg, outbox and audit); latency grows roughly linearly with in-flight operations (queueing on the hot account/product/audit chain locks), as expected for serialized hot spots; no errors, deadlocks or timeouts. The audit chain is a single global serialization point per Company. A pre-existing trait seen again: one event dispatch drains at most 50 outbox events (batch size) — a high-volume run needs repeated dispatches (the known "Event Engine batching" open scope).
Not covered by T-15: HTTP/user-level load, mixed workloads across many accounts/products, long-duration soak, large data volumes, multi-Company parallel load, read/report paths.

## D. Still requires a real environment / decisions
1. Run the F-INV-001 usage queries on real Company data (D-9) and review before releasing the 410 change.
2. Approve D-10 targets (concurrent users, response-time SLOs) and repeat T-15 plus HTTP-level and soak tests on a hosting-like machine; the local numbers cannot be extrapolated.
3. Main-suite real-PG specs (audit/treasury/payments/inventory) cannot run under the guard (only `daii_test_biz_t..` approved): needs an approved pattern/DB or a CTO decision.
4. D-1 (TEST-03), D-9 diagnostics (hosting seq-1 audit chain) remain open; production rollout is a separate decision.

## Verdict
LOCAL READY (functional correctness, financial/inventory integrity, isolation, auditability, reconciliation) — **not release-approved**: contract compatibility unproven, capacity targets unapproved and only a local baseline exists, hosting/production unverified.
