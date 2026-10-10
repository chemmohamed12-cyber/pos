# DAII Autonomous Testing & Verification — Final Report (2026-10-10)

Commit under test: `28829d9`. Evidence: `backend/docs/decisions/evidence-2026-10-10-biz/<T-id>/<runId>/` (SHA-256 manifest per run) and `run-logs/biz-run-FINAL.log`.
No product code was changed. LA-1 files untouched. No connection to hosting, 5433, 5656, dev DBs.

## 1. Dedicated test database and user
- Dedicated PostgreSQL 18 cluster `127.0.0.1:5546` (system_identifier 7695079006474257732), data dir `release-new/.test-cluster/pg5546/data`, scram-only, fsync=off, autovacuum=off. Facts: `evidence-2026-10-10-biz-cluster/cluster-facts.json`.
- Test role `daii_biz_test`: non-superuser, CREATEDB only. Bootstrap role `daii_bootstrap` (administrative, setup only).
- Passwords: **hidden** — only in Windows User env vars `DAII_BIZ_PG_PASSWORD` / `DAII_BIZ_PG_BOOTSTRAP_PASSWORD`. Secret scan of evidence, tools and src found neither value.
- Databases are disposable per run: `daii_test_biz_tNN_{control_plane,company_a,company_b}`, dropped after evidence is preserved.
- DB guard: approved list contains exactly one entry (`dedicated-5546-biz`); `npm run test:db-guard` 50/50. Identity and privilege verified before any test.

## 2. Executed tests (frozen order, final run at 28829d9)
| Test | Result | Note |
|---|---|---|
| T-00 harness smoke | PASS | |
| T-01 / T-02 oversell | PASS | T-02d BLOCKED (no valid scenario with current product contract) |
| T-03 / T-04 / T-04b concurrency | PASS (frozen criteria) | audit-chain probe = FAIL-DEFECT (F-AUD-002), informational |
| T-05 treasury | FAIL-DEFECT (run-dependent) | F-TRS-001; deviation in some rounds |
| T-06 collection idempotency | PASS | T-06x probe FAIL-DEFECT (non-transactional idempotency) |
| T-07 returns | PASS | |
| T-08 payment apply | **FAIL-DEFECT / STOP** | F-PAY-001: over-application, unapplied −100.00 |
| T-09 inventory movements over HTTP | FAIL-DEFECT | F-INV-001 confirmed over real HTTP; E10/E13 return 500 instead of 404 |
| T-10 consolidated R1–R10 | STOP | only because T-08 contains a STOP; all other frozen runs reconcile |
| T-11 failure/recovery | PASS | |
| T-12 connection loss mid-posting | PASS | no partial effect, retry posts once |
| T-13 (F-AUD-002 reproducer) | FAIL-DEFECT with plain manager; PASS with transaction manager | |
| T-14 (F-TRS-001 reproducer) | FAIL-DEFECT with plain manager; PASS with transaction manager | |

## 3. Domain results
- **Inventory**: no oversell under T-01/T-02/T-03/T-04; moving-average and GL reconcile (R-checks PASS) in T-01/T-03/T-07. F-INV-001 (stock-movement export/scope bypass) confirmed via HTTP in T-09.
- **Treasury**: F-TRS-001 — concurrent withdrawals are not serialized (overdraft −20.00 observed); the transactional variant passes. T-06x: treasury idempotency non-transactional.
- **Payments**: collection idempotency PASS (T-06); payment-apply over-application F-PAY-001 (T-08).
- **Accounting**: GL relations and R1–R10 PASS in all frozen runs except T-08 (blocked by its own STOP).
- **Company isolation**: no cross-company leakage observed in T-01…T-12 (two-company harness, fingerprint before/after unchanged for the other company). Authorization-scope bypass only in F-INV-001.
- **Audit**: chain forks under concurrency with a plain EntityManager (F-AUD-002).

## 4. Performance & capacity
**NOT EXECUTED.** Decision D-10 (50–1,000 concurrent users) has no approved source; numbers remain proposals. The only environment available is local (i7-7600U 2C/4T, 15.9 GB), which cannot be extrapolated to hosting. Concurrency levels exercised in functional tests (up to 80 simultaneous connections, 60 concurrent audit writes) are correctness probes, not capacity measurements.

## 5. Defects (no product fix applied; each needs separate authorization)
| ID | Summary | Evidence | Required action |
|---|---|---|---|
| F-INV-001 | stock movement export bypasses warehouse scope | T-09 | fix + retest T-09 |
| F-AUD-002 | audit hash chain forks when `record` gets a plain manager | T-03 probe, T-13 | wrap callers in `manager.transaction` or make `record` open its own transaction; retest T-13/T-03 |
| F-TRS-001 | treasury concurrent withdrawals unserialized | T-05, T-14 | same pattern; retest T-05/T-14 |
| F-PAY-001 | payment over-application | T-08 | lock/validate within transaction; retest T-08 then T-10 |
| HTTP-500 | unknown ids give 500 instead of 404 (T-09 E10/E13) | T-09 | map to 404 |
| T-06x | treasury idempotency not transactional | T-06x | same pattern |

Systemic cause: services/controllers pass `req.companyContext.dataSource.manager` (a plain manager), so `pg_advisory_xact_lock` and check-then-insert are not in one transaction.
Test-tool faults fixed within scope (acceptance criteria unchanged): T-08 invoice number length, R8 output-VAT scoping, coverage-test lists, scratch-dir race, T-10 scope aligned to frozen T-01…T-08.

## 6. Not executed
- TEST-01 capacity/performance (reason in §4).
- T-02d (BLOCKED).
- Re-runs after fixes (no fix authorized).
- Open decisions untouched: D-1 (TEST-03 identity), D-9 (hosting read-only queries / seq 1 audit chain), D-10.
- Any hosting/production-level checks.

## 7. Verdict
**Locally NOT ready for the next test stage.** The harness, guard, isolation and reconciliation tooling are proven and 8 of the frozen scenarios pass. But candidate P0 defects (F-PAY-001, F-TRS-001, F-AUD-002, F-INV-001) are open and T-08/T-10 cannot pass until they are fixed. Next: authorize the fixes, rerun T-05, T-08, T-09, T-10, T-13, T-14, then run capacity tests once D-10 numbers are approved. Local success is not hosting/production readiness.
