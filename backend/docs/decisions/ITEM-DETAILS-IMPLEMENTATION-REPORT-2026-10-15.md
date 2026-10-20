# Item Details page and inventory click-through — implementation report (2026-10-15)

> **Status:** implemented and browser-verified. **Not committed, not deployed.** Submitted for review.
> **Base:** `5e41647`, plus the uncommitted F11 working tree (`F11_COMPLETION_REPORT.md`), which this page relies on for the movement-report `dateTo` fix.
> **Evidence:** `evidence-2026-10-15-item-details/`, containing screenshots, API authorization results, the migration round-trip and the test-data ledger.

## 1. What was built

| Requirement | Delivered |
|---|---|
| Click an inventory item to open its page | The **whole grid row** is clickable, and SKU and name are real links (keyboard, middle-click, new tab). The row's existing unassign "×" button does not trigger navigation. |
| Item header | Name, SKU, status badge, base unit, total on hand and available across visible warehouses, and a **reserved image area with a neutral placeholder** (SKU initials plus "no item image"). "Edit item" appears only with `sales.catalog.edit`. |
| A. Basic information | Code, name, status, base unit, assigned warehouses (the existing D1 assignment). Item type, category, default warehouse, reorder level, description and image are shown as **"not defined in the current data model"**, not invented. |
| C. Warehouse balances | One row per visible warehouse, from the Inventory grid's own endpoint, so the figures match the grid by construction. Columns: on hand, preliminary hold, reserved, available, last movement, and unit cost (only with valuation permission). Each total is the sum of its column. |
| D. Movements | Warehouse filter (defaults to the originating warehouse, or "all visible"), From/To dates, posting time, movement type, source document (resolved number with a link where a detail route exists), warehouse, in, out, **running balance**, opening balance (everything before From) and closing balance. A **reconciliation line** compares the closing balance with the warehouse balances when no To date is set. A note states that dates are ledger posting times (D-CR7). |
| E. Units and barcodes | The base unit label is shown. Barcodes: the model has none, so a clear "not supported yet — separate capability pending approval" note is shown. No single-barcode assumption is built in. |
| F. Costing and BOM | Base price, a link to price lists, unit cost per warehouse (permission-gated) and BOM components (each component links to its own item page) with a link to the BOM screen. Costing, pricing and BOM rules are untouched. |
| Navigation | `?warehouseId=` carries the originating warehouse, and "Back to inventory" returns to it. `?tab=` keeps the active section, so browser back and forward restore it. Following a BOM component remounts the page with no stale state. |
| Layout | Numbered section tabs following the reference ("1- Basic information … 6- Bill of materials"). The page uses the existing design system (`card`, `data-table`, `detail-grid`, buttons). RTL-safe logical CSS properties. Below 900px the header stacks and tabs wrap two per row. |

## 2. Changed files and routes

| File | Change |
|---|---|
| `frontend/src/pages/warehouse/ItemDetails.tsx` | **new**: the page and `ItemDetailsRoute` (remount per item) |
| `frontend/src/App.tsx` | route `inventory/items/:productId` |
| `frontend/src/pages/Inventory.tsx` | row click-through and SKU/name links carrying the warehouse; the "×" button stops propagation |
| `frontend/src/styles/ui.css` | `clickable-row`, `item-*` styles (header, image placeholder, tabs, filters, notes), and the tablet breakpoint |
| `backend/src/database/migrations/core/1790014000000-SeedItemDetailsTerminology.ts` | **new**: 43 terminology labels (see §3) |
| `.claude/launch.json` | local `cr-backend` / `cr-frontend` launch entries for the disposable browser environment (developer tooling only) |

**New route:** `/inventory/items/:productId?warehouseId=&tab=basic|balances|movements|units|costing|bom`.

## 3. API and schema changes

- **API: none.** The page only calls existing, already-authorized endpoints:

  | Data | Endpoint |
  |---|---|
  | Item | `GET /products/:id` |
  | Visible warehouses | `GET /inventory/warehouses` (F6-filtered) |
  | Per-warehouse balances | `GET /inventory/warehouses/:id/inventory` |
  | Movements | `GET /inventory/reports/movements`, with the CR-2026-10-15 date-only `dateTo` fix |
  | Document numbers | `GET /warehouse-transactions/:id` (warehouse-scoped) |
  | Unit cost | `GET /inventory/valuation/current-cost` (`inventory.valuation.view`) |
  | BOM | `GET /bom/:productId` |

  No calculation is duplicated in the backend. The running and opening balances are sums of the ledger rows the report returns; the opening balance is the same report up to the day before From.
- **Schema: none.**
- **Data migration (one):** `1790014000000-SeedItemDetailsTerminology` (core tag, control-plane `terminology_entries`).
  - **Why it's needed:** every UI label comes from the Terminology Registry, and the page needed 43 labels that did not exist. They cover section names, field names, notes, the four movement types and the six reference types.
  - **Safety checks:**
    - Every code was checked against all existing seeds first. The one collision (`field.closing_balance`) was removed, and the existing label is reused.
    - `ON CONFLICT` therefore never rewrites an existing label.
    - **Round-trip verified** on a disposable DB: `down` removes exactly 43 rows, `up` restores 43, and the other 932 rows are unchanged, with an identical content hash (`migration-roundtrip.json`).
    - It is applied by the real runner (`runMigrationsForDatabase`), and the latest migration became `1790014000000`.

## 4. Browser verification (real backend `dist/main.js` and Vite frontend, disposable DBs on the approved 5546 cluster)

