# Inventory Lifecycle - C1 gate closure: consolidated evidence package (2026-10-18)

**Status: submitted for CTO review. C2 is NOT started and will not start without explicit authorisation.**
This package answers the CTO decision "C1 EVIDENCE CLOSURE REQUIRED". It supersedes the closing statements of `INVENTORY-LIFECYCLE-C1-EVIDENCE-REPORT-2026-10-17.md` where the two differ (see section 5, "Corrections to the earlier report").
Evidence folder: `backend/docs/decisions/evidence-2026-10-17-inventory-c1-closure/` (new) and `.../evidence-2026-10-17-inventory-c1/` (earlier run logs). Branch `feature/inventory-lifecycle`.

---

## 1. Change and migration inventory

### 1.1 Commits
| Commit | Content |
|---|---|
| `4399f90e6a748435d5adcc1bd0630c349b12f83b` | C1 implementation. 35 source/doc files (list below) plus 248 auto-generated business-suite evidence folders (`evidence-2026-10-10-biz/T-xx/...`, written by the suite runner; no source) |
| closure commit (this package) | documentation, one new spec, evidence logs only; **no production source change** after `4399f90` |

Changed files in `4399f90` (source and documentation):
- **Migrations (3):** `backend/src/database/migrations/inventory/1790017000000-AddValuationMovementBusinessDate.ts`, `.../accounting/1790017100000-AddInventoryReconciliationExplanation.ts`, `.../core/1790017200000-SeedInventoryC1Terminology.ts`
- **Backend accounting:** `accounting.module.ts`, `application/inventory-difference-analysis.ts` (new), `application/inventory-reconciliation.service.ts`, `application/ledger.service.ts`, `application/posting-status.service.ts` (new), `infrastructure/inventory-reconciliation-run.entity.ts`, `interface/general-ledger.controller.ts`, `interface/inventory-accounting.controller.ts`
- **Backend inventory-valuation:** `application/inventory-valuation.service.ts`, `application/moving-average-cost-engine.service.ts`, `domain/cost-engine.ts`, `infrastructure/inventory-valuation-movement.entity.ts`, `interface/inventory-valuation.controller.ts`, `inventory-valuation.module.ts`
- **Backend inventory-warehouse / foundation:** `application/warehouse-transactions.service.ts`, `interface/warehouse-transactions.controller.ts`, `foundation/module-registry/contracts/inventory-events.contract.ts`, `foundation/navigation/navigation-registry.ts`
- **Tests:** `inventory-lifecycle-c1.company-isolation.spec.ts`, `inventory-lifecycle-c1.migrations.company-isolation.spec.ts`; `tools/testing/regression-specs-all.txt` (+2 lines)
- **Frontend:** `App.tsx`, `components/RefreshStamp.tsx` (new), `lib/useAutoRefresh.ts` (new), `pages/accounting/{FinancialEvents,GeneralLedger,InventoryAccounting,TrialBalance}.tsx`, `pages/warehouse/{ValuationReport(new),WarehouseOverview}.tsx`
- **Docs:** C1 evidence report (2026-10-17), `inventory-lifecycle-gate-b/01-CTO-DECISIONS-2026-10-17.md`

Added by the closure commit: `inventory-lifecycle-c1.controlled-scenario.company-isolation.spec.ts` (+1 line in the regression list), this package, the closure evidence folder.

### 1.2 Differences between the commit and the main checkout serving :5173
The main checkout (`master` 5e41647 plus its uncommitted F11 / item-details / warehouse-column work) received the C1 patch **uncommitted** (deliberately not committed to `master`). Beyond the commit it also contains, to avoid regressing the running stack:
- the **cash-flow date validation** (`requireReportDateRange` + 2 calls in `general-ledger.controller.ts`), its spec `cash-flow-date-validation.company-isolation.spec.ts` and its line in `regression-specs-all.txt`, copied from the `dev-preview` worktree. These are NOT in `4399f90` (that branch is built on the integration branch, which already has them);
- a hand-merged import line in `general-ledger.controller.ts`.
A pre-change backup of every touched main-checkout file and of the full uncommitted diff was taken first (session scratchpad `main-backup-pre-c1`).

