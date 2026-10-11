# Verification track — status against the CTO directive "Verification, N-01/N-02, and Release Gates" (2026-10-11)

Source commit of this report: the commit that contains it (parent of record: `b591d1f`). Tested commits are named per row; evidence paths are inside `backend/docs/decisions/`. Status vocabulary: PASS / FAIL-DEFECT / BLOCKED / NOT RUN. The overall release decision is **NOT APPROVED**.

## 1. N-01 — numbering and process-transition concurrency
- Status: **CLOSED for the local scope** by the independent closure review (`test-03/N-01-REMEDIATION-AND-CLOSURE-REPORT-2026-10-11.md` §7, commit `b5dcece`). Source commits: `23e5ec1` (primitives, shared rule `foundation/transaction/run-in-transaction.ts`) and `7097796` (`registerDocumentType`). Tested commit: clean `git archive` snapshot of `a6002fa` (`test-program/COMMIT-AND-EVIDENCE-RECONCILIATION-2026-10-11.md`, evidence `evidence-clean-snapshot-2026-10-11/a6002fa/`): business suite T-00…T-20 exit 0, T-19 per-endpoint 15/15 (+ HTTP `POST /customers` 120/120), 20/20 isolation specs calling `registerDocumentType`, unit 59/430, guard 50/50. Commands: `node tools/testing/biz-run.js --continue-after-failure`; `… --regression tools/testing/regression-specs-registerdoc.txt` (with `REGRESSION_NS=biz_t91_`); `npm run test:unit`; `npm run test:db-guard`; `DAII_SOURCE_COMMIT=<sha>` pins the snapshot commit.
- Limits (unchanged): local scope only; no multi-instance run; call sites not individually concurrency-tested remain covered by the primitive fix only. Not reopened.

## 2. N-02 — reservation fulfilment race (kept separate)
See `N-02-FULFIL-RESERVATION-REMEDIATION-REPORT-2026-10-11.md`. Status: **fix implemented and verified by the implementing track; NOT CLOSED — independent review outstanding.** Source commit of the code: `a798d9d`; evidence/T-22 in `b591d1f`; baseline T-20 H3 on `a6002fa` (6 movements, on-hand −18). Tests: T-21 cases A–H (concurrency in plain and transaction style, retries, partial failure, outer rollback, order level, control, consistency). A pre-existing defect surfaced by the rollback case — **F-AUD-003** (a rolled-back audit write breaks the audit hash chain, reproducer T-22) — is reported separately and **not fixed** (needs authorisation: core component). Other N-02 findings (limit engine, `releaseReservedQuantity`, process-engine `start`, shipment transition probe BLOCKED) remain open and un-remediated.

