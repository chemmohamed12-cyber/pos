# DAII — Verification Closure & Release Decision Report (2026-10-11)

Reference: `e9be53a` → this report (working tree also carries commit `f14f162`, produced by a parallel TEST-03 assessment session in the same repository; its documents are cited, not repeated). Environment: dedicated local cluster 127.0.0.1:5546 (PostgreSQL 18.6, system identifier 7695079006474257732), role `daii_biz_test` (non-superuser, CREATEDB only); credentials never exposed. Hosting, production, 5433, 5656, LA-1, the protected baseline and `company-audit-access.real-pg.spec.ts` were not touched. Frozen criteria unchanged. Status vocabulary: PASS / FAIL-DEFECT / BLOCKED / NOT RUN.

## 1. Local functional and integrity readiness — **READY**
| Evidence (this round) | Result |
|---|---|
| Unit suite | PASS 59/59 suites, 430 tests |
| Database guard suite | PASS 50/50 (drift test now covers every spec prefix; look-alike names stay refused) |
| Business suite T-00…T-12, reproducers F-AUD-002/F-TRS-001, T-15 (last full run `cff8a53`) | PASS (no product code changed since) |
| T-16 HTTP capacity run | integrity oracle PASS, 10,495 requests, 0 errors, R1–R10 PASS |
| Four remediated defects | F-AUD-002, F-TRS-001, F-PAY-001, F-INV-001: PASS (unchanged) |
New finding, outside the four defects (not fixed — no authority): see §7, N-01.

## 2. Remaining real-Postgres and tenant-isolation coverage
Mechanism: optional `DAII_TEST_DB_NS=biz_t90_` (validated fail-closed) → disposable databases `daii_test_biz_t90_<prefix>_*`; guard policy, approved entry and hard denials unchanged.
| Group | Specs | Status | Evidence |
|---|---|---|---|
| Audit / treasury / payments / inventory (previous round) | 16 | PASS 16 | `run-logs/regression-1.log` |
| Remaining harness-based domain isolation specs | 60 | **PASS 60/60** (one opt-in test inside the set is skipped by design) | `run-logs/regression-2.log`, `tools/testing/regression-specs-2.txt` |
| of which `products` and `delivery` isolation (previously refused: prefix contained "prod"/"live") | 2 | PASS — test-only prefix rename (`items_isolation`, `courier_isolation`); the guard's protected-name rule was not touched | same log |
| Mock-only / no-database-of-their-own specs | 5 | PASS 4 · **BLOCKED 1** (`release-migration-registry.real-pg.spec.ts`: its own safety assertion `assertIsolatedInstance()` hard-codes port 5544, the superseded cluster) | `run-logs/regression-3.log` |
Totals for files executed with the namespace mechanism this round and last: **80 PASS, 1 BLOCKED, 0 FAIL-DEFECT**.

Specs with independent connection logic (33 inventoried, `run-logs/regression-coverage-inventory.txt`), classified:
| Class | Count | Specs | Status / reason |
|---|---|---|---|
| Unit-mode (no database) | 3 | closing-snapshot, authorization-context, membership-role-provisioning | PASS in the unit suite |
| Mock-only | 4 | area6-company-isolation.acceptance, permission-path-company-isolation.acceptance, company-connection-manager.service, release-execution-environment-check | PASS (this round) |
| Already adapted (namespace on fixed names) | 2 | area14-company-audit, audit-chain-concurrency | PASS |
| Our own business-test specs | 4 | biz-harness-smoke, T-09, T-12, T-16 | PASS (business suite) |
| **Needs a separate adaptation — shared helper pinned to port 5544 and issuing admin statements** (`pg_terminate_backend`, `pg_database … LIKE`) | 6 | module-add-existing-company, new-company-default-administrator, provisioning-lifecycle, ui-created-company-admin, limits-scope, release-migration-registry | **BLOCKED**. Needs (a) helper port assertion for the approved cluster, (b) namespace on fixed names, (c) a CTO/guard decision on whether those two admin statements may be allowed — not decided here, guard not weakened |
| Needs a test-only namespace on fixed database names (no guard change expected; INFERRED from code reading) | 7 | memberships-mine, company-membership-provisioning, database-provisioning.service, company-datasource-factory-impact, company-datasource-registry-isolation, restore-manager-audit-chain, company-migration-runner | NOT RUN |
| Databases named by the product itself, or child processes (guard design decision needed; INFERRED) | 6 | company-database-allocation.http, company-registry.controller.database-creation, company-database-pool.full-flow, company-database-pool.multi-process, company-fanout, installation-bootstrap | NOT RUN |
| Held: carries uncommitted edits by others | 1 | company-audit-access.real-pg.spec.ts | NOT RUN (instruction) |
Counting 33 = 3 + 4 + 2 + 4 + 6 + 7 + 6 + 1.

