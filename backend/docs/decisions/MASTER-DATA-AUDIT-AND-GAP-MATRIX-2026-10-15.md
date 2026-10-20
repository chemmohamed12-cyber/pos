# Master data (items, customers, suppliers) — gap matrix and proposed model, for approval (2026-10-15)

> **Status:** audit complete. **No code or schema change has been made for this scope.** Nothing here is implemented until approved.
> **Base:** `5e41647` + uncommitted F11 working tree + uncommitted Item Details page. F11 files and the F11 verification worktree are not touched.

**Classification used for every change:**

| Tag | Meaning |
|---|---|
| **R** | reuse existing functionality |
| **U** | UI/API work without a schema change |
| **S** | schema change, explicit approval needed |
| **D** | deferred, not needed for the initial release |

---

## 1. Item master

### 1.1 Existing (`commerce/products`)
| Field / function | Validation today | Used by |
|---|---|---|
| `sku` | required, **unique** (DB index), server-assigned for New Item Requests | every document line (by `productId`), Excel import/export, picker search |
| `name` | required (`MinLength`) | everywhere |
| `unitPrice` | numeric string ≥ 0 | sales price fallback (after price list / rep / manager overrides) |
| `unit` | free text ≤ 32, display only | inventory grid, item page |
| `status` draft → active ↔ discontinued | transition table | D7 + F11 eligibility: PR/PO/RFQ/GRN gates, sales |
| Writes | `POST /products`, `/:id/name`, `/:id/unit`, `/:id/price`, `/:id/status` (`sales.catalog.create/edit`); import | — |
| Warehouse assignment | `warehouse_items` (D1), advisory | inventory grid scope |

### 1.2 Missing, and the proposed treatment
| Reference field | Proposal | Class | Validation | Dependencies |
|---|---|---|---|---|
| Item type | `itemType` enum, default `finished_good` | **S** | one of the approved values (§9 D-MD2) | BOM tab visibility; `service` = no stock: blocked from warehouse transactions, GRN and work orders |
| Category | `product_categories` table + `categoryId` | **S** | must exist and be active; code unique per company | filters, reports; no posting effect |
| Default warehouse | `defaultWarehouseId` | **S** | must be an existing, active warehouse **assigned** to the item (D1) | pre-selection on PR/PO/GRN/transactions (UI default only, never forced) |
| Reorder level | `reorderLevel numeric(18,3)` | **S** | ≥ 0, base units | "below reorder" flag on the inventory grid and item page (read-only signal; no automatic PR) |
| Description | `description text` | **S** | ≤ 2000 | display |
| Base unit | keep `unit` label | **R** | existing | — (no conversions; §2, §9 D-MD3) |
| Edit form on the item page | one form that calls the existing endpoints + one new `POST /products/:id/update` for the new fields | **U** (+ endpoint) | server-side as above | — |

---

## 2. Units and barcodes

| Item | Proposal | Class |
|---|---|---|
| Barcode records | `product_barcodes(productId, barcode, isPrimary, packLabel?, createdAt)`, **many per item**, **unique per company**, a barcode may not equal any SKU | **S** |
| Lookup | `GET /products/lookup?code=` → SKU **or** barcode → product snapshot (same contract as `getProductSnapshot`) | **U** |
| Scan field | in the PR / PO / warehouse-transaction line pickers (a keyboard-wedge scanner types and presses Enter) | **U** |
| Unit-of-measure engine (purchase/pack units, conversions) | not built: every quantity in the system is in base units, and the stock ledger is integer (§3) | **D** |
| Pack quantity on a barcode (scan carton = 12 units) | depends on the UoM engine | **D** |

---

## 3. BOM

**Today:**
- **One store** (commerce `BomService`, tables `bill_of_materials` / `bom_components`), exposed through two facades:
  - Catalog `/bom` (`sales.catalog.edit`);
  - `/manufacturing/boms` (`manufacturing.bom.*`, active/inactive status).
- Assembly and work orders read the same store.
- Component `quantityPerUnit` is `INT ≥ 1`, with no component unit.