## 3. Database guard and blocked tests (guard policy, approved entry, protected-name rules: **unchanged**)
| Group | Specs | Status | Basis |
|---|---|---|---|
| Fixed-name specs, test-only namespace (`DAII_TEST_DB_NS`) | 7 (`memberships-mine`, `company-membership-provisioning`, `database-provisioning.service`, `company-datasource-factory-impact`, `company-datasource-registry-isolation`, `restore-manager-audit-chain`, `company-migration-runner`) | **PASS 7/7** (`run-logs/regression-4.log`, commit `a314e18`); only database names changed, admin statements are exact `CREATE/DROP DATABASE` |
| Product-named databases / child processes, reviewed individually | 6: `installation-bootstrap`, `company-fanout`, `company-database-pool.multi-process` | **PASS 3/3** after a test-only namespace (the multi-process pool names had no `daii_test_` prefix; `company-fanout` also moved its fixture folders from the OS temp directory into the project root; the child workers inherit the namespace and are covered by the guard's process hooks) — `run-logs/regression-5b.log`; one earlier failure of the multi-process spec did not reproduce in 4 reruns (cause not established, `regression-5.log`) |
| | `company-database-allocation.http`, `company-registry.controller.database-creation`, `company-database-pool.full-flow` | **BLOCKED** | need `CREATE ROLE` / `GRANT` / `DROP ROLE` (and `CREATE DATABASE … OWNER`) and the product allocator names databases `company_<uuid>` (refused by the guard); least-privilege assessment: the test role is deliberately not CREATEROLE — **not expanded**. Exact statements and options: `NARROW-GUARD-DECISIONS-FOR-REMAINING-SPECS-2026-10-11.md` |
| Specs using `pg_terminate_backend` (shared helper pinned to port 5544) | 6 (`module-add-existing-company`, `new-company-default-administrator`, `provisioning-lifecycle`, `ui-created-company-admin`, `limits-scope`, `release-migration-registry`) | **BLOCKED** | the guard refuses the statement as issued (it must filter on `datname` AND `application_name` and exclude the caller); the catalogue `LIKE` statements are already allowed (read-only SELECT, verified against the real policy). A narrower alternative exists (`DROP DATABASE … WITH (FORCE)`, already allowed) but changes a shared test helper and its 5544 safety assertion: **not applied — awaits a documented guard decision** |
| Held | `company-audit-access.real-pg.spec.ts` | **NOT RUN** (untouched, other track) |
| Remaining mock/unit | `area6…`, `permission-path…`, `company-connection-manager.service`, `release-execution-environment-check` | PASS 4/4 (`regression-3.log`) |
Cumulative: PASS 90 (16 + 60 + 4 + 7 + 3), BLOCKED 9 (6 + 3), NOT RUN 1.

## 4. F-INV-001 / D-9
**BLOCKED — external dependency.** Documented Q1–Q4 queries, scope (every Company database, all history and last 90 days) and interpretation rules: `F-INV-001-OPERATOR-EXECUTION-GUIDE-2026-10-11.md`, `F-INV-001-USAGE-MEASUREMENT-QUERIES-2026-10-10.md`; read-only collector `tools/ops/f-inv-001-usage-collect.js` (parallel track) was never run on a real database. Missing: a named authorised operator with read-only access. No external-usage inference from internal searches. The HTTP 410 change is **NOT APPROVED FOR RELEASE** and not deployed.

## 5. D-10 capacity and staging
T-16 (local, single process, shared 2-core machine) remains **NOT CLASSIFIED** — a measurement, not a target and not hosting evidence. Existing artefacts: `CAPACITY-WORKLOAD-ASSUMPTIONS-AND-PROPOSED-TARGETS-2026-10-10.md`, `CAPACITY-DECISION-BRIEF-FOR-CTO-2026-10-11.md` (decision D-03: targets gated), `STAGING-CAPACITY-PROFILE-2026-10-11.md`, `tools/testing/capacity-loadgen.js` (refuses hosts containing "prod", requires a named authoriser; mock smoke test only). **Prerequisites still unresolved:** approved targets and acceptance criteria; an authorised staging-like environment; a separate load-generator machine; the person authorised to approve the load; workload/duration/safety limits/monitoring/stop conditions to be signed (proposal in the brief and profile). No hosting or production system was contacted.

## 6. Dependency audit and updates
Findings preserved and unchanged: offline inventory `test-program/dependency-audit/` (908 packages, 22 deprecated, `buffers` licence undeclared, `jszip` dual MIT/GPL, own package UNLICENSED) and the parallel track's `npm audit` record `test-03/DEPENDENCY-AUDIT-D01-2026-10-11.md`. Security vulnerabilities, licence metadata, deprecated packages and proposed updates stay separate; **no package, lockfile or version was changed**; any update needs a scoped compatibility plan with verification evidence (not produced).

## 7. D-1 — TEST-03 identity
Recorded in `test-03/D-1-RESOLUTION-RECORD-2026-10-11.md`; the separation of responsibilities in this directive is adopted as the working rule: **TEST-03** = independent software forensics and engineering due diligence (not a financial valuation or universal certification); **Team 2** = implementation and verification; **Team 3** = independent product audit and roadmap input. Not reopened.

## 8. Release decision
**NOT APPROVED.** N-01 local closure does not close N-02, unblock F-INV-001, approve capacity targets, establish hosting readiness or imply multi-instance verification. No acceptance criterion was changed and no guard weakened; results from different commits are reported per commit, never merged into an implied single run.

## 9. Closure criteria — satisfied / outstanding
| Workstream | Satisfied | Outstanding |
|---|---|---|
| N-01 | local closure (reviewer, `b5dcece`) | multi-instance, broader call-site coverage |
| N-02 (`fulfillReservation`) | fix + T-21 PASS + regression (see N-02 report §5) | independent review; F-AUD-003 decision; other N-02 findings |
| Guard / blocked tests | 7/7 + 3/3 adapted and PASS; classification of the rest | CREATEROLE least-privilege assessment (3); guard decision for the helper statement (6) |
| F-INV-001 | tooling and guide ready | operator and read-only access, evidence review, release decision |
| D-10 | assumptions, brief, profile, load generator | approvals and an authorised environment |
| Dependencies | audit and inventory preserved | scoped update plan |
