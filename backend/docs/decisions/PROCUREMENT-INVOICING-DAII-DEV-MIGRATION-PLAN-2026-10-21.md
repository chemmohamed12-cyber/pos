# Procurement invoicing A-E - migration plan for the `daii_dev` preview (PLAN ONLY - nothing was executed)

Date: 2026-10-21. Status: **prepared for review. No migration was run against `daii_dev`, any Company database, or any hosted database.** Executing it needs an explicit authorization naming the database, the change scope and the rollback plan (owner rule of 2026-10-20). This document is that proposal.

## 1. Target
- Platform database `daii_dev` and its four Company databases (Alpha, Beta, Gamma, Delta) on the shared development server (localhost:5433), so that the `:5173` preview served from the integration build can show phases A-E.
- Method (existing, reviewed tool): the `devdb-upgrade` script in dry-run mode first (lists exactly which migrations would run, writes nothing), then `--apply` only after authorization.

## 2. What would change (all additive; no existing row, amount, number, journal, stock movement or status is touched)
| Migration (tag) | Effect |
|---|---|
| 1790020000000 `CreateSupplierInvoiceLineReceipts` (procurement) | new table `supplier_invoice_line_receipts`; FIFO backfill of live invoice lines, rows tagged `backfill_fifo`; STOPS (writes nothing) if any live invoiced quantity exceeds received |
| 1790020100000 `CreateSupplierPaymentAllocations` (procurement) | new table `supplier_payment_allocations`; one factual row per existing payment |
| 1790020200000 `AddSupplierInvoiceApprovalAndPolicy` (procurement) | 9 nullable columns on `supplier_invoices`; new table `procurement_invoice_policies` (no row = legacy behaviour, approval OFF); terminology |
| 1790020300000 `SeedProcurementCostPolicyTerminology` (core) | 6 terminology rows (labels of the three new account settings) |
| 1790020400000 `AddSupplierInvoiceCharges` (procurement) | 4 columns on `supplier_invoices` with neutral defaults (0 / capitalize) |
| 1790020500000 `CreatePurchaseReturns` (procurement) | new tables `purchase_returns`, `purchase_return_lines`; `quantityReturned` (default 0) on goods-receipt and order lines; terminology |
| 1790020600000 `CreateSupplierCreditNotes` (procurement) | new tables `supplier_credit_notes`, `supplier_credit_note_lines`; 3 nullable columns on `purchase_return_lines`; `quantityReturnedInvoiced` (default 0); terminology |

Code-side (in the integration build, not a database change): accounting manifest 1.20.0 adds three config keys (`accounting.purchase_cost_difference_after_receipt_account_code`, `accounting.purchase_return_cost_difference_account_code`, `accounting.purchase_other_charges_account_code`), all empty = fail-closed; procurement manifest 1.7.0 adds permission nodes (submit / approve / override / policy, purchase return, supplier credit note). Existing roles with a module-wide procurement grant cover them; nothing is granted automatically to anyone else.

## 3. Read-only preflight (run first, SELECT only)
`backend/tools/preflight/procurement-allocations-preflight.sql` against each Company database. Result already known for `daii_dev` on 2026-10-20 (read-only look): Alpha has 2 purchase orders, 2 goods receipts, 0 invoices, 0 payments; Beta / Gamma / Delta are empty - so the backfills would insert nothing and cannot stop. The preflight must still be re-run immediately before applying.

## 4. Order, verification and rollback
1. Take a logical dump of `daii_dev` and the four Company databases (owner-approved location). Note the migration table's last row per database.
2. Dry run of `devdb-upgrade` - expected: exactly the 7 migrations above per applicable database.
3. Preflight SQL - expected: no rows in checks 1-3.
4. `--apply`. After it: the new tables exist and are empty (except the payment-allocation backfill, which is empty because there are no payments); `procurement_invoice_policies` has no row; existing screens behave as before.
5. Rollback: each migration has a tested `down` (up -> down -> up rehearsed in disposable databases: spec `procurement-allocations.migrations`). Run them in reverse order, or restore the dump. After business documents use the new tables a `down` would delete that history - use the dump, not `down`, once real documents exist.
6. Smoke on `:5173` after apply: purchase order quantities table, a multi-order invoice, approval switch off/on, charges, a purchase return, a credit note; then record the Company and data used.

## 5. Preconditions that are NOT part of the migration
- The finance owner must assign the three GL accounts per Company before any document that needs them can post (the screens and API refuse with a message naming the missing account). No account number is assumed anywhere in the code.
- New Companies get the approval workflow ON at provisioning; existing Companies stay OFF until their administrator turns it on.

## 6. Decision requested
Authorize (or refuse) the dry run and apply on: `daii_dev` + Alpha, Beta, Gamma, Delta, scope = the 7 migrations above, rollback = dump restore / reverse `down`.
