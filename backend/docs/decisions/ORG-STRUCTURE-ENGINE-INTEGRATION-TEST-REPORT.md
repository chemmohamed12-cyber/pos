# Org Structure Engine — Integration Test Report (release line 1.1.13)

**Tested commit:** `81191b65456629bfc3cac64f6d21dee4d36da0da` — branch `integration/org-final-on-1.1.13` (candidate `a4e0daf` + WP-A + WP-C merged onto release line `3a4c811`). Clean tree during every run.
**Date:** 2026-10-26. **Evidence:** `docs/decisions/evidence-2026-10-26-org-integration-81191b6/` (file numbers below).
**Rules kept:** no guard setting changed, no guard test edited, no test edited to pass, no merge / release / package / deployment / push, no production access. All databases were disposable (cluster 5546, `daii_test_biz_tNN_*`) and were dropped.

## Verdict: **NOT READY FOR MERGE**
Reasons (details in §7): (1) four guard unit tests fail on this tree because of the CTO-approved 5544 guard entry and need a CTO decision; (2) there is no single clean full-regression run (138/140, the 2 failures pass alone); (3) the D-A event-contract sign-off is still open; (4) browser acceptance on the integrated build was partial.

## 1. Results
| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | Build, tsc, lint (backend + frontend) | exit 0 each | recorded in the previous turn, tree clean |
| 2 | Release-migration-registry spec (21 tests) on the approved runner (5546) | **21/21 PASS**, exit 0 | 01 |
| 2b | Same spec on 5544 (earlier attempt) | 21/21 failed — **configuration mismatch, not a code defect**: the release line moved this spec to the 5546 cluster (`daii_test_biz_t85_h3reg_*`, commit `ff8b8ce`), which the 5544 guard entry does not allow; the guard correctly refused. Superseded by #2. | 01b |
| 3 | Full regression, 140 specs, `biz-run.js --regression regression-specs-all.txt`, ns `biz_t91_` | runner exit **1**: **138/140 PASS**; ≈975 tests passed, 0 failed test cases, 1 skipped (sum of per-spec "Tests:" lines) | 02 |
| 3b | The 2 failed specs re-run alone, ns `biz_t92_` | **both PASS** (3/3 tests each), exit 0 | 02b |
| 4 | Migration up/down/up (§3) | schema fingerprints match; see §3 | 03 |
| 5 | DB-guard denial matrix (§4) | probe 7/7; unit 45/50 (5 failures explained) | 04, 04b, 04c |
| 6 | Browser acceptance (§5) | PASS for what was run; partial | 05 |

### Failure analysis — full regression (#3)
Failed specs: `foundation/company/company-database-pool.multi-process.real-pg.spec.ts` and `foundation/release/restore-manager-audit-chain.real-pg.spec.ts`. In both, **all 3 tests passed** and the suite failed in `afterAll` (`DROP DATABASE … WITH (FORCE)` → `permission denied to terminate process`). Neither file nor any code they exercise is changed by this work (`git diff 3a4c811 HEAD` touches none of them), they pass when run alone, and the same teardown-contention class was documented earlier on the candidate. This is classified as **test-infrastructure contention on the shared cluster**, not a product defect — but it is **not** a clean run and is listed as a blocker for the "clean full run" requirement until repeated in a quiet window.

## 2. WP-A / WP-C specs
Both new specs pass inside the full run: `procurement/interface/supplier-payment-branch.company-isolation.spec.ts`, `accounting/interface/work-order-branch.company-isolation.spec.ts`, and the decision guards `org-company-level-decisions.guard.spec.ts` (D-B, D-D company level). Earlier failures during development were my own wrong expectations (account code `acct-2101`; entry-level unit vs line COALESCE) and were fixed in the specs with the reason recorded, not to hide a code defect.

## 3. Migration up/down/up (disposable DBs on 5546, evidence 03)
- **A. Fresh DB, all migrations:** 329 applied; re-run applies 0; fingerprint `150bd6ba…` (1948 columns / 626 indexes / 1807 constraints).
- **B. Order test (real upgrade path):** DB brought to the release-line head with the 9 org migrations withheld (320 applied, fingerprint `9956420c…`), then the 9 org migrations applied as older-timestamp pending migrations → fingerprint **identical to A**.
- **C. Down:** with rows seeded in the new columns, `undoLastMigration` ×9 reverted exactly the 9 org migrations (WorkOrderBranch, SupplierPaymentOrgAttribution, OrgMigrationLog, Shipment/Fulfillment/Invoice/SalesOrder branch, VehicleOrgUnit, OrgUnitLifecycle). All org columns/table removed; business rows (org units, order, vehicle) intact. Schema after down equals the release head **except one documented item**: the `org_units` parent FK stays `ON DELETE RESTRICT` (down does not restore CASCADE).
- **D. Up again:** 9 applied, fingerprint **identical to A**.
- **Reversibility limits (unchanged):** the schema round-trips; **data does not**. The stamps (`branchOrgUnitId`, `orgUnitId`, `bankOrgUnitId`, `org_migration_log`) are lost on down (seen: sales-order and vehicle stamps NULL after the cycle) and archived units come back `active`. **Rollback = restore a backup**, not `down`.
- Note: the first run (03b) printed a wrong "undone" list because my script read the newest row by timestamp while TypeORM undoes by insertion order; the script was corrected (03c) and re-run (03). The schema results were the same in both runs.

