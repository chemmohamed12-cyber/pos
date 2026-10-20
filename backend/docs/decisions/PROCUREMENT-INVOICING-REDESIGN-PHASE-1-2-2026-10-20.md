# Procurement invoicing redesign - Phase 1 (current code review) and Phase 2 (target design, migration plan, test matrix)

Date: 2026-10-20. Status: **design for review - no constraint, schema or data was changed.** Recommendation at the end: **READY FOR REVIEW (design)**; implementation waits for the policy decisions in section 6.

## 0. Withdrawn attempt
An uncommitted guard "one supplier invoice per purchase order" (service check + picker filter + list flag + a rewritten spec case) was written during this session and is **withdrawn by the CTO decision**. It never reached a commit. It is archived as `evidence-2026-10-20-procurement-invoicing/reverted-one-invoice-per-po-attempt.patch` (commit 46a394b), the six files were restored to their committed state, `dist` was rebuilt from the restored source (the string of the guard is gone) and the preview frontend was restarted. The running backend process (:3500) was started before the guard and never contained it.

## 1. Phase 1 - what the code does today

### 1.1 Root cause of the "one invoice" restriction
**There is no such restriction in the committed design.** Checked: `supplier_invoices.purchaseOrderId` is `NOT NULL REFERENCES purchase_orders` with a plain (non-unique) index `IDX_supplier_invoices_po`; the only unique index is on `invoiceNumber`. The service guard is quantitative, per PO line: `quantity <= quantityReceived - quantityInvoiced`. The existing spec case "PARTIAL INVOICING (GR 10): 4 @10 then 6 @11" proves two invoices on one order post correctly (GRNI cleared 40 + 60, PPV on the second, quantityInvoiced 10). The restriction existed only in the withdrawn attempt, which was a misreading of "one invoice per receipt".

### 1.2 What already satisfies the directive
| Requirement | Status today | Evidence |
|---|---|---|
| PO -> many goods receipts | yes | `goods_receipts.purchaseOrderId`, many per order |
| PO -> many supplier invoices, partial invoicing | yes | no unique constraint; spec 6 of `supplier-invoice-ppv-vat` |
| Over-invoicing blocked per line | yes (hard block, quantity) | `createDraftInvoice` 3-way guard |
| Price variance | stored and posted to the PPV account (not blocking) | D5 |
| VAT | explicit amount, posted | D5 |
| Exactly-once posting | yes: per-invoice transition lock, per-invoice payment lock, idempotent financial events | `postInvoice`, `recordPayment` |
| Void/cancel restores quantities atomically | yes | spec 7 / 7b |
| Independent payment lifecycle per invoice (partial / full) | yes | `recordPayment`, `getInvoiceRemaining` |
| GL = subledger reconciliation (GRNI, AP) | yes | spec 12/13 |
| Company isolation | yes (per-Company connection everywhere) | isolation specs |

### 1.3 Gaps against the directive (each is a place that assumes a simpler model)
| # | Gap | Where | Effect |
|---|---|---|---|
| G1 | **No receipt-level allocation.** An invoice line is matched to a PO line only; which goods receipt(s) it covers is not recorded. GRNI is cleared at the PO line cost, not per receipt. | `supplier_invoice_lines` (PO line only); `purchase_order_lines.quantityInvoiced` aggregate | cannot show or enforce "this receipt is invoiced up to X"; returns / credit notes cannot target a receipt |
| G2 | **An invoice belongs to exactly one PO** (header `purchaseOrderId NOT NULL`). | `supplier_invoices`, DTO, form | a supplier invoice covering several orders must be split |
| G3 | **A payment settles exactly one invoice** (`recordPayment(supplierId, invoiceId, amount)`). | `supplier_payments.invoiceId` | no one-payment-many-invoices |
| G4 | **No configurable tolerances or approved exceptions.** Quantity is a hard stop; price is informational. Invoice before receipt is impossible (PO must be received). | service, config | no policy-driven tolerance, no audited override |
| G5 | **Only VAT is modelled.** No discount, freight or other charge fields or accounting rule. | invoice header/lines | the directive's discounts and transport are unsupported |
| G6 | **Credit / debit notes are not linked to invoices.** AP adjustments take a free-text supplier reference and an amount; there is no supplier return document. | `ap-adjustment.service` | no cap "credited <= invoiced", no line-level return |
| G7 | **No create -> approve -> post separation for supplier invoices** (draft -> post). Credit notes / write-offs are approval-gated; invoices are not. | `supplier-invoice-process` | policy question (section 6) |
| G8 | **Screens show received/invoiced only through the goods-not-invoiced list**; no per-line ordered / received / invoiced / remaining table on the PO and invoice screens; no ordered / invoiced / remaining value totals. | frontend | visibility |

### 1.4 Data in the shared development databases (read-only check, 2026-10-20)
Alpha: 2 POs, 2 goods receipts, **0 invoices, 0 payments**; Beta / Gamma / Delta: empty. No PO line has invoiced > received and no order has more than one invoice. A migration there cannot disturb a posted document. Hosted installations are **not assessed** (no access); the migration plan below includes the read-only dry-run SQL the owner would run first.

