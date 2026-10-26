# Browser acceptance — Final Verification Gate (2026-10-26)

Environment: disposable databases `daii_test_biz_t95_org_cp/co` on cluster 5546 (dropped afterwards), real backend `node dist/main.js` (:3621) built from `edc2d7a` + the Warehouses import wiring, real Vite frontend (:5621) from the same worktree, Arabic UI, fixture admin `bv.admin@example.test` and a **restricted** user `branch.user@example.test` (roles `inventory.manager` + `logistics.manager`, org membership on branch «كتامه» only). Seed: root «ضى», branches كتامه / طنطا, warehouses WH-K (كتامه), WH-T (طنطا), WH-OLD (unassigned), vehicles V-K, V-T, V-LEG (legacy text only), a product with stock in each warehouse.
The built-in browser pane was not displayed to a window, so interaction was done by driving the real page controls through the DOM (inputs, selects, buttons, file input with a real `.xlsx`) and reading the rendered result; no screenshots exist for this run.

## Finding fixed during acceptance
**Defect:** the Warehouses Excel import sent no branch, so in a Company with ≥2 branches the import would always have been refused ("Select the branch") with no way to choose one in the UI. **Fix:** an owning-branch selector next to the import buttons; the import button is disabled (with the reason) until a branch is chosen; the selected branch is sent as `?orgUnitId=`. `ExcelImportExport` gained two optional props (`importBlockedReason`, `children`), other callers unchanged.

## Excel warehouse import with branch assignment — PASS
- Import button disabled with tooltip/message "اختر الفرع المالك للمخازن المستوردة أولاً" while no branch is selected.
- Selecting «طنطا» enables it; the real template `.xlsx` is delivered to the real file input: summary 1 total / 1 succeeded / 0 rejected; warehouse `WH-01` appears and `GET /inventory/warehouses` shows its owning branch = طنطا.
- Restricted user (scope = كتامه): import with `orgUnitId` = طنطا → **404**.

## Restricted-user views and branch-scope enforcement — PASS
| Check (user scoped to كتامه) | Result |
|---|---|
| warehouses listed | WH-K and WH-OLD (unassigned) only — WH-T and WH-01 hidden |
| vehicles listed | V-K and V-LEG (unassigned) only — V-T hidden |
| status / overview / edit of the real V-T by id | 404 / 404 / 404 |
| create warehouse naming branch طنطا | 404 |
| create warehouse with no branch | 201, branch automatically = كتامه (single reachable branch) |
| create vehicle naming طنطا / with no branch | 404 / 201 with branch كتامه |
| create an org unit (no manage permission) | 404 |
| organizational report (no `accounting.report.view`) | 404 |
| Organization screen | tree readable, **no** Edit / Archive buttons, no create form |

## Organization tree editing, archive / reactivation — PASS (admin)
- Create department «قسم المبيعات» under كتامه through the form → appears indented under the branch.
- Rename to a name already used by a sibling → refused with the duplicate-sibling message (state unchanged).
- Archive a department → impact dialog (0 sub-units, 0 members/grants) → confirm → hidden; "عرض المؤرشف" shows it as «مؤرشف»; Reactivate → «فعّال».
- Archive branch كتامه → dialog lists "2 active sub-units, 3 warehouses, 1 treasury account, 2 vehicles attached", the confirm button is **disabled**.

## Vehicles — PASS
Branch selector lists only active branches; "إضافة سيارة" disabled until a branch is chosen; V-UI created with branch طنطا; the legacy vehicle V-LEG shows its old text plus an "unassigned — choose branch" selector.

## Warehouses — PASS
Create form: branch select is `required` (form invalid until chosen); WH-UI created with branch كتامه (verified via API).

## Organizational report — PASS
Real orders created through the API from each warehouse: كتامه 1 order / 50, طنطا 1 / 50, **Unassigned 1 / 50** (order from the unassigned warehouse, branch left `NULL`, no default), company-level row 0, totals 3 / 150, note "المجاميع مطابقة لمصادرها". Warehouses column 3 / 2 / 1.

## Not covered
Screenshots (pane hidden); the cost-centre table in the browser (covered by `org-report.real-pg.spec`); mobile widths.