## 3. Capacity — measurements vs approved targets
Approved targets: **none (approval pending)**. T-16 is **NOT CLASSIFIED**, not PASS and not FAIL. Measured: ~31–39 req/s plateau from 5 users upward on a single-process, shared 2-core machine (Node ≈ 93 % of one core), p95 345 ms at 5 users → 3.8 s at 50, 0 errors, immediate recovery; hosting limit UNVERIFIED. One decision brief: `CAPACITY-DECISION-BRIEF-FOR-CTO-2026-10-11.md` (measured facts / assumptions / proposed requirements separated; detail in `CAPACITY-WORKLOAD-ASSUMPTIONS-AND-PROPOSED-TARGETS-2026-10-10.md`). Staging-like profile prepared: `STAGING-CAPACITY-PROFILE-2026-10-11.md` + `tools/testing/capacity-loadgen.js` (separate machine, refuses hosts containing "prod", requires a named authoriser; mechanics smoke-tested only against a throw-away loopback mock — **no hosting or staging host was contacted**) → status **NOT RUN**.

## 4. F-INV-001 — compatibility and release decision
Operator guide with scope (every Company database, all history + last 90 days), queries Q1–Q4, evidence to return and interpretation: `F-INV-001-OPERATOR-EXECUTION-GUIDE-2026-10-11.md` (+ `…USAGE-MEASUREMENT-QUERIES…`). Status **BLOCKED — external dependency:** no authorised operator/read-only access to real Company databases (D-9). Historical usage and external integrations: **UNKNOWN** (internal callers VERIFIED not to POST non-receipt types). **Release decision: the 410 change is NOT APPROVED FOR RELEASE and must not be deployed.**

## 5. Hosting readiness and unverified assumptions — **UNVERIFIED**
Not verified: any hosting capacity or behaviour; separate load generator; multi-instance behaviour; fsync/disk, network and pool effects; 30-minute soak; 200/1,000 users; memory leak (RSS +19 % over 5 min in a harness that includes the test framework); backlog behaviour of the event outbox at high volume (`EVENT-OUTBOX-DISPATCH-BEHAVIOUR-2026-10-11.md`: the in-request flush claims ≤ 50 rows inline per call, the 30-s sweep ≤ 250 rows per Company per sweep, retries ≤ 5 then `failed`; local backlog stayed ≤ 16 at ~35 req/s; evidence needed: backlog over time at 1×/3×/10× rate, handler duration, multi-instance run, failing-handler run, recovery time).

## 6. D-1 and D-9
- **D-1** (TEST-03 identity): the parallel session produced assessment reports (`test-03/…`); the identity decision itself is still the CTO's — **OPEN**.
- **D-9** (real-data/hosting read-only access; F-INV-001 usage; seq-1 audit-chain diagnosis): **OPEN — BLOCKED** on an operator and authorisation (§4).

