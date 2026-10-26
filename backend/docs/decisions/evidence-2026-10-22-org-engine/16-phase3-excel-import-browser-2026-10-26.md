# Phase 3 — Warehouse Excel import, browser acceptance (2026-10-26)

**Tested code:** commit `2d4eb06675b5c9495643c04d8a34aee9ba185e88` (clean tree; backend `dist` built from it; frontend served by Vite from the same worktree).
**Environment:** disposable databases `daii_test_biz_t95_org_cp/co` on cluster 5546 (dropped afterwards), real backend `node dist/main.js` :3621, real Vite :5621, Arabic UI. Seed: root «ضى», branches كتامه / طنطا, warehouses WH-K (كتامه), WH-T (طنطا), WH-OLD (unassigned). Users: fixture admin; restricted `branch.user@example.test` (roles `inventory.manager` + `logistics.manager`, org membership = كتامه only).
**Method:** the real page controls were driven through the DOM (the pane is not displayed to a window): the branch `<select>`, and the real `.xlsx` delivered to the real file input of the `ExcelImportExport` component, so the URL the component builds (`?orgUnitId=`) is what is tested. Fixture workbooks were generated with `exceljs` (valid, wrong headers, header only, blank name, existing code, non-Excel bytes).

## Admin
| # | Case | Observed | Verdict |
|---|---|---|---|
| A | No branch selected | import button **disabled** with the message "اختر الفرع المالك للمخازن المستوردة أولاً"; file forced in anyway (what a direct call would do) → server answers **"Select the branch. / يجب اختيار الفرع."**; warehouse count 3 → 3 | PASS — selection is mandatory in UI **and** server |
| B | Branch كتامه selected, file with 3 rows (`XL-1`, `XL-2`, duplicate `XL-1`) | button enabled; 3 total / **2 succeeded** / 1 rejected ("Duplicate Warehouse Code XL-1 within this file"); `XL-1` and `XL-2` both owned by **كتامه** (read back through the API) | PASS |
| C | Wrong header names | "Missing required column Warehouse Code / Warehouse Name"; nothing created (count unchanged) | PASS |
| D | Header only | 0 / 0 / 0; nothing created | PASS |
| E | One row with blank name + one valid | 2 total / 1 succeeded / 1 rejected ("Warehouse Name is required."); the rejected row created nothing, the valid row is owned by كتامه | PASS (import is per-row by design: valid rows commit, rejected rows are reported and leave no record) |
| F | Code that already exists (`WH-K`) | rejected "already exists"; `WH-K` keeps its branch كتامه | PASS |
| G | A file that is not an Excel workbook | generic error "An unexpected error occurred."; nothing created | PASS for data safety; **UX limitation**: the message is not specific (pre-existing `ExcelService` behaviour, not changed) |

## Restricted user (scope = كتامه) — warehouse list shows only WH-K, WH-OLD (unassigned) and the rows already imported into كتامه; WH-T is hidden
| # | Case | Observed | Verdict |
|---|---|---|---|
| R1 | Branch **طنطا** (outside scope) selected, valid file | server answers **"Not Found"** (404, anti-enumeration); `XL-R1` **not created** | PASS |
| R2 | Branch **كتامه** selected, same file | 1 / 1 / 0; `XL-R1` owned by كتامه | PASS |

Also covered by specs rather than the browser: a user who reaches exactly one branch and sends no `orgUnitId` gets that branch (`warehouse-branch.real-pg.spec`, `org-context.real-pg.spec`).

## Conclusion
Branch selection is mandatory, rows are attributed to the chosen branch, out-of-scope branches are refused without side effects, and malformed input never produces unexpected records. One non-blocking UX limitation (G).
