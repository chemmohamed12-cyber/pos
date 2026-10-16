# Browser verification — local RC (2026-10-16)

Environment: committed integration worktree, Vite :5173 -> backend :3500 (dist built by ci.sh) on daii_dev, company Alpha, user = the local test admin. Test barcode 6221234500012 added to item 1001 through the Barcodes API (daii_dev is experimental).

| # | Check | Result |
|---|---|---|
| 1 | PO item picker: type the barcode, Enter | PASS - resolved to item 1001 (بورده 12 وات ابيض), no form submit |
| 2 | PO picker: unknown code NOPE999 + Enter | PASS - red message "no item with this code or barcode - choose from the list"; text and list kept |
| 3 | PO picker: manual selection (type name fragment, click option) | PASS - value = chosen name, no message |
| 4 | Inventory filter: barcode + Enter (warehouse 1) | PASS - filter set to item 1001; grid shows exactly that item (1 row) |
| 5 | BOM picker (Item Details, tab 6, New BOM): exact SKU 1002 + Enter | PASS - component line "1002 - سلك 9 سم" added with quantity 1 |
| 6 | BOM picker: unknown code | PASS - same message shown; nothing added; Cancel leaves no BOM |
| 7 | Duplicate barcode (API, same code on another item) | PASS - 409 CONFLICT "already assigned to another item"; the Barcodes panel shows ApiError.message |
| 8 | Item Details: all six tabs open without error | PASS (basic, balances, movements, units+barcodes, cost/pricing, BOM) |
| 9 | Products screen: warehouse column | PASS (heads include المستودع; row shows "1 - مخزن المفكك") |
| 10 | Supplier profile + purchases tab | PASS (profile fields; PO-2026-000001 listed; empty invoices/payments handled) |
| 11 | Customer account > Customer profile tab | PASS (fields, contacts, addresses panels render, no error) |
| 12 | Trial balance footer | PASS (footer "Totals" row renders; Alpha has no postings so 0.0000) |

Notes: first screenshots after Enter sometimes preceded the async lookup response; the DOM after the response was checked (message / resolved name). No defect reproduced. Not covered here: PR and warehouse-form pickers use the same shared component (covered by the step-2 specs and the shared-component checks above).
