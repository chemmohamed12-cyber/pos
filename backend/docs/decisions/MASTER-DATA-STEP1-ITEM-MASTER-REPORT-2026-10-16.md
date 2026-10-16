# Master data step 1 — item master: implementation report (2026-10-16)

> **Scope (approved 2026-10-15):** migrations M1–M3 and decisions D-MD2, D-MD3, D-MD5, D-MD11 (`MASTER-DATA-AUDIT-AND-GAP-MATRIX-2026-10-15.md`).
> **Where:** git worktree `.claude/worktrees/master-data-item`, branch `feature/master-data-item`, based on `5e41647` plus the uncommitted Item Details page. **Not committed, not pushed, not deployed.**
> **Isolation from F11:** no F11 file was touched. Real-PG runs started only after the F11 session and the cash-flow session released 127.0.0.1:5546.
> **Evidence:** `evidence-2026-10-16-item-master/`, containing screenshots, API authorization and validation results, and the spec log.

## 1. What now works

| Area | Behaviour | Class |
|---|---|---|
| Item type | `finished_good` / `semi_finished` / `raw_material` / `consumable` / `service`; existing items default to `finished_good`; the DB has a CHECK constraint | S (M2) |
| Category | `product_categories` (code unique per Company, optional parent, active/inactive, no cycles); assigning requires an active category; created inline from the item form | S (M1) |
| Default warehouse | chosen among the item's D1-assigned warehouses; **owned by the Inventory domain** (must exist, be active and be assigned); unassigning the item from that warehouse clears it | S (M2) |
| Reorder level | ≥ 0, up to 3 decimals, base unit (no conversion — D-MD3); the item header shows "reached reorder level" when available stock ≤ reorder level | S (M2) |
| Description | up to 2000 characters | S (M2) |
| Edit form | one form on the item page; name and unit go through the existing routes, the new fields through `POST /products/:id/update`, the default warehouse through the Inventory route | U |
| Barcodes | many per item; first is primary, primary can move; unique per Company; never equal to any SKU (both directions); `packLabel` is information only; scanner-friendly input (type + Enter) | S (M3) + U |
| Lookup | `GET /products/lookup?code=`: exact SKU first, then exact barcode; 404 when unknown | U |
| BOM tab | edits the **single** BOM store through the Manufacturing facade (`manufacturing.bom.*`); read-only users see it through the Catalog facade (`/bom`); shown for finished/semi-finished items or any item that already has a BOM; integer quantities ≥ 1 enforced by the API (D-MD5) | R + U |
| Costing & pricing | unchanged: base price, price lists link, moving-average cost per warehouse | R |

## 2. Architecture decision taken during implementation
- The approved model put `defaultWarehouseId` on `products`, and the column is there.
- **The rule is owned by the Inventory domain**, not by Commerce. Commerce cannot import Inventory, because Inventory already depends on Commerce, so the dependency would become a cycle.
- `InventoryService.setDefaultWarehouse` validates the warehouse and the D1 assignment, then writes the value through two new methods on the published `SalesProductsContract`: `setDefaultWarehouse` and `clearDefaultWarehouseIfMatches`.
- No cross-domain table write was added.

## 3. Changed files

**Backend: new files**

| File | Purpose |
|---|---|
| `database/migrations/sales/1790015000000-CreateProductCategories.ts` | M1 |
| `database/migrations/sales/1790015100000-AddProductMasterFields.ts` | M2 |
| `database/migrations/sales/1790015200000-CreateProductBarcodes.ts` | M3 |
| `database/migrations/core/1790015300000-SeedItemMasterTerminology.ts` | 21 labels, all new codes |
| `domains/commerce/domain/item-type.ts` | the item type values |
| `domains/commerce/infrastructure/product-category.entity.ts` | category entity |
| `domains/commerce/infrastructure/product-barcode.entity.ts` | barcode entity |
| `domains/commerce/application/product-master-data.service.ts` | categories, item fields, barcodes, lookup |
| `domains/commerce/interface/product-categories.controller.ts` | category endpoints |
| `domains/commerce/interface/product-master-data.company-isolation.spec.ts` | the new real-PG spec |

