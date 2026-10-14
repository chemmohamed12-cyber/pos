# Release 1.1.6 — final readiness report (2026-10-09)

**Package:** `D:\DAII-LOCAL-DEPLOY\release-out\Daii-Release-v1.1.6-2026-10-09.zip` (4 968 989 bytes)
**SHA-256:** `323c90be139930fe920a391f47c1045c5053e090b71cbe8146aa6606f21b5c19`
**Built from commit:** `37f1eb7` (branch `release-1.1.6`, worktree `daii.xnexustech.com/merge-116`). `tools/build/build-release.sh --skip-install` → `VERIFY: PASSED` (3 888 manifest files, 0 problems, dist JS syntax 0 bad, secret scan clean). Manifest: version 1.1.6, `packageType: full`, `migrationRequired: true`, `migrationCount: 288`.
**Not deployed anywhere. No production data or historical record was touched. daii_dev was not modified by this work** (read-only queries only; one earlier upgrade of daii_dev through the real engine, 2026-10-09, was separately authorised).

## 1. Status vocabulary
| Item | Status |
|---|---|
| Company creation on shared host (pool / create modes, one DB per Company, resumable provisioning) | VERIFIED on isolated PostgreSQL; NOT verified on the real cPanel host |
| Stock-export scope bypass | VERIFIED (unit + coverage + mutation) |
| Authorization B1 / B2 | VERIFIED at spec + HTTP level on the isolated environment |
| Scoped-user p95 gate (<= +25% vs pre-F1) | MET on the measured environment (worst +14%) — see §4 |
| Immediate revocation | VERIFIED over HTTP |
| Full regression | 185/186 suites passed; the 1 failure was a test assertion, fixed and re-run green — see §3 |
| **Authorization Foundation** | **IMPLEMENTED / VERIFIED. NOT declared CLOSED**: open items §6 (audit `seq 1`, 503, secrets) and no UAT yet |
| Audit chain break at production `seq 1` | OPEN — cause UNKNOWN, needs host read-only queries |
| 503 after 1.1.4 | OPEN — cause UNCONFIRMED |
| Exposed secrets | OPEN — plan written, nothing executed |

## 2. What 1.1.6 contains (all approved fixes) and where the evidence is
| Fix | Code | Test evidence |
|---|---|---|
| Installation row initialised (unlicensed-full); 409 gate | `installation-bootstrap.service.ts`, `company-registry.controller.ts` | `installation-bootstrap.real-pg.spec` (8), `...installation-gate.spec` |
| Engine: env check before swap, HTTP readiness, classified outcomes, evidence | `release-execution.service.ts` | `release-execution-readiness.spec`, `...environment-check.spec` |
| Expand/contract guard per column; F2/F3 migrations split | `expand-contract-guard.ts`, migrations 1790003/1790005 | `expand-contract-guard.spec` (13) |
| Company DB allocation `COMPANY_DB_MODE=create\|pool`, admin role, classified 422s | `company-database-allocator.ts`, `company-registry.controller.ts`, config | `company-database-allocation.http.real-pg.spec` (6) |
| One physical database per Company (UNIQUE index, migration 1790011; refuses if duplicates exist) | `1790011000000-DatabaseRegistryUniqueDatabaseName.ts` | `company-database-pool.multi-process.real-pg.spec` (3: 6 OS processes / 3 pooled DBs → exactly 3 Companies) |
| Resumable provisioning `POST /installation/companies/:id/retry-provisioning`; admin checked before allocation; health-check crash marks FAILED | controller, `database-provisioning.service.ts` | `company-database-pool.full-flow.real-pg.spec` (7: full migrations over HTTP, restart durability, fault at migrations / role-seeding / initial-admin / health-check ×2 then resume on the SAME Company and database) |
| Backup retention never deletes a release-referenced backup; records before files; per-run isolation | `backup-manager.service.ts` | `backup-manager.retention.spec` (5) |
| Boot actor `NULL` instead of `'system'` | `release-execution.service.ts` | `reconcile-interrupted-deploys.spec` (+1) |
| Audit chain no longer forks under concurrent writers (advisory lock) | `audit.service.ts` | `audit-chain-concurrency.real-pg.spec` (mutant reproduces the fork) |
| Authorization closure delta: Decision 3 (`company_admin` default), Decision 4-C, **B1** (`core.company.organization.manage`, migrations 1790012/1790013, org self-assignment refused), **B2** (single-statement ctx+scope, sales-orders passthrough) | see commit `fdac389` | CTO-decisions, new-Company, organization isolation, workflow-rules specs; HR suites 21/21 on 5544 |
| **Stock-export scope bypass fixed** | `inventory.controller.ts` | `stock-report-export.scope.spec` + coverage spec (every `@WarehouseScopeFiltered` handler must apply the scope); mutant: removing the line fails both |
| **Performance:** parallel Membership + registry read in `CompanyContextGuard`; prepared (named) authorization+scope statement | `company-context.guard.ts`, `access-scope.service.ts` | §4 |

