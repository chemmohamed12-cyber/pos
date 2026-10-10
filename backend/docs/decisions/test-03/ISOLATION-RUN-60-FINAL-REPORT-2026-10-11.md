# Isolation run (60 specs) — final report, 2026-10-11

Scope: the remaining harness-based domain isolation specifications (list `tools/testing/regression-specs-2.txt`), run on the dedicated local cluster 127.0.0.1:5546 through the unchanged DB guard, with disposable databases `daii_test_biz_t90_<name>_*` (namespace `DAII_TEST_DB_NS=biz_t90_`, validated fail-closed). Command: `node tools/testing/biz-run.js --regression tools/testing/regression-specs-2.txt`. Evidence: `docs/decisions/evidence-2026-10-10-biz/run-logs/regression-2.log` (one jest process per spec, full output). Nothing shared was edited while the run was in progress (only new assessment files were added). The run was not stopped or restarted.

## 1. Result
| Item | Count |
|---|---|
| Specs in the list | 60 |
| Executed and **passed** | **59** (420 individual tests across the 60 files, all passed) |
| **Skipped by design** | **1** — `domains/accounting/interface/t0-clean-company-baseline.spec.ts` (jest reports "1 skipped"; the runner printed PASS because jest exits 0). It is an opt-in evidence-capture baseline (`T0_BASELINE=1`), not a regression assertion → **NOT RUN (opt-in)**, not counted as a pass |
| Failed | **0** |
| Environment / configuration / unresolved problems | 0 |
| Isolation defects confirmed | **0** |
The two specs that the guard refused in the previous round (`products_isolation`, `delivery_isolation`) were made runnable by a **test-only prefix rename** (`items_isolation`, `courier_isolation`); both passed. The guard, its approved entry and hard denials are unchanged.
Combined with the earlier 16-spec round (92 tests, all passed): **75 executed isolation/real-Postgres specs passed, 1 skipped, 0 failed.** The harness-based domain isolation suite is therefore verified for audit, treasury, payments, inventory, accounting, procurement, sales, returns, shipment, delivery, fulfillment, manufacturing, HR/attendance/payroll/commission/targets, CRM, commerce and reports.
**Caveat (stated, not hidden):** these specs prove tenant isolation of the paths they exercise; as the TEST-03 report shows, they did not exercise concurrency with a plain manager (finding N-01). "Isolation verified" means no cross-Company leakage was observed in the specified scenarios, not that every endpoint was probed.

## 2. Remaining specs with their own connection logic (33 listed earlier) — classification
| Class | Specs | Status |
|---|---|---|
| Unit mode (inside the 59-suite unit run) | `closing-snapshot.service`, `authorization-context`, `membership-role-provisioning` | **PASS** (unit run 59/59, 430 tests) |
| No database name of their own — executed 2026-10-11 (`regression-specs-3.txt`, `run-logs/regression-3.log`) | `company/area6-company-isolation.acceptance` (5), `company/permission-path-company-isolation.acceptance` (4), `database-registry/company-connection-manager.service` (8), `release/release-execution-environment-check` (9) | **PASS** (26 tests) |
| Adapted in the previous round and in the 76 | `audit/area14-company-audit`, `audit/audit-chain-concurrency` | **PASS** |
| Executed → **FAIL (configuration)** | `release/release-migration-registry.real-pg` — 21/21 tests refused by `assertIsolatedInstance()` in `foundation/testing/saas-characterization.helpers.ts`, which hard-codes `DB_PORT === 5544` (the superseded cluster); it also needs a prior `npm run build` (reads `dist/database/migrations`) | **BLOCKED — configuration**, not a product or isolation defect (the refusal is the helper's own safety check). Closing step: test-only change of the helper to accept the approved port (5546) via the existing guard, build `dist`, rerun |
| Blocked by the directive | `audit/company-audit-access.real-pg` (carries uncommitted edits by another track) | **NOT RUN** (do not modify) |
| Require a separate harness adaptation (INFERRED — fixed `daii_test_*` names, residue checks by prefix, default port 5433, provisioning code that creates databases with its own names, or child processes) | `company/company-database-allocation.http`, `company-database-pool.full-flow`, `company-database-pool.multi-process`, `company-membership-provisioning`, `company-registry.controller.database-creation`, `memberships-mine`; `database-provisioning/database-provisioning.service`, `module-add-existing-company.characterization`, `new-company-default-administrator.verification`, `provisioning-lifecycle.characterization`, `ui-created-company-admin.characterization`; `database-registry/company-datasource-factory-impact.characterization`, `company-datasource-registry-isolation`; `entitlement/installation-bootstrap.real-pg`; `limit-engine/limits-scope.characterization`; `release/company-fanout.real-pg`, `restore-manager-audit-chain.real-pg`; `release-orchestration/company-migration-runner` | **NOT RUN** (18 specs); several use the same 5544-pinned helper as the failing spec above |
| Program-built business tests | `biz-harness-smoke`, `t09`, `t12`, `t16` | **PASS** (business suite, see `FINAL-VERIFICATION-AND-RELEASE-READINESS-REPORT-2026-10-10.md`) |

## 3. Limits that prevent a stronger conclusion, and how to close them
| Limit | Closing step |
|---|---|
| 18 provisioning / pool / fan-out / restore / registry specs not run | Test-only adaptation: namespace their fixed names (as done for area14), let the 5544-pinned helper accept the approved port through the guard, build `dist` for the registry spec; then run with the same runner |
| `company-audit-access` spec not run | Run after the other track commits its edits |
| `t0-clean-company-baseline` skipped | CTO decision whether to capture the T0 baseline (`T0_BASELINE=1`) |
| Specs do not cover concurrency with plain managers or HTTP behaviour (N-01) | Add concurrent and HTTP-level specs for every primitive with a lock (TEST-03 roadmap R3) |
| Single-run evidence | Re-run nightly in CI on the dedicated cluster (roadmap R2) |