Test data:
- An item with a two-component BOM.
- Opening stock of 100 in Raw, seeded the same way `bv-seed` does.
- Transfer **WH-TR-2026-000001** (30, Raw → Production) and issue **WH-OUT-2026-000001** (5, Raw). Both were created, approved and posted **through the real API** (`test-data-ledger.json`).

| Check | Result |
|---|---|
| Row click on the grid (a non-link cell) | Opens `/inventory/items/<id>?warehouseId=<Raw>` ✔ |
| SKU link from the Production grid | Opens with `warehouseId=<Production>`; "Back to inventory" returns to Production, still selected ✔ |
| "×" (unassign) in a row | Unassigns, no navigation ✔ |
| Header totals | On hand 95 = 65 + 30, available 95 ✔ |
| Warehouse balances | Raw 65, Production 30, total 95; ledger 100 − 30 + 30 − 5 = 95; no duplicated transfer quantity ✔ |
| Movements (Raw) | Opening 0 → 100 → 70 → 65; in 100, out 35; closing 65 = grid 65 (reconciled) ✔ |
| Movements (all visible) | 4 rows; the transfer appears as out (Raw) and in (Production); closing 95 = total 95 ✔ |
| From = To = today | 3 rows, opening 0, closing 65 (today included — the M-1 fix holds) ✔ |
| From = tomorrow | 0 rows, opening 65, closing 65 ✔ |
| To = yesterday | 0 rows, opening 0, closing 0 ✔ |
| Document link | WH-TR-2026-000001 → `/movement-center/<id>` shows the posted Raw → Production transfer; browser back restores the movements tab ✔ |
| BOM | 2 components; a component link opens that item (fresh state, 0 on hand); browser back restores the parent on its BOM tab ✔ |
| Units and barcodes, costing | Base unit "قطعة"; barcode note; base price 45.00 ✔ |
| Restricted user (`inventory.viewer` only) | Page readable, **no "Edit item"**, smaller sidebar ✔ |
| Tablet 768px | No horizontal page overflow; tabs 2 per row; header stacked ✔ |
| Console | Only expected 404s: `current-cost` "no_valuation_source" (SQL-seeded stock has no cost layer) and BOM lookups for components without a BOM. No unhandled errors. |

**Fixed during verification:** a long document number such as `WH-TR-2026-000001` wrapped onto two lines, so a click in the middle of the link's box landed between the line fragments and missed. Document numbers are now `white-space: nowrap`, and the click was re-tested successfully. Screenshot 04 was taken before this fix.

**API authorization** (`api-authorization-viewer.json`, viewer token):

| Endpoint | Result |
|---|---|
| Anonymous `GET /products/:id` | 401 |
| Product, warehouses, inventory, movements, BOM reads | 200 |
| `POST /products/:id/name` (edit) | **404** |
| `POST /warehouse-transactions` (create) | **404** |

The 404 on denial is the existing `PermissionGuard` design (it never answers 403). Unit cost is readable by this role because `inventory` read-only includes `inventory.valuation.view`; that is the existing permission model, not a change.

Screenshots (`evidence-2026-10-15-item-details/screenshots/`):
1. Inventory grid with links
2. Basic information
3. Warehouse balances
4. Movements
5. BOM
6. Viewer without "Edit item"
7. Tablet 768px

## 5. Regression and gates

| Gate | Result |
|---|---|
| Frontend `tsc -b` | PASS |
| Frontend lint (changed files) | 0 warnings, 0 errors |
| Frontend `npm run build` / `npm run lint` | PASS / 0 errors, 56 warnings (same total as before this change; **none in the changed files**) — `frontend-build.log`, `frontend-lint.log` |
| Backend CI gate `tools/ci/ci.sh` (install, build, lint, structure, doc-links, unit, db-guard) | **Overall PASS**; lint 0 errors / 5 warnings, unit 60 suites / 436 tests and db-guard 50/50 — all equal to the baseline (`ci-summary.md`) |
| Migration round-trip (up/down) on a disposable DB | PASS |
| Real-PG specs | No backend code changed except the data migration. The inventory, warehouse and movement-date specs cover unchanged endpoints and were last run green in F11 (32/32). The full isolation regression is being run by a separate session (`.claude/worktrees/f11-verify`) on the shared cluster; it was not re-run here, to avoid contending with that run. |
| `verify:repo` | **Does not exist** in this repository; the CI gate above is the repository's established check. |

## 6. Remaining limitations

- **Data-model gaps (shown honestly, not built):** item type, category, default warehouse (only D1 assignment exists), reorder level, description, product image and barcodes have no fields. Each needs its own approved data-model change. Product images have no upload or storage mechanism for products; the reserved image area is ready for one.
- **"Edit item"** opens the Products screen; that screen has no deep link to a single product.
- **Scale:**
  - Balances make one inventory-grid call per visible warehouse, searched by SKU with `pageSize` 200. A SKU that is a substring of more than 200 other SKUs could be missed.
  - The movements report has no paging, so a very high-volume item loads all rows in its window.
  - An additive `productId` filter or paging on the existing endpoints would be a small, separately approved API change.
- **Document links** exist for warehouse transactions, sales orders and work orders, the reference types with a detail route. Goods receipts, assemblies and returns show their type and a short id without a link.
- **Running-balance order** for movements with the same posting time is by id (stable but arbitrary). Per-warehouse closing balances are unaffected.
- **Dates are posting time** (D-CR7 policy); backdated document dates are not reflected.
- **Labels from non-core tags** (for example `field.category`, `field.unit_cost`) appear as raw keys in the core-only disposable control plane. A full install runs every tag on the control plane.