**Why integer quantities are consistent today:**
- The stock ledger is integer: `stock_movements.quantity INT`, and the reservation, warehouse-transaction and sales-order quantities are integer too.
- Work-order quantities are also integer (`quantityPlanned`, `quantityRequired`, `quantityIssued`). The work-order output costing **asserts** exact integer consumption (`work-order.service.ts:590`).
- A fractional BOM would have no ledger to post into.

**Implications:**
- A recipe like "0.25 kg per lamp" cannot be expressed in kg.
- A component cannot be consumed in a unit different from its own base unit.

**Smallest safe change: none for the initial release.**
- Define such components in a base unit small enough to be integer, for example grams instead of kg. This works today with zero code change and keeps costing exact.
- True fractional or multi-unit recipes require a decimal stock ledger, decimal work-order quantities and UoM conversions. That is a cross-domain change, deferred to its own project (**D**, §9 D-MD5).

**Item page BOM tab:**
- Reuse `/manufacturing/boms` for view, create, replace and status (**R + U**).
- The tab appears for `finished_good` / `semi_finished`, or whenever a BOM already exists.
- No second BOM implementation.

---

## 4. Inventory accounting and costing

| Item | Proposal | Class |
|---|---|---|
| GL accounts | company-wide control accounts by function (`inventory`, `grni`, `ap`, `ar`, …) stay as they are; the item page shows the accounts that apply, read-only | **R** |
| Per-item / per-category GL mapping | not introduced | — |
| Cost | moving average per (item, warehouse) from `GET /inventory/valuation/current-cost` (`inventory.valuation.view`); no cost computed in the UI | **R** |
| Price | base price (existing endpoint) and the price lists that contain the item (existing price-list endpoints) | **R + U** |

---

## 5. Customer / supplier

### 5.1 Comparison
| Capability | Customer (CRM, `sales` module) | Supplier (procurement) |
|---|---|---|
| Company / individual | — | ✅ `supplierType` |
| Legal / trading name | name only | ✅ |
| Tax, VAT, CR numbers | — | ✅ |
| Phone / email / website | phone, whatsapp | via contacts |
| Language | — | — |
| Multiple addresses | one free-text line + governorate | ✅ `supplier_addresses` |
| Contact persons | — | ✅ `supplier_contacts` |
| Bank accounts | — | ✅ (approval-gated) |
| Tags / classification | one `classification` string | — |
| Internal notes | CRM notes (`disinterestNotes`) | — |
| Responsible person | ✅ sales-rep assignment | — |
| Commercial terms | price list, workflow policy, credit limit, payment terms, account type | payment terms, credit limit |
| General profile update | **no** (single-field endpoints only) | ✅ |
| Documents and ledger | sales orders, invoices, payments, AR ledger, aging, credits (shown on `CustomerAccount`) | PO, GRN, supplier invoices, payments, AP ledger, statement |

### 5.2 Shared party model?
**Not justified now.**
- Each entity is referenced by about 10 transactional and ledger tables across 8 domains, with separate modules and permissions (sales vs procurement).
- A shared party table would rewrite every document and ledger foreign key. That is broad, high-risk, and only cosmetic for the user.

**Recommended:**
- Keep the two models.
- Build **one shared profile layout** in the frontend (header with logo area, info grid, tabs, reusable contacts/addresses components) used by both screens, each over its own API (**U**).
- If one partner must be both a customer and a supplier, add an optional informational link later (**D**, §9 D-MD1).

### 5.3 Proposed profile changes
| Change | Class |
|---|---|
| Customer: `partyType`, `legalName`, `taxRegistrationNumber`, `vatRegistrationNumber`, `commercialRegistrationNumber`, `email`, `website`, `language`, `internalNotes` (all nullable) | **S** |
| Customer: `customer_addresses`, `customer_contacts`, same shape as the supplier tables + `isBilling` / `isShipping` | **S** |
| Customer: general `POST /customers/:id/update` (`sales.customer.edit`); financial fields stay on `financial-settings` (`sales.customer_financial.edit`) | **U** |
| Supplier: `email`, `website`, `language`, `internalNotes` (nullable) | **S** |
| Supplier profile "purchases" tab: POs / GRNs / invoices **queried by `supplierId`**, never copied | **U** (add a `supplierId` filter to the list endpoints) |
| Tags (both) | **D** in phase 1; the customer `classification` stays (**R**) |
| Supplier responsible buyer | **D** |
| Address chosen on sales orders / shipments | **D** (sales-order schema change, §9 D-MD7) |