**Deliberately NOT in 1.1.6:** LA-1 Layer 2 work (schedulers, installation-audit controller, company-lifecycle admission) — uncommitted foreign work awaiting CTO; the UTC business-date fix for the 00:00–03:00 Cairo grni false drift (never committed in the main tree).

**Migrations:** 288 total; new vs 1.1.5: 1790011 (unique index), 1790012, 1790013. Order is by timestamp. 1790011 refuses (changing nothing) if `database_registries` already holds a duplicate `databaseName`. daii_dev was checked read-only: no duplicates. The host has not been checked.

## 3. Full regression (HEAD `b246e22`, then one test-only fix)
Command: `npx jest --testTimeout=240000` on the merged worktree, isolated PostgreSQL 5544, nothing else running, closing-snapshot signing env loaded.
- **Test Suites: 185 passed, 1 failed, 1 skipped, 187 total** · **Tests: 1295 passed, 1 failed, 1 skipped, 1297 total.**
- Skipped by design: `t0-clean-company-baseline` (opt-in audit run).
- The 1 failure — `company-lifecycle-layer1.real-pg.spec` (isolation A/B): **TEST DEFECT caused by my own change** — the guard now passes the already-read registry row as a 2nd argument to `getDataSource`, and the assertion `toHaveBeenCalledWith(companyBId)` expected one argument. I rewrote it to assert the first argument of every call equals `[companyBId]` (stricter: it also proves A's DataSource was never requested; the old `not.toHaveBeenCalledWith(companyAId)` would have become vacuous). Re-run of that suite + the guard spec: **26/26 pass** (commit `1eaf7ab`). The full suite was **not** re-run end to end after this test-only edit; no production code changed after `b246e22`.
- Earlier runs on this branch that failed or timed out (4 suites in the pre-merge run, 2 in the first merged run) were classified before: concurrent jest jobs sharing fixed database names + 1075 s timeouts (environment), the provisioning spec registering several Companies on one database (conflicts with the new invariant — fixed by giving each its own database; the UNIQUE index stays), and a stale administration-node count (B1 added a fifth node — updated, and the node's seeding is asserted). A full run was interrupted on purpose when I edited files under it (invalid, discarded).

## 4. Authorization performance (3 runs × N=100, interleaved, warm-up 5, zero non-200, Throttler respected)
Scoped user (explicit grant on one branch) vs the **pre-F1** build, p95; merged build with the final changes (round 3, `evidence-2026-10-09/benchmark-round3-prepared-statement-FINAL.txt`):

| Endpoint | pre-F1 p50 / p95 / p99 | merged ADMIN | merged SCOPED p50 / p95 / p99 | scoped p95 vs pre-F1 |
|---|---|---|---|---|
| sales-orders list | 11.3 / 16.9 / 35.2 | 10.2 / 15.8 / 43.4 | 10.2 / 14.4 / 34.0 | −15% |
| sales-orders page | 10.3 / 16.1 / 24.6 | 9.5 / 15.0 / 29.3 | 9.7 / 15.1 / 36.7 | −6% |
| sales-orders/:id | 11.6 / 16.2 / 28.4 | 11.0 / 15.8 / 19.9 | 11.3 / 16.3 / 47.1 | 0% |
| purchase-orders | 10.2 / 13.0 / 27.3 | 8.6 / 10.9 / 37.3 | 10.3 / 12.9 / 30.9 | −1% |
| purchase-requests | 9.3 / 13.3 / 30.8 | 8.1 / 11.0 / 18.5 | 9.3 / 12.4 / 16.3 | −7% |
| inventory/warehouses | 6.9 / 8.8 / 18.7 | 7.0 / 9.8 / 20.0 | 6.7 / 8.9 / 19.0 | +1% |
| inventory/stock | 6.6 / 10.5 / 17.9 | 7.3 / 10.3 / 15.0 | 7.2 / 10.8 / 20.2 | +3% |
| inventory/reports/stock | 6.2 / 8.7 / 12.9 | 7.0 / 9.2 / 13.2 | 7.1 / 9.9 / 25.7 | **+14%** (worst) |
| warehouse-transactions page | 6.6 / 9.4 / 13.2 | 7.2 / 10.6 / 29.7 | 6.4 / 9.5 / 12.8 | +1% |
| warehouse-transactions/overview | 7.7 / 11.4 / 14.6 | 8.4 / 12.0 / 16.5 | 7.8 / 10.6 / 22.6 | −6% |

**Gate (scoped p95 ≤ pre-F1 + 25%): met on all ten endpoints.** Progression of the worst case: round 1 (before optimisation) +50% with 3 endpoints over the limit (`sales-orders/:id` +30%, `inventory/stock` +46%, `inventory/reports/stock` +50%); round 2 (parallel Membership/registry read only) +42%; round 3 (final) +14%.

**Baseline varies between rounds — read the ratios, not the milliseconds.** The pre-F1 baseline itself ran at p50 4.4–5.0 ms (round 1/2) for the inventory endpoints and 6.2–6.9 ms in round 3; the machine was busier. The ratio against a baseline measured in the same interleaved run is what the gate uses.

**Cause found and fixed:** a per-request SQL timeline showed that the single combined authorization+scope statement cost ~1.1 ms of PLANNING per request (unnamed statement: bind 1.0–1.4 ms vs 0.2 ms to execute). It now runs as a named, prepared statement on the pool connection (same text, parameters and rows); and the Membership and registry reads in `CompanyContextGuard` are issued together (Company status is still read after Membership, so refusal order and "a non-member never causes the status to be read" are unchanged). No cache holds authorization data.

**SQL statements per request: NOT MEASURED in the final rounds** (the counting instance was not set up). The earlier per-request SQL trace on the pre-optimisation build is in the closure report (§5.3); it was not repeated after B2 / the guard change. No claim about statement counts is made here.

**Immediate revocation (HTTP, one token held across all changes — `evidence-2026-10-09/revocation-immediacy-result.txt`, tool `authz-tools/revocation-http-verification.js`):** scope revoked → warehouse hidden on the very next request and the 7 after; scope re-granted → visible on the next request; permission revoked (guarded read) → 404 on the next request and the 5 after; permission restored → 200 immediately; membership removed → 403 immediately. Note: `GET /inventory/reports/stock` has no permission node at all (membership + scope only) — same on the pre-F1 build; my first revocation attempt used it and correctly showed nothing to revoke.

## 5. Security notes on this release
- Stock export now scope-filtered (it was an HTTP-proven bypass for scoped users). Same Company only; no cross-Company exposure ever existed.
- `COMPANY_DB_MODE=pool` never recycles a non-empty database, never reuses an assigned one; allocation is also guarded by the database (UNIQUE) against several workers.
- A failure after allocation leaves the Company `PROVISIONING` (invisible in lists) and `FAILED` registry row with its database still assigned to it; recover with `retry-provisioning`; abandoning one is a deliberate, approved cleanup (nothing automatic, nothing destructive).

## 6. Risks and items that remain OPEN (not closed by this release)
1. **Production audit chain breaks at `seq 1` — cause unknown.** The race fixed here forks the chain at a LATER record (proved on daii_dev: seq 13/14 share a prevHash); it does not explain `seq 1`. Needs the three read-only queries in `COMPANY-DATABASE-ALLOCATION-AND-1.1.6-READINESS-2026-10-09.md` §2 run on the host. Existing broken chains are NOT repaired by 1.1.6 and no historical record has been touched.
2. **503 after 1.1.4 — root cause unconfirmed.** The pasted host environment has no `NODE_ENV` and secrets shorter than the 32 characters the production schema requires, which weakens (does not disprove) the "new required `DATABASE_CREDENTIAL_ENCRYPTION_KEY`" hypothesis. Needs the cPanel Application mode and the Passenger log around the 1.1.4 swap.
3. **Exposed secrets.** Plan only (§7 of the previous report): rotate the JWT pair (signs everyone out); do NOT replace `INTEGRATION_ENCRYPTION_KEY` / `DATABASE_CREDENTIAL_ENCRYPTION_KEY` until a re-encryption tool exists and is tested on a copy.
4. **cPanel behaviour of `pool` mode is not verified on the real host.** Needed before use: empty databases created in cPanel, the application user granted access (CREATE on the database for `uuid-ossp`), `COMPANY_DB_MODE=pool` and `COMPANY_DB_POOL` set. The first Company creation on the host should be treated as the acceptance test.
5. **Migration 1790011 on the host** stops with a clear message if the host registry already contains a duplicate `databaseName`; check with `SELECT "databaseName", count(*) FROM database_registries GROUP BY 1 HAVING count(*) > 1;` before deploying.
6. **Backups already damaged on the host** (files gone, rows present) are not detected or repaired.
7. Authorization Foundation formal closure still needs UAT sign-off; the closure report in the main checkout carries the history (its 2026-10-09 addendum predates the fixes above).
8. Not done / deferred: F-7 (verify the restored app over HTTP after a rollback), UI surfacing of DEPLOYED_UNVERIFIED, catch-up of non-READY Companies skipped by fan-out (fan-out stays OFF by default), SQL-statement counting after the final changes, the UTC business-date fix, LA-1 Layer 2.
9. Test-only code ships in `dist/foundation/testing/` (existing practice; includes the new `company-pool-worker.js`, inert).

## 7. Files and commits
Branch `release-1.1.6` = `master` (authorization closure delta `fdac389`) + merge `efdd74d` of `release-company-fanout`, then `2beea8a`, `b246e22`, `1eaf7ab`, `37f1eb7` (version). Changes since F6 (`33aae63`): 106 files, +7 224 / −213 (`git diff --shortstat 33aae63 HEAD`). Production sources changed are listed by `git diff --name-only 33aae63 HEAD -- backend/src`; evidence files are under `backend/docs/decisions/evidence-2026-10-09/`.