### 1.3 The three migrations (exact names, as recorded in the `migrations` tables)
1. `AddValuationMovementBusinessDate1790017000000` - `inventory_valuation_movements.businessDate` DATE NULL + index + UTC-date default; backfill from the UTC date of `createdAt` for NULL rows only.
2. `AddInventoryReconciliationExplanation1790017100000` - `accounting_inventory_reconciliation_runs.explainedBase`, `unexplainedBase` (NUMERIC(20,4) NULL), `basis` (CHECK `current|as_of`), `classification` (CHECK `matched|explained|unexplained`).
3. `SeedInventoryC1Terminology1790017200000` - 49 terminology rows, `ON CONFLICT DO NOTHING`.

### 1.4 Per-database status (read-only query, `evidence-2026-10-17-inventory-c1-closure/migration-status-daii-dev-read-only.json`)
Applied on 2026-10-17 with `devdb-upgrade.js`: dry run (`dev-dry.json`: exactly these 3 pending everywhere), `--apply`, then a second dry run showing **0 pending**.
| Database | Name | Recorded | C1 columns present |
|---|---|---|---|
| Platform | `daii_dev` | 3 / 3 | 5 / 5 |
| Alpha Trading Co | `company_f3ea8a2e75814dd4b3f708e606a434f9` | 3 / 3 | 5 / 5 |
| Beta Trading Co | `company_0894c2a717f34fceaf6a299530ccf61f` | 3 / 3 | 5 / 5 |
| Gamma Trading Co | `company_98d3391ce5464c63a3e9fab11e55263c` | 3 / 3 | 5 / 5 |
| Delta Trading Co | `company_dfa1105448b84ad8b8ae8d7bd8719353` | 3 / 3 | 5 / 5 |

### 1.5 Compatibility and rollback assessment
- **Backward compatibility:** every schema change is additive and nullable (or default-stamped); no existing column, status value or CHECK changed. New API routes are additive; `GET trial-balance` without `mode` returns the same key set (asserted by a golden test); `GET general-ledger` lines only gain fields; the run `status` vocabulary is unchanged. Old code running against a migrated database ignores the new columns; new code on a database WITHOUT the migrations fails on the new columns (same class as incident I-1) - hence the fan-out requirement below.
- **Rollback:** each migration has a tested `down()` (up/down/up and idempotent re-up verified on a real Company database, spec `...migrations.company-isolation.spec.ts`, 2/2). Effects of `down`: drops `businessDate` (the stamped dates are lost; nothing else depends on them in C1), drops the four reconciliation columns (values explained/unexplained are lost, the run rows and their `status` stay), deletes exactly the 49 terminology rows. `down()` was **not** run on `daii_dev`; the code rollback is reverting the commit / patch and restarting the backend. Rollback of the main-checkout patch is possible from the pre-change backup.
- **Release dependency (not performed):** any future release containing C1 requires the Company-database fan-out procedure and the owner's Stage-A check before the new endpoints are used; with fan-out off they would answer 500 on Company databases lacking the columns.