---

## 6. Images and uploads

The existing `foundation/media` mechanism:
- allows images and documents behind an allow-list with magic-byte checks;
- stores files on the local filesystem (`MEDIA_STORAGE_PATH`);
- keeps metadata in the **installation (control-plane) database, not per Company**;
- serves a download **only to the uploader or an admin** (an interim rule until ADR-031 scope derivation).

**Not suitable as-is** for item or party images:
- a catalog image must be visible to every user allowed to view the item;
- assets must belong to the Company.

| Option | Class |
|---|---|
| Phase 1: reserved image area + placeholder (already on the item page); no upload | **R** |
| Later: Company-scoped media (asset row in the Company DB, storage key prefixed by Company) and a read rule derived from the owning record's permission, then `imageAssetId` on product, customer and supplier | **D** (security-reviewed change, §9 D-MD8) |

---

## 7. API and permissions per tab

All the permission nodes below already exist; **no new node is needed.**

| Tab | Endpoints (R = existing, N = new) | Permission |
|---|---|---|
| Item: basic | R `GET /products/:id`, `/:id/name`, `/:id/unit`, `/:id/status`; N `POST /products/:id/update`; N `GET/POST /product-categories` | `sales.catalog.view/edit`; categories `sales.catalog.edit` |
| Item: units & barcodes | N `GET/POST/DELETE /products/:id/barcodes`, N `GET /products/lookup` | edit `sales.catalog.edit`; lookup any authenticated Company user (same as `/products/all`) |
| Item: balances / movements | R (already on the item page) | inventory read + F6 warehouse scope |
| Item: accounting & pricing | R `/:id/price`, R price lists, R `current-cost`, R accounting policy read | `sales.catalog.edit`, `sales.price_list.view`, `inventory.valuation.view`, `accounting.ledger.view` |
| Item: BOM | R `/manufacturing/boms/*` | `manufacturing.bom.view/create/edit/delete` |
| Customer: profile | R `GET /customers/:id`; N `POST /customers/:id/update`; N contacts/addresses | `sales.customer.view/edit` |
| Customer: commercial / financial | R workflow-policy, price-list, financial-settings, status, assign | existing nodes |
| Customer: sales & accounting | R invoices, payments, ledger, aging, credits | existing |
| Supplier: profile, contacts, addresses, bank | R `/procurement/suppliers/*` | `procurement.supplier.*` |
| Supplier: purchases | R list endpoints + N `supplierId` filter | existing view nodes |

Server rules for every write:
- validation and uniqueness;
- referenced records must exist in the same Company;
- writes inside one transaction, with an audit record;
- authorization through `PermissionGuard` (independent of the UI).

Concurrent edits: last write wins on scalar fields, which is the existing convention. Unique constraints (SKU, barcode, category code) are enforced by the DB, and a violation returns a controlled 409.

---

## 8. Migrations and backward compatibility

The full list of necessary schema changes, all **additive**:

| # | Migration (tag) | Change | Compatibility |
|---|---|---|---|
| M1 | sales | `product_categories` | new table |
| M2 | sales | `products` + `itemType` (NOT NULL default `finished_good`), `categoryId`, `defaultWarehouseId`, `reorderLevel`, `description` (nullable) | existing rows get the defaults; every existing endpoint and DTO is unchanged; Excel columns are optional additions |
| M3 | sales | `product_barcodes` + unique index | new table |
| M4 | sales | `customers` + 9 nullable columns | existing reads unchanged |
| M5 | sales | `customer_addresses`, `customer_contacts` | the legacy `address` / `governorate` stay and remain the value shown until the user adds addresses (no backfill needed, §9 D-MD6) |
| M6 | procurement | `suppliers` + 4 nullable columns | unchanged contracts |
| M7 | core | terminology labels | data only; existing labels never overwritten (same check as `1790014000000`) |

