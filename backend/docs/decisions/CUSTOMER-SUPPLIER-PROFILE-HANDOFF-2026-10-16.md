# Customer and supplier profiles — handoff (2026-10-16)

> **Scope:** master-data gap matrix §5 (`MASTER-DATA-AUDIT-AND-GAP-MATRIX-2026-10-15.md`), migrations M4–M7, owner directive "complete Customer Profiles and Supplier Profiles, reusing the existing models".
> **Branches:** customer `feature/customer-profile` (`ae6a260`); supplier `feature/supplier-profile` (on top of it). Neither touches Item Details, the item master/barcode work, `ItemDetails.tsx` or `ui.css`.
> **Decisions applied (matrix §9 recommendations):** D-MD1 no shared party model (shared UI layout only); D-MD6 legacy customer address kept, no backfill; D-MD7, D-MD9 and D-MD10 deferred. No new scope beyond the matrix.

## 1. What changed

| Area | Customer | Supplier |
|---|---|---|
| Schema (all additive, reversible) | `sales/1790016000000`: 9 nullable columns on `customers` (partyType, legalName, tax/VAT/commercial numbers, email, website, language, internalNotes) with CHECKs for partyType and language.<br>`sales/1790016100000`: `customer_addresses` (default / billing / shipping flags) and `customer_contacts` (primary). Partial unique indexes allow one default address and one primary contact per customer. | `procurement/1790016300000`: 4 nullable columns on `suppliers` (email, website, language, internalNotes) with a CHECK on language. Contacts and addresses already existed. |
| Labels | `core/1790016200000`: 22 new codes, `ON CONFLICT DO NOTHING` | `core/1790016400000`: 9 new codes, `ON CONFLICT DO NOTHING` |
| API | `GET /customers/:id/profile`; `POST /customers/:id/update`, `/contacts`, `/contacts/:cid/update\|remove`, `/addresses`, `/addresses/:aid/update\|remove`. Permission `sales.customer.edit` + the existing row-scope check. | The existing `POST /procurement/suppliers/:id/update` now accepts the 4 new fields; new `POST …/contacts/:cid/update\|remove` and `…/addresses/:aid/update\|remove` (permission `procurement.supplier.edit`); `GET /procurement/purchase-orders?supplierId=` (an optional UUID, ANDed with the F6 warehouse filter). The add-contact / add-address paths now keep exactly one primary / default. |
| Backend code | `customer-profile.service.ts` (new), entities, controller routes | `supplier-profile.service.ts` (new), `SupplierService.updateSupplier`, controller routes, PO list filter |
| Shared | `foundation/profile/profile-validation.ts` (value rules used by both: trim, blank clears, e-mail, language, website, lengths) | |
| UI | "Customer profile" tab on the Customer Account screen | New page `/suppliers/:id` (profile tab: fields, contacts, addresses, bank accounts read-only; purchases tab: purchase orders, supplier invoices, supplier payments, queried by supplier) with an "Open supplier profile" button on the list |
| Shared UI | `components/profile/ProfileFieldsCard`, `ProfileContactsPanel`, `ProfileAddressesPanel` (one layout used by both screens) | |

**Untouched (by design and by test):** customer status, workflow policy, price list, assignment and financial settings (their own endpoints and permissions); sales orders, invoices, payments, ledgers, snapshots and Excel import/export; supplier status, code, payment terms, credit limit, bank-account approval flow, supplier ledger, statement and payment flows.

## 2. Rollback

Each `down()` removes exactly what its `up()` added, and a round trip (`down` then `up`) is proven in both specs. Order: supplier 1790016300000, then labels (1790016400000, 1790016200000), then customer addresses/contacts (1790016100000), then customer columns (1790016000000). Rolling back drops only the new profile data; every pre-existing column and table keeps its data.

## 3. Verification (real Postgres on the approved dedicated cluster 127.0.0.1:5546)

All runs: `node tools/testing/biz-run.js --regression <list>`, one jest process per spec, DB guard on.

| Run | Specs | Tests | Result |
|---|---|---|---|
| New: `customer-profile.company-isolation` | 1 | 9 | PASS |
| Customer-related regression (customers, customer ledger, invoices, on-account payment, payments, deposits, fulfillment, returns, sales orders, sales, shipment) | 12 (incl. the new one) | 62 | 12/12 PASS, 0 failed, 0 skipped |
| New: `supplier-profile.company-isolation` | 1 | 8 | PASS |
| Supplier regression batch 1 (supplier-profile, customer-profile, supplier-master, purchase-order, rfq-supplier, supplier-invoice, supplier-payment, procurement-item-eligibility) | 8 | 57 | 8/8 PASS, 0 failed, 0 skipped |
| Supplier regression batch 2 (accounting, grni, subledger controllers, goods receipt, new item request, purchase request, rfq award visibility, supplier-invoice ppv/vat, warehouse reference, treasury bank leg, treasury) | 11 | 79 | 11/11 PASS, 0 failed, 0 skipped |

Also on each branch: backend `tsc --noEmit` and `npm run build` PASS, frontend `tsc -b` and `npm run build` PASS, frontend lint 0 errors (warnings 58 vs 56 before: the two new pages use the same set-state-in-effect load pattern as the existing screens).

What the new specs prove: schema, CHECKs and unique indexes; partial update / clear / no-op (no write, no audit); every validation error is a 400 and writes nothing; the lifecycle and financial columns are untouched; contacts and addresses (one primary / default, cross-customer and cross-supplier 404, concurrent claims never leave two); Company isolation; the PO supplier filter with and without the F6 warehouse filter; migration down/up.

## 4. Known limits and open items

- The contacts and addresses panels offer add, set-primary/default and remove (the update endpoints also accept full edits, which the UI does not expose yet).
- The supplier "purchases" tab shows purchase orders, supplier invoices and supplier payments. Goods receipts stay reachable per purchase order (there is no goods-receipt list by supplier endpoint; adding one is a separate small change).
- Customer `address` and `governorate` (legacy) stay the shown values until addresses are added (D-MD6).
- Evidence (logs and spec lists): `evidence-2026-10-16-profiles/`. Browser verification on the merged preview is recorded in the integration report.
