# Treasury — supplier-payment reversal (T2-S) — 2026-10-21

Branch `feature/treasury-integrity` (after the Procurement merge). Real-PG runs on the dedicated cluster 5546 (`biz_t83_`, `biz_t84_`). Nothing merged to `main`, no version change, nothing deployed; `daii_dev`, Alpha–Delta, :5173, :3500 untouched.

## Delivered (all in NEW files or additive lines of Treasury/Finance-owned files)
| Item | File |
|---|---|
| Reversal service (mirror of `PaymentsService.reversePayment`): offsetting Treasury leg, one-per-payment record, Supplier Ledger `payment_reversal` CREDIT per invoice bucket, event `finance.supplier_payment.reversed` (Dr bank / Cr AP), invoice re-open, audit — one transaction | `procurement/application/supplier-payment-reversal.service.ts` |
| Route `POST procurement/supplier-payments/:id/reverse` (node `finance.supplier_payment.reverse`, `Idempotency-Key` honoured) | `procurement/interface/supplier-payment-reversal.controller.ts` |
| GL handler for the new topic (resolved by the paying account's own mapped code, no control-account fallback) | `accounting/…/supplier-payment-reversed.handler.ts` + registered in `finance-handlers.ts`, `handler-registry.ts` (subscribed topic), `financial-event.service.ts` (publish-time guard) |
| Migration (additive, empty table, UNIQUE(supplierPaymentId), FK to `supplier_payments`; procurement tag) | `database/migrations/procurement/1790030400000-CreateSupplierPaymentReversals.ts` |
| Contract: `FinanceTreasuryContract.reverseOwnedLeg`, `AP_EVENT_TOPICS.supplierPaymentReversed` | `foundation/module-registry/contracts/…` |
| Permission nodes `finance.supplier_payment`, `finance.supplier_payment.reverse` (inherit from `finance`) | `finance.manifest.ts` |
| Spec (real PG, A/B): S1–S7 | `procurement/interface/supplier-payment-reversal.company-isolation.spec.ts` |

## Verification (actual)
- New spec **7/7** (`biz_t83_`): S1 partial payment reversed → Treasury, supplier ledger, invoice status and GL (bank 1102, AP 2101) return to their pre-payment values, events `recorded:POSTED` + `reversed:POSTED`; S2 paid→posted and partially_paid→posted; S3 one allocated payment over two invoices re-opens both; S4 second + 5 concurrent reversals → exactly one effect; S5 raw Treasury reversal of the payment's leg refused; S6 closed period, blank reason, unknown payment, cross-Company refused with a zero-side-effects fingerprint; S7 AP subledger == GL AP, all journals balanced, no non-POSTED event, Company B untouched.
- Adjacent regression **14/14** (`biz_t84_`): event-engine, supplier-payment/invoice, payment-reversal, treasury-posting, accounting-policy, treasury-documents, bank-reconciliation specs. Unit mode 66 suites / 508 tests; `tsc --noEmit` and eslint (new files) clean.

## NOT DONE — needs Procurement's agreement (their files; not edited)
The reversal is **not wired into the running application** until these additive changes are made in Procurement-owned files (a permission-layer block stopped me from editing them, and I did not work around it; message sent to the Procurement session, no reply yet):
1. `procurement/domain/supplier-invoice-process.ts` — three transitions: `paid→partially_paid` (`reopen_partial`), `paid→posted` (`reopen_paid`), `partially_paid→posted` (`reopen_paid`). **The spec currently adds them in memory (`ensureAgreedReopenTransitions`) — the S1–S7 result therefore proves the logic, not the shipped process definition.** Delete the shim once the file carries them.
2. `procurement/procurement.module.ts` — import `ErrorContractModule`; add `SupplierPaymentReversalController` to `controllers` and `SupplierPaymentReversalService` to `providers`.
No entity registration is needed (the reversal table is accessed with plain SQL).
Until (1)–(2) land, the endpoint does not exist and a supplier payment can still not be reversed in the product.

## Notes / residuals
- Allocation rows in `supplier_payment_allocations` stay as history of the original payment (Procurement's own integrity check compares them with `entryType='payment'` ledger rows, which a reversal does not touch).
- `DOMAIN_OF_TOPIC` has no entry for any supplier-payment topic (pre-existing: recorded events show source domain `unknown`); left unchanged.
- The procurement manifest's `events` list was not extended (declarative only, their file).