### 1.6 Production and hosting
**Not touched.** No hosting host, production database, production configuration or deployment was accessed or changed; the hosting-incident repair tools were not run or modified; the protected 1.1.9 artifact was not touched. The only databases written were: disposable `daii_test_biz_*` databases on the isolated test cluster 127.0.0.1:5546 (created and dropped by the test harness; two browser-verification databases `daii_test_biz_t97_c1_cp/_co` still exist there, disposable) and the local experimental `daii_dev` and its four Company databases on localhost:5433 (upgraded with the 3 migrations at the CTO's instruction of 2026-10-17, per the owner decision of 2026-10-15 that they are experimental).

---

## 2. Controlled functional verification

Spec: `backend/src/domains/accounting/interface/inventory-lifecycle-c1.controlled-scenario.company-isolation.spec.ts` (real PostgreSQL, Company A with Company B as untouched witness, disposable databases, **no shared or demo data, no manual edit of any balance** except two explicitly labelled fixtures below).
The pipeline under test is the real one: inventory entry point -> `stock_movements` + outbox (one transaction) -> event bus -> financial event -> costing handler (moving-average valuation) -> journal entry -> ledger read. Every expected value was computed by hand before the run (written in the spec header); nothing was tuned to output; **no tolerance** is applied anywhere.

Run: `node tools/testing/biz-run.js --regression <list containing the spec>` from `backend/`. Result: **8/8 tests, 40/40 recorded checks pass** (`controlled-scenario-run.log`, `controlled-scenario-results.json` with expected vs actual for every check).

| Step | Movement | Expected valuation | Expected GL 1120 | Actual (valuation / GL) | Result |
|---|---|---|---|---|---|
| S1+S2 | opening WH1/P1 10 @ 5.00; WH2/P2 4 @ 2.50 | 50.0000 + 10.0000 = 60.0000 | 60.00 | 60.0000 / 60.0000; reconciliation `matched`, drift 0.0000 | PASS |
| S3 | manual receipt WH1/P1 5 @ 8.00 | P1 15 u, value 90.0000, avg 6.0000 | 100.00 | same | PASS |
| S4 | adjustment WH1/P1 -3 at the average | P1 12 u, 72.0000; total 82.0000 | 82.00 | 82.0000 / 82.0000; `matched`, `matched`, 0.0000 | PASS |
| S5 | manual receipt WH2/P2 3 @ 3.00 | P2 7 u, 19.0000 | 91.00 | same | PASS |
| S6 | adjustment WH2/P2 -2 at the average (2 x 19/7 = 5.4286 valued, 5.43 posted) | P2 5 u, 13.5714; total 85.5714 | 85.57 | 85.5714 / 85.5700; difference **+0.0014** | PASS |

**Residual explained, not hidden (S6):** the +0.0014 is exactly the rounding of the one posting (5.43 posted vs 5.4286 valued). Result: run `status = drift_found` (the alarm is NOT suppressed), `classification = explained`, `explainedBase 0.0014`, `unexplainedBase 0.0000`, category `rounding` 0.0014 / 1 posting attributed to the issuing warehouse, the other three categories 0.0000; the recorded run carries the same facts with `basis = current`.

Further checks in the same scenario (all PASS):
- **Valuation report (service level, D):** by warehouse WH1 12 u / 72.0000, WH2 5 u / 13.5714; total 17 u / 85.5714; history consistency `[]`.
- **Valuation report HTTP controller (D2), same data:** default by item, `groupBy=warehouse`, filter by warehouse, filter by item, F6 scope (caller sees WH1 only: only WH1 valued and totalled; naming WH2 answers 404), invalid `asOf` / `groupBy` / `warehouseId` answer 400, `asOf` = today is the current basis.
- **As-of (E):** fixture: the opening valuation rows and their two journals are re-dated 10 days back (a UPDATE of dates in the disposable DB - the only manual change, labelled). As of day -5: valued positions 10 u / 50.0000 and 4 u / 10.0000, GL 60.0000, reconciliation `basis = as_of`, `matched` (then compared with then); as of day -11: nothing.
- **Negative control (F, fault injected on purpose, labelled):** a valuation-only receipt of +1.0000 with no event and no journal: difference 1.0014, explained 0.0014, **unexplained 1.0000, classification `unexplained`** - no tolerance hides it.
- **Isolation and integrity (G):** repeated flushes and reads create no journal; no unbalanced journal; Company B has zero rows in all seven inventory/accounting tables, answers `matched` / 0.0000 / no positions; the Platform DataSource was never requested for Company B (`assertDataSourceNeverRequestedFor`); Platform `event_outbox` has 0 rows.
- Earlier in the same program: `inventory-lifecycle-c1.company-isolation.spec.ts` 14/14 (REJECTED event, pending outbox, F07 entry, preview-persists-nothing fingerprints, periodic TB, posting status, cost KPI and F6, GL fields).

Limits of this evidence: it is at service and controller level on real PostgreSQL. A browser/HTTP run of the same populated dataset (valuation report page, reconciliation panel and GL columns with real numbers) is **NOT TESTED** (the isolated browser environment only holds seed stock without valuation/journals; the dev databases hold no inventory accounting data and must not be seeded).

---

## 3. C1 live-refresh evidence - two different environments

### 3.1 Environment A - ISOLATED test environment (this is where the transitions were verified)
Disposable databases `daii_test_biz_t97_c1_cp` / `daii_test_biz_t97_c1_co` on cluster 127.0.0.1:5546, created with `tools/testing/bv-bootstrap.ts` + `bv-seed.ts`; the C1 worktree backend (`dist/main.js`, port 3603) and its Vite (port 5603); the bootstrap test admin. Not `daii_dev`, not :5173.
Reproduction (helper saved as `live-refresh-outbox-probe.js`; it only inserts / updates / deletes ONE labelled `event_outbox` row in the disposable Company database; password from the environment variable `PW`, none is stored):
1. Open `/warehouse-overview` signed in; observe the chip "Postings up to date".
2. `node live-refresh-outbox-probe.js pending` (row `processing`) -> the open page, without reload, shows "Postings in progress (1 / 0)" (observed on first load of the page; tooltip "pending / rejected: 1 / 0").
3. `... failed` (row `failed`, attempts 5) -> within **17 s** the same open page shows "Postings need attention (0 / 1)" in the error colour.
4. `... clear` -> within **16 s** the chip is back to "Postings up to date".
Also observed: the "Updated hh:mm:ss" stamp, the manual refresh button; request-rate check showed no polling storm (about one overview request per interval, 3 in total during the check). Periodic TB toggle rendered opening/period/closing with three balance badges; the new menu entry and the valuation report page rendered. One defect was found by this step and fixed (valuation report crashed on `historyInconsistencies = null`).

### 3.2 Environment B - the primary preview http://localhost:5173 (what was and was NOT done)
Done (read-only, signed in as the owner's local admin, company Alpha, backend restarted with C1 on :3500):
- the overview shows the chip "Postings up to date", the "Updated" stamp, the cost KPI beside selling price (0.00 each: no stock valued in Alpha);
- the General Ledger, Trial Balance (periodic mode), Inventory Accounting, Financial Events and the valuation report pages load and show their empty states; the "Inventory valuation report" menu entry is present;
- API probes: `trial-balance?mode=periodic` 200 (three balance flags true), default trial balance 200 with the unchanged keys, `posting-status` 200 (`current`), `valuation/report` 200 (also `asOf` in the past: `basis as_of`), `financial-events` 200, `cash-flow` without dates 400 and with a year 200.
- `reconciliation-preview` answers **409** "No active `inventory` control account..." in Alpha (and, by the survey, in all four dev companies: none has an inventory control account, valuation rows or journals). The screen hides the preview panel in that case; the browser console shows the 409 on each refresh.
**NOT done on :5173 (not tested there):** posting-status **transitions** (pending -> attention -> current) and refresh behaviour under data change. Triggering them needs writes to the shared demo data, which the CTO forbade. Those transitions are evidenced only in environment A. Behaviour of the hook on tab focus / visibility, back-off after errors and discarding stale responses has no automated test and was **not** exercised.

---

## 4. Test exceptions (exact failure, scope, classification)

### 4.1 `area14-company-audit.real-pg.spec.ts` - classified **FAIL (intermittent)**
- Spec: `src/foundation/audit/area14-company-audit.real-pg.spec.ts`. Its 3 tests (Company A audit grant lands in A and Platform audit and not in B; `verifyCompanyChain` valid and detects corruption; Company B chain independent) **pass 3/3 in every run**.
- Failure: the **suite** fails after the tests, in its own teardown: `QueryFailedError: permission denied to terminate process` at `area14-company-audit.real-pg.spec.ts:60` (`DROP DATABASE IF EXISTS "<name>" WITH (FORCE)`, helper `dropDatabase`, called from the `afterAll` at line 133). The runner reports `RESULT FAIL`. This is **not** treated as a pass because the assertions passed first.
- Scope: test-infrastructure only (cleanup of its disposable databases); no product code path. Cause hypothesis (not proven): the cluster role used by the runner is refused `pg_terminate_backend` for a session it does not own when `FORCE` has to terminate one; the harness used by the other specs wraps its drop in a bounded retry, this spec does not.
- Frequency (logs in the evidence folder): C1 tree: failed in the full regression, in the immediate solo re-run and in 1 of 10 later runs (3 failures in 12 runs); the baseline integration tree **without C1**: 1 failure in 10 runs (`area14-interleaved-integration-6.log`, same message). Intermittent on both; C1 is not shown to cause it, and a higher rate under C1 load cannot be excluded from these counts.
- Owner: not modified by C1 closure; needs its own fix (use the bounded-retry drop helper).

### 4.2 `db-guard` test 36 - classified **FAIL (pre-existing)**
- Command `npm run test:db-guard` (backend): 50 tests, 49 pass, **1 fail**: `every database-capable tool is guarded or classified as an operator tool` (`tools/testing/db-guard.coverage.test.js:35`): actual
  `['tools/maintenance/company-migration-catchup.js: database-capable and neither guarded nor classified as an operator tool', 'tools/maintenance/company-migration-status.js: ...same...']` vs expected `[]`.
- Identical on the baseline integration tree (49/50), so it predates C1 (`db-guard-integration.log` vs `db-guard-inventory-lifecycle.log`). The two tools are the hosting-incident owner tools committed on `integration/local-2026-10-16` (962ecb6 and later); they were **not modified** by C1 closure. Classifying them as operator tools in the guard registry is a separate change.

### 4.3 `release-migration-registry.real-pg.spec.ts` - classified **BLOCKED**
It refuses to run unless the isolated instance on 127.0.0.1:5544 is used (message in `isolation-regression-run.log`); that instance was not available. It was **not run**, so no result is claimed (earlier reports called it a "baseline exception").

---

## 5. Final gate report

### 5.1 PASS
| Item | Command / source | Result | Evidence |
|---|---|---|---|
| C1 real-PG A/B spec | `node tools/testing/biz-run.js --regression <list>` | 14/14 | `evidence-2026-10-17-inventory-c1/c1-spec-run.log` |
| Controlled scenario (new) | same | 8/8 tests, 40/40 checks | `.../closure/controlled-scenario-run.log`, `controlled-scenario-results.json` |
| Migration up/down/up spec | same | 2/2 | `.../c1/c1-migration-spec-run.log` |
| Isolation regression (all registered real-PG specs, at `4399f90`) | same, whole list | 102/104 passed; the 2 others are 4.1 and 4.3 | `.../c1/isolation-regression-run.log` |
| Business suite T-00..T-31 incl. T-18 schema drift | `node tools/testing/biz-run.js` | all 29 steps PASS | `.../c1/business-suite-run.log` |
| Backend unit tests | `npm run test:unit` | 60 suites / 436 tests | `.../c1/unit-tests.log` |
| Backend build / `tsc --noEmit` / eslint | `npm run build`, `npx tsc --noEmit`, `npm run lint` | OK / clean / 0 errors (5 pre-existing warnings) | `.../c1/backend-lint.log` |
| Frontend typecheck / build / oxlint | `tsc -b`, `npm run build`, `oxlint` | OK / OK / 0 errors, 55 warnings (baseline 56) | session |
| Structure / doc-links | `npm run validate:structure`, `node tools/validation/check-doc-links.js` | PASS | session |
| Focused regression on the MAIN checkout after the patch | 10 specs (C1 x2, cash-flow, TB footer, inventory-posting, accounting, warehouse-item-assignment, movement dates, procurement eligibility, valuation) | 10/10 | session logs |
| Migrations applied to dev databases | `devdb-upgrade.js` dry run / apply / re-check | 3 applied on 5 DBs, 0 pending | `.../closure/migration-status-daii-dev-read-only.json` |
| Live refresh transitions | isolated environment A | pending -> attention (17 s) -> current (16 s) | section 3.1, `live-refresh-outbox-probe.js` |
| :5173 renders and answers | environment B | pages load, endpoints 200/400/409 as expected | section 3.2 |
| Company isolation | controlled scenario G, C1 spec test 14 | B untouched, Platform DS never requested | logs above |

### 5.2 FAIL
| Item | Detail |
|---|---|
| `area14-company-audit` suite | teardown `permission denied to terminate process`, intermittent (section 4.1) |
| `db-guard` test 36 | two owner tools unclassified, pre-existing (section 4.2) |

### 5.3 BLOCKED
| Item | Reason |
|---|---|
| `release-migration-registry.real-pg.spec.ts` | requires the isolated instance on port 5544 (section 4.3) |
| `bash tools/ci/ci.sh` as a single command | its first step `npm ci` would empty the shared `node_modules` junction of this worktree; every other CI step was run individually |

### 5.4 NOT TESTED
- Posting-status transitions and refresh-on-change on http://localhost:5173 (needs writes to shared demo data).
- A populated browser run (valuation report, reconciliation panel, GL source columns, periodic TB with real numbers) - no inventory-accounting data exists in dev and none may be seeded; covered at service/controller level only.
- Focus/visibility triggers, error back-off and stale-response discard of `useAutoRefresh` (no frontend test harness exists).
- A full re-run of the whole isolation regression after the closure commit's new spec (the new spec itself passes; no production source changed since `4399f90`).
- `down()` of the migrations on `daii_dev`.
- Behaviour with foreign-currency or manufacturing postings in the reconciliation attribution (they would stay `unexplained`, by design in C1).

### 5.5 Known limitations and regressions
1. **Regression found and fixed during the :5173 apply:** the main checkout's backend lacked the cash-flow date validation that the previously running backend had; after the first restart `reports/cash-flow` answered 500 without dates. Ported from the `dev-preview` tree, rebuilt, restarted, re-verified (400 / 200) and covered by its own spec in the focused regression.
2. **Deviation from ADR-INV-09:** an additive `classification` column instead of an `explained` run status (status vocabulary and CHECK untouched).
3. **Reconciliation preview on every refresh:** a set of SELECTs run each 30 s while the Inventory Accounting screen is visible; may need a summary/cache for very large histories (C2). In companies without an inventory control account the call answers 409 and is logged in the browser console each time.
4. **Valuation `businessDate` is a processing date** for history written before C1 (UTC date of `createdAt`) and a DB default (UTC today) afterwards; explicit business dates arrive in C2.
5. **Still open by design (not complete, carried forward in the approved sequence):** in-request posting dispatch (C2), business-date propagation (C2), receipt approval and separation of duties (C3), opening batch and its correction account (C4), F07 retirement of `physical_count_variance` (C6), rounding phase 2 (not approved).
6. **Commit noise:** `4399f90` includes 248 generated business-suite evidence folders; harmless, but it inflates the file count (283).
7. **No frontend automated tests** exist for C1 screens; verification was manual in the browser.
8. `:5173` runs C1 from **uncommitted** main-checkout files; a later `git checkout`/stash in that checkout would remove it (backup exists).

### 5.6 Corrections to the earlier report (2026-10-17)
- It called `area14` "its tests pass; teardown permission" and the registry spec a "known exception" inside "102/104"; they are now classified FAIL (intermittent) and BLOCKED respectively, and the scope of the area14 failure is documented above.
- It stated "Browser verification: PASS". Corrected: the transition behaviour was verified only on the isolated environment; on :5173 only rendering and read-only endpoints were verified.
- While building the controlled scenario, the evidence helper compared values with `JSON.stringify` and reported one check as false because of key order only (assertions had passed); it now uses deep equality (final run: 40/40). No product code was changed for this.

---
**Submitted for CTO review. Waiting for the CTO's decision on C1 closure; C2 not started.**