## 2. Target relationships (Phase 2)
```
PurchaseOrder 1---* PurchaseOrderLine
PurchaseOrder 1---* GoodsReceipt 1---* GoodsReceiptLine --- PurchaseOrderLine
SupplierInvoice 1---* SupplierInvoiceLine --- PurchaseOrderLine        (exists)
SupplierInvoiceLine *---* GoodsReceiptLine   via NEW supplier_invoice_line_receipts(invoiceLineId, goodsReceiptLineId, quantity)   (G1)
SupplierInvoice  *---* PurchaseOrder         via the lines' PO lines; header purchaseOrderId kept as the "primary" reference and made nullable only in the multi-order phase (G2)
SupplierPayment  *---* SupplierInvoice       via NEW supplier_payment_allocations(paymentId, invoiceId, amount); payment.invoiceId kept for history (G3)
SupplierCreditNote 1---* SupplierCreditNoteLine --- SupplierInvoiceLine   NEW, capped by (invoiced - credited) per line (G6)
PurchaseReturn 1---* PurchaseReturnLine --- GoodsReceiptLine              NEW, capped by (received - returned - credited) (G6)
```
Principles: allocation rows are the source of truth for "how much of receipt line R is invoiced"; `purchase_order_lines.quantityInvoiced` stays as a maintained aggregate and a reconciliation check asserts `aggregate = sum(non-void allocations)`; accounting follows the receipt: GRNI is cleared **per allocated receipt line at that line's receipt cost**, price/quantity differences go to the approved variance accounts, never to inventory cost twice; every posting keeps its idempotency key and advisory lock.

## 3. Migration plan (additive, repeatable, reviewable)
1. **M1 `supplier_invoice_line_receipts`** (new table, FKs, `CHECK quantity > 0`, unique `(invoiceLineId, goodsReceiptLineId)`), plus a nullable `allocationBasis` (`'recorded'` | `'backfill_fifo'`).
2. **Backfill (idempotent, no amounts or journals touched):** for each PO line, walk its non-void invoice lines in creation order and its goods-receipt lines in receipt order and allocate FIFO up to the received quantity; skip a PO line whose recorded invoiced quantity exceeds its received quantity and **STOP** with a report (that is an inconsistent document needing a decision, not a silent repair). Re-running inserts nothing (unique key).
3. **M2 `supplier_payment_allocations`** (new), backfilled one row per existing payment from `payment.invoiceId` + `amount`.
4. **M3 (later phases)** nullable additive columns: invoice `discountAmount`, `freightAmount`, `otherChargesAmount`, `invoiceDate`; credit-note and return tables; header `purchaseOrderId` nullable only with the multi-order phase.
5. Every migration has a working `down`, runs through the release engine fan-out, never rewrites a document, a number, a balance or a journal, and is rehearsed on a disposable copy before any shared database.
6. **Dry-run SQL for any real installation (read-only):** invoices per order; PO lines with invoiced > received; payments whose invoice is void; sum(invoice lines) vs `quantityInvoiced`.
Backward compatibility: all current APIs keep working (new fields optional; allocations are written automatically by `createDraftInvoice` using FIFO over the order's receipts unless the client supplies explicit receipt lines); existing invoices keep their numbers, journals and links.

## 4. Test matrix (real PostgreSQL, A/B Companies; every row checks balanced journals and GL = subledger for GRNI, AP, inventory)
| # | Scenario | Exists today |
|---|---|---|
| 1 | one PO, three partial invoices | extend spec 6 (4 / 6 -> three invoices) |
| 2 | one invoice covering several lines | new |
| 3 | several receipts and several invoices on one PO, allocations per receipt | new (needs M1) |
| 4 | invoice over the received / remaining quantity rejected, no partial write | exists (quantity); extend to receipt level |
| 5 | price variance, VAT, discount, freight | price + VAT exist; discount / freight new (policy D3) |
| 6 | return after partial invoicing | new (G6) |
| 7 | credit note linked to an original invoice line, capped | new (G6) |
| 8 | one payment over several invoices; several payments on one invoice | second exists; first new (M2) |
| 9 | retry of a posting: no duplicate journal / event | exists; extend to allocations |
| 10 | failure mid-way leaves no partial effect (rollback) | exists (7b); extend |
| 11 | Company isolation incl. cross-Company receipt / invoice linking refused | new for allocations |
| 12 | historical (pre-migration) invoices: backfill, aggregate reconciliation, void, payment still work | new |
| 13 | supplier statement, AP aging, GRNI reconciliation, inventory valuation after each scenario | exists for AP / GRNI; add statement and valuation asserts |

## 5. Proposed phasing (each phase on its own branch, disposable environment, separate approval to merge)
- **A** allocation table + backfill + aggregate reconciliation + per-line ordered / received / invoiced / remaining view (G1, G8).
- **B** payment allocations: one payment to many invoices (G3).
- **C** tolerances, approved exceptions with permission + reason + audit, discount / freight / other charges (G4, G5).
- **D** credit notes and purchase returns linked to invoice / receipt lines (G6).
- **E** one invoice covering several orders (G2).
Recommended start: A and B (no accounting policy question).

## 6. Decisions needed from the owner before the phases that depend on them
- **D1** may an invoice be entered before the receipt, or exceed it, under a permission + reason (G4)? default proposal: no.
- **D2** tolerance defaults (quantity %, price %), per Company setting.
- **D3** discount and freight: capitalised into inventory cost (landed cost) or expensed; affects valuation and GRNI.
- **D4** multi-order invoices: allowed only for the same supplier? (proposal: yes).
- **D5** create -> approve -> post separation for supplier invoices (today draft -> post; credit notes are approval-gated).
- **D6** credit notes as a new linked document replacing the free-text AP adjustment for invoice-related cases, or a link added to the existing one.
- **D7** scope of a purchase-return document (stock out, GRNI / AP effect).

## 7. Stop conditions
None triggered: no posted document is unmatched, no partial entry and no duplicate stock / GRNI effect was found in the databases that could be checked. Hosted data must be checked with the dry-run SQL before any migration there.

## 8. Recommendation
**READY FOR REVIEW (design).** Implementation of phases A and B can start on a new branch from the integration tip after your approval of this document; phases C-E wait for D1-D7.
