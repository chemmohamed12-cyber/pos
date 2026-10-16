# DAII local release candidate — release pack (2026-10-16)

Companion to `LOCAL-RC-2026-10-16.md` (the integration session's manifest). This pack adds: an independent check of its checksum, build-output hashes, release notes, a per-migration rollback table with data consequences, and the limitations that matter for a later hosting release. **Local only. Nothing is deployed. `master` is unchanged.**

## 1. Identity
| Item | Value |
|---|---|
| Branch / commit verified | `integration/local-2026-10-16` @ `00455ce` |
| Source archive (`git archive --format=tar 66c6647`) SHA-256 | `27d8430cafa508b05a75c027bb1427b6da2fe71e3ec7f660c1efefe37be633f4` — **recomputed here, identical** |
| Frontend build output (`frontend/dist`, 5 files, `.map` excluded) manifest SHA-256 | `d3e6dc77bb0dbbcd01cad5c422c1845d46497c12bd9b6acd6b527bb2fc856301` (per-file list: `evidence-2026-10-16-rc-pack/frontend-dist.sha256`) |
| Backend build output (`backend/dist`, 2003 files) manifest SHA-256 | `73938cc4ed6faca367fd4fc37ce03042d1ebdc41934818014f33d70b740db4b2` (per-file list: `evidence-2026-10-16-rc-pack/backend-dist.sha256`) |
| Reproducibility | both builds were run twice from the same tree; the per-file hashes were **identical** both times |
| Version label in `package.json` | `1.1.9` — **unchanged**; see §6 |

A "manifest SHA-256" is the SHA-256 of the sorted `sha256sum` listing of the build directory, so any changed file changes it.

## 2. Release notes (what a user sees)
- **Trial balance:** the footer totals equal the sum of the rows shown; the report also exposes gross totals.
- **Purchase Orders / Requests:** a missing or discontinued item is refused with a clear 409 naming the line, before anything is saved (a `draft` item is still allowed on a Purchase Request).
- **Movement report:** a date-only "to" date now covers the whole day.
- **Cash Flow:** missing or malformed `from` / `to` is answered with 400 `VALIDATION_ERROR` instead of a 500.
- **Products:** a warehouse column shows each item's assigned warehouses and can be edited with the item.
- **Item Details** (`/inventory/items/:id`, opened from the Inventory grid): six tabs (basic data, warehouse balances, movements, units and barcodes, costing, BOM); the closing balance reconciles with the grid.
- **Item master:** item type, category, default warehouse, reorder level (with a warning when stock reaches it), description, several barcodes per item (one primary, unique per company, never equal to a SKU), editable BOM panel.
- **Scan or type an item code:** in the Purchase Request, Purchase Order, warehouse form, Inventory filter and BOM pickers, Enter resolves an exact SKU or barcode. Name search and clicking an item still work. Enter in that field no longer submits the surrounding form.
- **Customer profile and Supplier profile:** legal and tax identity, e-mail, website, language, notes, address book and contact persons (customer); e-mail, website, language, notes, contacts and addresses, purchases tab (supplier).

## 3. Verification (what was run, on which commit)
| Gate | Result | By |
|---|---|---|
| Frontend build / lint | PASS / 0 errors, 58 warnings (baseline 56) | this pack, @ 00455ce |
| Backend build / lint | PASS / 0 errors, 5 warnings (baseline) | this pack |
| Unit (`test:unit`) | 60 suites / 436 tests PASS | this pack |
| DB guard (`test:db-guard`) | 50 / 50 PASS | this pack |
| Isolation regression, real Postgres on 5546 | 101 / 102 PASS; the one non-pass is `release-migration-registry` (BLOCKED at baseline) | integration session, @ 3f28070 + test-wiring fix |
| Business suite T-00..T-31, real Postgres | all requested steps passed, exit 0 (after the T-19 stub fix) | integration session |
| Item master step 1 focused regression | 36 / 36 specs, 237 passed / 0 failed / 1 skipped | md-step1, @ 94a4030 |
| Item master + customer / supplier coexistence | 7 / 7 specs, 47 tests | md-step1 |
| Browser, :5173 on `daii_dev` | Products column, Item Details (six tabs), trial-balance footer, PR 409, Cash Flow 400 | this session (on the preview before the profiles) and the integration session (profiles, pickers) |

**Not re-run in this pack:** the 102-spec isolation regression and the business suite. The integration session ran them on this same code; this pack re-ran only the DB-free gates and the checksums. `00455ce` differs from the regression's commit (`3f28070` + `0a91b54`) by documentation commits only.

## 4. Migrations (all additive; list in `evidence-2026-10-16-rc/migrations.txt`)
| Tag | Migration | `up` | `down` | Data lost if `down` is run |
|---|---|---|---|---|
| core | 1790014000000 SeedItemDetailsTerminology | 43 labels | deletes exactly those | none (labels) |
| sales | 1790015000000 CreateProductCategories | table `product_categories` | drops the table | **all categories** |
| sales | 1790015100000 AddProductMasterFields | `products`: itemType (default `finished_good`), categoryId, defaultWarehouseId, reorderLevel, description, 2 CHECKs, 1 index | drops them | **item type, category, default warehouse, reorder level, description of every item** |
| sales | 1790015200000 CreateProductBarcodes | table `product_barcodes` | drops the table | **all barcodes** |
| core | 1790015300000 SeedItemMasterTerminology | labels | deletes exactly those | none |
| core | 1790015400000 SeedBarcodeLookupTerminology | 2 labels | deletes exactly those | none |
| sales | 1790016000000 AddCustomerProfileFields | 9 nullable columns on `customers`, 2 CHECKs | drops them | **profile data of every customer** |
| sales | 1790016100000 CreateCustomerAddressesAndContacts | tables `customer_addresses`, `customer_contacts` | drops them | **all addresses and contacts** |
| core | 1790016200000 SeedProfileTerminology | labels | deletes exactly those | none |
| procurement | 1790016300000 AddSupplierProfileFields | 4 nullable columns on `suppliers`, 1 CHECK | drops them | **e-mail, website, language, notes of every supplier** |
| core | 1790016400000 SeedSupplierProfileTerminology | labels | deletes exactly those | none |

**Applying:** through the release engine / `devdb-upgrade.js` for the platform and every Company database, as for earlier releases. Dry run first. `1790015xxx` were authored after `1790016xxx` had been applied on `daii_dev`, and TypeORM accepted the out-of-order run; a clean database applies them in timestamp order.

**Idempotence:** the `up` of 1790016000000, 1790016100000 and 1790016300000 uses plain `ADD COLUMN` / `CREATE TABLE` (no `IF NOT EXISTS`). They must be run once by the migration runner, never by hand twice.

## 5. Rollback
1. **Preferred — roll back the application, keep the schema.** Every schema change is additive and nullable (or defaulted), so the previous build runs unchanged on the new schema (no existing column, table or contract changed). This loses no data.
2. **Roll back the schema only if the new data may be discarded** (the "Data lost" column is permanent). Order: stop the new application; back up; run `down` in reverse timestamp order — 1790016400000, 1790016300000, 1790016200000, 1790016100000, 1790016000000, then 1790015400000, 1790015300000, 1790015200000, 1790015100000, 1790015000000, then 1790014000000. `1790015100000` must come before `1790015000000` because `products.categoryId` references `product_categories`.
3. Take a database backup before applying in any environment that holds real data. `daii_dev` is experimental and was upgraded without one on the owner's instruction.

## 6. Limitations and conditions
- **No release version.** `package.json` is `1.1.9`, the protected, already-released identity, and the handover record states that v1.1.10 was not eligible. This candidate must **not** be packaged or deployed under 1.1.9. A version, a hosting package and the hosting release gate are a separate, owner-approved step.
- **F11-TZ (target-host check) is deferred:** run `SHOW timezone;` on the target database before release; the movement `dateTo` day boundary follows the session time zone. Local clusters run `Africa/Cairo` and the boundary specs pass there.
- Known residuals from the integration session: RFQ-award dead-letter retry; no `verify:repo` script; the supplier profile has no goods-receipt-by-supplier list; the contact and address UI offers add, set primary and remove only (no edit in place).
- `release-migration-registry` is BLOCKED at baseline (1 of 102 isolation specs).
- Browser acceptance covers Products, Item Details, trial balance, PR 409, Cash Flow 400, the barcode pickers on the Purchase Request and warehouse receipt screens, and the customer and supplier profile screens. **Not clicked through in this session:** the Purchase Order screen, the Inventory filter and the BOM picker with a barcode (the integration session took those browser checks; its result is not recorded here), and an end-to-end receipt → transfer → issue run on the integrated build.
- Frontend lint warnings are 58 versus 56 at baseline (no errors).
- `master` was not touched; `daii-backend` on :3501 (master's working tree) was left as it was.

## 7. Update after integration (added by the integration session)

- The pack's gates were run on 00455ce. The final candidate is a later commit; the authoritative identity, source checksum (content-based, replaces the tar checksum of 66c6647), frontend lint (56 warnings = baseline after commit 8eebf41) and test totals are in `LOCAL-RC-2026-10-16.md`. Rebuild the dist hashes above if the dist artifacts are to be handed over: the frontend source changed only by two lint-suppression comments.
- The browser checks listed as not clicked through in section 6 were completed on the committed integration preview: Purchase Order picker, Inventory filter and BOM picker with a barcode and an SKU, unknown code, manual selection, duplicate barcode (409). 12/12 PASS: `evidence-2026-10-16-rc/browser-verification-rc.md`. The end-to-end receipt, transfer and issue run on the integrated build remains not done in the browser (covered by the business suite T-00..T-31).