**Backend: changed files**

| File | Change |
|---|---|
| `domains/commerce/infrastructure/product.entity.ts` | 5 columns |
| `domains/commerce/application/products.service.ts` | the SKU ≠ barcode guard on create; the two contract methods |
| `domains/commerce/interface/products.controller.ts` | `lookup`, `:id/update`, `:id/barcodes`, `:id/barcodes/:barcodeId/remove` |
| `domains/commerce/commerce.module.ts`, `commerce-company-entities.ts` | wiring |
| `foundation/module-registry/contracts/sales.contract.ts` | 2 contract methods |
| `domains/inventory-warehouse/application/inventory.service.ts` | `setDefaultWarehouse`; `unassignItem` clears a matching default |
| `domains/inventory-warehouse/interface/inventory.controller.ts` | `POST /inventory/items/:productId/default-warehouse` |
| `domains/inventory-warehouse/interface/warehouse-item-assignment.company-isolation.spec.ts` | **setup only**: passes the real products service, because `unassignItem` now calls the contract; assertions unchanged |
| `tools/testing/regression-specs-all.txt` | the new spec registered |

**Frontend**

| File | Change |
|---|---|
| `pages/warehouse/item/ItemBasicPanel.tsx` | **new**: view and edit form |
| `pages/warehouse/item/ItemBarcodesPanel.tsx` | **new** |
| `pages/warehouse/item/ItemBomPanel.tsx` | **new** |
| `pages/warehouse/item/itemMaster.ts` | **new**: shared constants, types and label lists |
| `pages/warehouse/ItemDetails.tsx` | panels wired in; header shows type, category and the reorder signal; BOM tab visibility |
| `styles/ui.css` | form styles |

**Carried over from the Item Details work** (it is the base of this branch): `App.tsx`, `Inventory.tsx`, `ItemDetails.tsx`, `core/1790014000000-SeedItemDetailsTerminology.ts`.

**New routes:**

| Route | Permission |
|---|---|
| `GET /product-categories` | authenticated Company user |
| `POST /product-categories`, `/:id/update`, `/:id/status` | `sales.catalog.edit` |
| `POST /products/:id/update` | `sales.catalog.edit` |
| `GET /products/:id/barcodes` | authenticated Company user |
| `POST /products/:id/barcodes`, `/:id/barcodes/:barcodeId/remove` | `sales.catalog.edit` |
| `GET /products/lookup` | authenticated Company user |
| `POST /inventory/items/:productId/default-warehouse` | `inventory.warehouse.edit`, warehouse scope via `@WarehouseScoped({ body: 'warehouseId' })` |

**No new permission node. No existing route or response shape changed**: products gain 5 additive fields.

## 4. Verification
| Check | Result |
|---|---|
| New real-PG spec `product-master-data.company-isolation` (6 tests: DB constraints, categories, item fields, default warehouse, barcodes, lookup, Company isolation) | **6/6 PASS** (`new-spec-run.log`) |
| Focused real-PG regression, 31 specs: every regression-list spec using products, BOM, inventory, manufacturing or the lifecycle gate, plus scope and permission acceptance | **PASS 36/36** (§4a) |
| Backend build / lint / structure / unit / db-guard (worktree) | PASS; lint 0 errors / 5 warnings, unit 60 suites / 436 tests, db-guard 50/50 — all equal to the baseline (the unit suite includes the warehouse-scope route-coverage spec, which covers the new inventory route) |
| Frontend `tsc -b` / build / lint | PASS / PASS / 0 errors, 56 warnings, none in the new files |
| Every label key used by the page | seeded (checked against all migrations) |

**Browser** (real backend from the worktree `dist`, worktree Vite, disposable DBs `daii_test_biz_t97_ui_*`; both dropped afterwards):