All migrations:
- have a reversible `down`;
- are registered for Company fan-out in the release engine;
- run on disposable DBs in the specs;
- come with no destructive change and no data rewrite.

---

## 9. Owner decisions

| # | Decision | Recommendation |
|---|---|---|
| D-MD1 | Shared party model | No; shared UI layout; optional customer↔supplier link deferred |
| D-MD2 | Item type values | `finished_good`, `semi_finished`, `raw_material`, `consumable`, `service` |
| D-MD3 | Units of measure | base-unit label only in phase 1; UoM engine deferred |
| D-MD4 | Per-item / category GL | not introduced |
| D-MD5 | Fractional / multi-unit BOM | deferred; use small integer base units |
| D-MD6 | Legacy customer address | keep as is; no backfill |
| D-MD7 | Address on sales documents | deferred |
| D-MD8 | Images | deferred until Company-scoped media is approved |
| D-MD9 | Tags | deferred; keep `classification` |
| D-MD10 | Supplier responsible buyer | deferred |
| D-MD11 | Barcode uniqueness | unique per Company across all items; no pack conversion |

**Separate finding, not fixed and outside this scope:**
- PO/GRN line quantities are `numeric(18,3)` and nothing rejects a fraction, while the stock ledger is `INT`.
- A fractional receipt would reach the integer ledger; the behaviour is **unverified** (likely a database error).
- Recommend a real-PG spec and an integer check on PR/PO/GRN quantities as a separate small fix.

---

## 10. Acceptance tests (practical, per phase)

| Area | Real-PG spec (disposable DBs) | Browser workflow |
|---|---|---|
| Item basic | create → read; update type/category/default warehouse/reorder/description; invalid category / unassigned warehouse / negative reorder → 4xx; duplicate SKU → 409; viewer edit → denied (404 per `PermissionGuard`); Company isolation | create → save → reopen → edit → reopen shows the change; viewer sees no edit controls |
| Categories | create, duplicate code → 409, inactive category refused on items | pick a category on the item |
| Barcodes | add 2 barcodes to one item; duplicate in the same Company → 409, same barcode in another Company allowed; barcode = an existing SKU → 409; lookup by SKU and by barcode; lookup of a discontinued item from PO create → refused (F11 gate) | scan (type + Enter) in the PO line picker adds the right item |
| BOM tab | define, replace and deactivate via the manufacturing facade; Catalog `/bom` shows the same data (one store) | edit the BOM on the item page, then confirm on the Manufacturing BOM screen |
| Accounting tab | read-only: cost equals `current-cost`; no new write path | values shown match the valuation endpoint |
| Customer profile | update new fields; contacts/addresses CRUD; invalid email → 400; financial fields still only via `financial-settings`; existing sales-order / invoice flows unchanged | create → save → reopen → edit; contacts added and shown |
| Supplier profile | new fields; purchases tab lists exactly that supplier's POs / GRNs / invoices (filter spec) | open a supplier → purchases tab |
| Regression | focused list (products, BOM, manufacturing, procurement, customers, supplier, inventory specs) + CI gate | — |

---

## 11. Recommended sequence (each step reviewed before the next)
1. **Approve** §8 M1–M3 and D-MD2/D-MD3/D-MD5/D-MD11.
   - Then implement the **item master**: categories, type, default warehouse, reorder level, description, the editable item form, and the BOM tab on the existing facade.
2. **Barcodes:** table, lookup, and scanning in the PR/PO/warehouse pickers.
3. **Approve** M4–M6 and D-MD1/D-MD6.
   - Then implement the **customer profile** (fields, contacts, addresses, general update) on the shared profile layout.
4. **Supplier parity:** new fields, purchases tab, the shared layout.
5. **Deferred list** reviewed separately: images, UoM, fractional BOM, tags, address on documents, party link.

**Working rules:**
- Implementation runs in its own git worktree, so this checkout and the F11 worktree are never changed under a running test.
- Real-PG runs only when no F11 run is active.
- No Production deployment.