## 4. Guard denial matrix (run through the approved runners only)
- `npm run test:db-guard:jest-probe`: **7/7 PASS** (04c).
- `npm run test:db-guard` (node --test): **45/50**. The 5 failures:
  - **#5, #14, #16, #46** — assert "exactly one approved entry" / "5544 blocked". They fail because `approved-test-databases.json` now carries the second entry `isolated-5544-h3reg`, which the CTO approved in chat on 2026-10-26 (loopback, `daii_test_h3reg_*` only). The release-line baseline `3a4c811` passes these four (04b). **They need a CTO decision** (update the tests' expectations as a reviewed, separate change, or remove the entry). I did not touch them.
  - **#36** (`tools/maintenance/company-migration-catchup.js` and `…-status.js` neither guarded nor classified) — **also fails on the clean release-line baseline `3a4c811`** (04b, same test, plus #1 which is an artefact of the git-less export), so it is pre-existing and not from this work.
- Real denials observed in this run: the guard refused `DROP DATABASE "daii_test_biz_t85_h3reg_…"` on 5544 (01b); the guard refuses non-`daii_test_biz_tNN` names on 5546 by design; access-denial behaviour for org scope is covered by the regression specs (`org-context.real-pg.spec` negative cases incl. department-only scope, warehouse/vehicle/shipment/org-report company-isolation specs) and by §5.

## 5. Browser acceptance on the integrated build (`81191b6` backend `dist` + Vite from the same tree; disposable `daii_test_biz_t94_orgi_cp/co`)
The browser pane was not displayed to a window, so UI controls were driven through the DOM; there are **no screenshots**.
- **API-level scenarios against the real backend, 14/14 PASS** (05): org tree creation; warehouses and vehicles created with an owning branch; warehouse with no branch refused when ≥2 branches ("Select the branch"); restricted user scoped to كتامه sees only own-branch warehouses/vehicles; other-branch vehicle overview → 404; create warehouse in another branch → 404; create without branch → own branch; org-unit creation and the organizational report → 404 for the restricted user; admin report 200; archiving a branch with attached warehouses/vehicles → 409.
- **UI (admin):** login; `/organization` tree shows root «ضى» + 2 branches with Edit/Archive/Assign; `/organization/report` renders per-branch columns (warehouses 3/2/unassigned, total 5, zero rows for the rest); `/warehouses` shows the owning-branch import selector, the import button **disabled** until a branch is chosen, branch selector on the create form; after choosing كتامه a real `.xlsx` (3 rows incl. one duplicate) delivered to the file input → 4 rows reported, duplicate rejected with its reason, `XL-1`/`XL-2` created and **read back owned by كتامه** from the database.
- **Not covered here:** restricted-user screens in the UI, the vehicles screen, supplier-payment / work-order flows through the UI (WP-A and WP-C are backend-only and are covered by the real-PostgreSQL specs, §2), mobile widths, screenshots. Sidebar shows untranslated `NAV_GROUP.*` keys in this disposable environment because terminology lives in the platform database that the bootstrap does not seed (environment artefact, not a product finding).

## 6. Data and decisions (unchanged by this run)
Alpha: all 13 warehouses → كتامه and the backfill (10 rows, checksums equal) were applied on `daii_dev` earlier on the owner's explicit approval (candidate evidence 28/29/30/31). Decisions D-A…D-E are recorded as approved by the owner (2026-10-26); D-B/D-D are guarded by regression tests.

## 7. Open items that block "READY FOR MERGE"
1. **Guard unit tests (4 failures)** caused by the approved 5544 entry — CTO decision needed (§4).
2. **No clean full-regression run** — repeat in a quiet window (shared cluster) to obtain 140/140 in one run; the 2 flaky teardown specs pass alone.
3. **D-A** payload change (`payloadVersion 2`, `allocations`, `bankOrgUnitId`) — event-contract sign-off still to be confirmed at the WP-A design review.
4. **Browser acceptance** only partial (§5) — restricted-user UI and vehicles screen to be added if the CTO wants them as a gate.
5. Open from the candidate: D-C component cross-branch / inter-branch settlement (out of scope), Alpha's one vehicle has no branch, `FINAL-REPORT` / `DECISION-REGISTER` / `CANDIDATE-REGISTER` still need their integrated-commit update and manifest regeneration, and the release-line merge itself needs separate authorization.

## 8. Rollback plan
Before any real rollout: take a backup of the platform and every company database. Rollback = restore that backup. `down` migrations are schema-only and lose all stamps (§3); never use them as the data rollback.
