# Release notes — changes queued for the release after 1.1.10 (2026-10-19)

**Status: committed on branches, not merged, not packaged.** The 1.1.10 package (`RELEASE-1.1.10-PACKAGE-2026-10-16.md`) and `package.json` (1.1.10) were **not touched**. The next version number and the package are a separate, owner-approved release step.

## 1. Changes (owner requests of 2026-10-19)

### 1.1 Purchase Order screen — `feature/po-picker-hotfix` @ `eef92a1` (frontend only)
- The item picker offers **only the items assigned to the chosen warehouse** (`GET /inventory/warehouse-items`); if that call fails it falls back to all items. Changing the warehouse clears the search box.
- An item **already on the order is removed from the picker list**. Typing or scanning its exact code still resolves it and shows the duplicate warning (`ProductCombobox` gains an optional `excludedIds` prop that hides items from the list only; default behaviour of every other screen is unchanged).
- The line is added by the **picked item's id**, not by looking its name up. Before this, two items sharing a name (different codes) could not both be added: the second was silently taken as the first.
- A **code column** (`field.code`) before the product, in the draft table and in the order-detail table.
- No backend, migration or database change. The existing label `error.product_already_on_transaction` is reused; its wording says "movement" (حركة), not "purchase order" — a PO-specific label would need a terminology migration (not added).

### 1.2 One item, one code — `feature/item-name-guard` @ `7b42c88` (backend only)
- Registering an item whose **name already belongs to another item, under any code**, is refused (HTTP 409) with a bilingual message naming the existing code: «الصنف مضاف سابقاً: "…" بالكود "…"».
- Applies to every way an item is registered: the Products create form, the **Excel import** (the row is rejected, the other rows import) and the **New Item Request** draft product; also to **renaming** an item.
- Names are compared after trimming and collapsing spaces, case folding, unifying Arabic letter variants (أ إ آ → ا, ى → ي, ة → ه) and removing tashkeel / tatweel. A per-name advisory lock inside the transaction makes two simultaneous registrations of the same item resolve to exactly one winner.
- Movements and documents keep identifying an item **by its code (SKU)**. Several barcodes per item (master data step 1) are a separate, approved feature and are not affected.
- **No migration, no schema change, no unique index** (the existing data already contains repeated names, so a unique index could not be created). Existing items are not changed. Re-saving an unchanged name never fails because of a pre-existing duplicate.

## 2. Verification
| Check | Result |
|---|---|
| Frontend `tsc`, build, lint (PO branch) | PASS; lint 0 errors, 56 warnings (baseline 56) |
| Backend `tsc`, lint (guard branch) | PASS; lint 0 errors, 5 warnings (baseline) |
| New real-Postgres spec `product-name-uniqueness.company-isolation.spec.ts` (9 cases, Company A/B): create, spelling variants, import, New Item Request draft, rename, pre-existing duplicate, Company B independence, concurrent registration | **9 / 9 PASS** (added to `regression-specs-all.txt`) |
| Existing specs that register items: products, product-master-data, new-item-request, inventory-posting, manual-receipt, t0-clean-company-baseline | **6 / 6 specs PASS** (39 tests passed; the t0 baseline spec has 1 skipped test) |
| Browser, disposable environment on 5546 (`daii_test_biz_t97_po_*`, since dropped): PO picker per warehouse (4 items for the main warehouse, 1 for the other); items leave the picker when added; two same-name items both added; barcode scan adds the line; rescan by barcode or SKU warns; removing a line restores the item | PASS |
| Browser, same environment, Products create form: same name under a new code refused with the message; spelling variant refused; no rows created by the refusals; same code with a new name still refused by the code rule; a new distinct item is created | PASS |
| Live preview on :5173 (main checkout, uncommitted) | the PO-screen behaviours verified on daii_dev; this preview has no barcode scan code (it serves the main checkout, not the integration line) |

**Not run:** the full 111-spec cumulative regression and the business suite on these two branches (only the specs above). The integration session owns the final gate for the release.

## 3. Rollback
Frontend: revert `eef92a1`. Backend: revert `7b42c88`. Neither changes the database, so no data is lost and no migration order applies.

## 4. Known limits and decisions needed
- **Existing duplicates remain.** Real dev data already has items sharing a name under different codes (for example codes `1` and `1000` both named «بوردة 9 وات ابيض»). The rule only stops new ones. Merging or retiring the existing duplicates is a data decision for the owner (a movement history is attached to each code).
- The guard compares **names**. The same item written with a really different name is not detected; no similarity matching is attempted.
- The refusal text is returned by the API in English and Arabic in one string (it is not routed through the terminology registry).
- Not included: any version bump, package or deployment.