| Workflow | Result |
|---|---|
| Inventory grid → item | Opens with type "finished good", the two assigned warehouses, and empty category / reorder / description |
| Edit → new category inline (`LAMPS-LED`) → type, default warehouse WH-FG (the list offers only the assigned warehouses, never the inactive one), reorder 150, description → Save | Saved; "Item saved"; the header shows the category and "reached reorder level (150)", since available is 120 |
| **Reload page (reopen)** | Every value is read back from the database |
| Barcodes: type + Enter for `6287000142915`, then `16287000142912` with pack label "كرتونة 12 قطعة" | Both added; the first is primary |
| Duplicate barcode / an item code (`CMP-LED-9W`) as barcode | Refused with a visible message; no row added |
| Lookup (browser session) | Carton barcode → LB-000142 (`barcode`); `CMP-LED-9W` → itself (`sku`); unknown → 404 |
| BOM: new → 2 components → quantity 1.5 | Refused ("must be an integer number"), nothing saved |
| BOM: quantity 2 → save | Saved, active |
| BOM: one store | The Catalog `/bom` and the Manufacturing list show the same BOM; deactivate and reactivate work |
| Item set to `raw_material` with no BOM | BOM tab hidden; `?tab=bom` falls back to basic |
| Viewer (`inventory.viewer` only) | Reads the item, barcodes, lookup and categories (200). **No** edit button, barcode form, remove buttons or BOM actions. API writes are refused (`update`, add barcode, create category, default warehouse, BOM status → 404, the existing `PermissionGuard` convention) |
| Validation via API | Inactive or unassigned warehouse → 409; non-UUID → 400; unknown type → 400; negative reorder → 400; duplicate category → 409; short barcode → 400 |

## 5. Limits and follow-ups
- **Step 2 is not done:** barcode scanning inside the PR, PO and warehouse-transaction line pickers, and default-warehouse pre-selection on those documents.
- **The item type is informational.** No rule yet blocks stock or work orders for `service` items. That is a later, separately approved rule.
- **Saving the form is several calls** (name, unit, master fields, default warehouse). Each call is atomic on its own, but the form as a whole is not. If one step fails, the page reloads and shows what *was* saved, plus the error.
- **No image** (D-MD8: Company-scoped media first).
- **No UoM conversions** (D-MD3).
- **Fractional BOM quantities** remain deferred (D-MD5).
- **Raw labels in the disposable environment only:** in the core-only test control plane, labels seeded by other tags (`mfg.*`, `nav_group.*`, `field.unit_cost`) render as raw keys. A full install runs every tag.
- **Error messages from the server are in English**, as everywhere else in the API.
- **Tooling:**
  - A local `backend/.env` was copied into the worktree. It is git-ignored and is needed to run `dist/main.js`.
  - `md-backend` / `md-frontend` entries were added to `.claude/launch.json` (developer tooling).

## 4a. Verification after integration onto `integration/local-2026-10-16` (907d47c)
- Item master step 1 was re-applied onto the integration branch (Item Details, Cash Flow, F11, warehouse column). `ItemDetails.tsx` extends the committed component: **all six tabs and the Edit button stay as committed**. `ui.css` keeps both rule sets. `App.tsx` and `Inventory.tsx` are identical to the integration branch.
- DB-free gates: backend build + lint 0 errors; frontend build + lint 0 errors; `test:unit` 60 suites / 436 tests; `test:db-guard` 50/50.
- **Focused real-PG regression on 127.0.0.1:5546:** 36 / 36 specs PASS, 237 tests passed, 0 failed, 1 skipped (`evidence-2026-10-16-item-master/focused-regression.log`, list in `focused-regression-list.txt`).
- **Coexistence with the customer and supplier profiles** (throwaway merge with integration 682701d, since removed): 7 / 7 specs PASS, 47 tests (`coexistence-with-profiles.log`). The merge was clean; only `regression-specs-all.txt` auto-merged.
- Not re-run here: the browser acceptance of this step (recorded on the earlier base, screenshots 01-05). It is repeated on the integration preview after the merge.

