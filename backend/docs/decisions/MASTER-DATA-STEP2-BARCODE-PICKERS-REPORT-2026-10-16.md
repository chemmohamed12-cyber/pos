# Master data step 2 — scan-or-type item code in the product pickers (2026-10-16)

**Branch:** `feature/barcode-pickers`, on item master step 1 (`94a4030`). Local only; nothing is deployed.

## 1. What changed
- One shared component, `frontend/src/components/ProductCombobox.tsx`, now resolves a scanned or typed code. It serves the Purchase Request, Purchase Order, warehouse transaction form, Inventory product filter and the BOM component picker.
- **Enter** (how a scanner ends a scan) resolves the text: an exact SKU in the loaded list first, then `GET /products/lookup?code=` (exact SKU, then exact barcode; the endpoint from step 1, Company-scoped, same read policy as `/products/all`). A hit selects the item through the picker's own `onSelect`, so each screen's existing add-line logic runs unchanged.
- **Manual fallback is unchanged:** typing still filters by name or SKU, clicking an option still selects. An unknown code, or an item the screen's list does not contain, shows a one-line message and leaves the text and the list in place.
- Enter in this field no longer submits the surrounding form (a scanner's Enter must not submit a half-built document).
- No new endpoint and no second barcode model. One data-only migration: `core/1790015400000-SeedBarcodeLookupTerminology` (two labels, `down` removes exactly them).

## 2. Verification
| Check | Result |
|---|---|
| Frontend build / lint | PASS / 0 errors |
| Browser, disposable env (`daii_test_biz_t97_bc_*` on 5546, ports 3611/5611): barcode on the Purchase Request screen | selects the item; the page does not submit |
| Exact SKU (`CAB-2M`) on the Purchase Request screen | selects the item, without a lookup call |
| Unknown code on the Purchase Request screen | message «لا يوجد صنف بهذا الكود أو الباركود — اختر الصنف من القائمة»; text and list stay (screenshot 01); lookup answered 404 |
| Barcode of a discontinued item on the Purchase Request screen | selects it, as picking it by name does; the existing F11 server gate refuses it when the request is saved |
| Manual: type part of a name, click the option | selects; unchanged |
| Warehouse receipt form: scan | adds the line and clears the search (screenshot 02); a second scan of the same item is answered by the form's own duplicate guard |

Not exercised in the browser: the Purchase Order screen, the Inventory filter and the BOM picker use the same component with the same props, but only the Purchase Request and warehouse receipt screens were clicked through.

## 3. After the browser check
- Real-PG regression on 5546, three specs (product-master-data, products, warehouse-item-assignment): **3 / 3 PASS, 18 tests**. Backend lint 0 errors. The backend change is the data-only migration.
- Disposable environment torn down: servers on 3611 / 5611 stopped, `daii_test_biz_t97_bc_cp` and `_co` dropped, cluster 5546 holds no test databases.
- Not covered: a Purchase Order screen click-through (needs a supplier), the Inventory filter and BOM picker. Hosting-only checks stay deferred.