## 7. Defects, risks, and architectural audit (Priority 4)
**Deprecated `IdempotencyService.withIdempotency`:** marked `@deprecated`; no production caller (TreasuryController moved to `withIdempotencyInTransaction`); remaining callers are two specs (`treasury.company-isolation.spec.ts`, T-06 probe). Kept on purpose.
**Plain-manager pattern — classification by VERIFIED risk (T-17 probes, `evidence-2026-10-10-biz/T-17/…`):**
| Primitive / path | Plain manager (as a controller passes it) | Inside `manager.transaction` | Status |
|---|---|---|---|
| `NumberingService.getNextNumber` (`SELECT … FOR UPDATE` then `UPDATE lastNumber`) | FAIL-DEFECT — duplicate numbers in 10 of 10 rounds; 200 requested, `lastNumber` ended at 28 | PASS (200 distinct) | **N-01 (new, VERIFIED)** |
| `ProcessEngineService.transition` (`FOR UPDATE` then `UPDATE currentState`) | FAIL-DEFECT — up to 8 of 8 identical concurrent transitions accepted (2 are legal); history rows duplicated | PASS (exactly 2) | **N-01 (new, VERIFIED)** |
| Live path `CustomersService.createCustomer(dto, user, req…manager)` | FAIL-DEFECT — only 10–12 of 120 concurrent creates succeed, the rest raise unique-violation 23505 (HTTP 500) | PASS 120/120 | **VERIFIED** (loud failure, not silent corruption, because the code column is unique) |
| Call sites of numbering/transitions | 35 files (more than 100 call sites); files with no transaction opener at all: `supplier.service`, `sales.service`, `price-lists.service`, `approval-process` (heuristic, INFERRED: `plain-manager-callsite-heuristic.txt`) — the heuristic cannot prove safety of files that do open transactions elsewhere | | INFERRED exposure; per-endpoint concurrency tests NOT RUN |
| Already fixed (audit, treasury, payment-apply) | PASS after the one-line "join only an active transaction" rule | | closed |
| Inventory reservations, moving-average valuation under plain manager | PASS in T-01/T-02/T-03 (plain wide manager) | | VERIFIED by test |
**Silent-corruption risk:** the transition race can record two transitions for one state change (a state-machine violation) — outside the four authorised defects; **no product change made** (stop condition: data-integrity risk outside scope). A fix of the same size as the earlier ones (apply the "join only an ACTIVE transaction, otherwise open one" rule inside the two primitives) is proposed, together with per-endpoint concurrency tests, but needs your authorisation because both primitives are used by more than 100 call sites.
**Other risks:** event dispatch coupling (§5); no hosting evidence; capacity targets unapproved.

## 8. Final verdict
| Dimension | Verdict |
|---|---|
| Local functional and integrity readiness | **READY** (for the executed scope), with **N-01 open** |
| Tenant-isolation / real-Postgres coverage | **80 PASS, 1 BLOCKED, 19 specs NOT RUN** with reasons (§2) |
| Local capacity readiness | **NOT CLASSIFIED** — targets pending |
| API compatibility (F-INV-001 410) | **NOT READY — BLOCKED** (no operator/real-data access) |
| Hosting readiness | **UNVERIFIED** |
| Overall release approval | **NOT APPROVED** |

## 9. Decisions required from the CTO
1. **Authorise N-01 remediation** (numbering + process-engine primitives, plus per-endpoint concurrency tests) — or accept the risk.
2. **Name an operator** and authorise the read-only F-INV-001 queries (D-9); decide the 410 release only after the returned evidence.
3. **Approve or replace** the workload assumptions and capacity targets in the brief (D-10).
4. **Provide** an authorised staging-like host, a separate load-generator machine and the person who authorises load (or declare hosting capacity out of scope).
5. **Guard decision** for the 6 provisioning/characterization specs that need two admin statements (`pg_terminate_backend`, catalogue `LIKE`) and for the 6 specs where the product names the databases; approve the test-only namespace adaptation of the 7 fixed-name specs.
6. **D-1** (TEST-03 identity).
