# D5 — PPV + Input VAT: code-audit notes (2026-10-05) — DRAFT, NOT the Decision Record

**Status: AUTHORIZED by the CTO. Step 1 (read the chain) PARTLY done. No code touched. The Decision Record (policy + the 5 numeric examples) is NOT written yet — no implementation before it.**

## Evidence read so far (procurement → GL)
1. **PO line price** — `purchase_order_lines.unitCostBase` (NUMERIC 18,4); no tax fields on PO, PO line, supplier invoice or supplier-invoice line. `suppliers` has `taxRegistrationNumber` / `vatRegistrationNumber` only (no VAT-applicable flag).
2. **Goods Receipt** — `GoodsReceiptService.post` (`goods-receipt.service.ts`): receipt value = qty × **PO** unit cost; inventory valuation bootstrapped at that cost; event `procurement.goods_receipt.posted` → `handleGoodsReceiptPosted`: **Dr Inventory (control `inventory`) / Cr GRNI (control `grni`)**.
3. **GRNI ledger** — `GrniLedgerService`: outstanding GRNI = Σ (quantityReceived − quantityInvoiced) × **PO** unitCostBase (no table of its own).
4. **Supplier Invoice draft** — `SupplierInvoiceService.createDraftInvoice`: invoice line carries the supplier's own `unitCostBase`; `totalAmount = Σ qty × invoice cost`; `unitCostVariance = invoice − PO cost` per line and `priceVarianceAmount = Σ |variance| × qty` are **stored but informational only** (never posted). `quantityInvoiced` is incremented at **draft** time; qty > received − invoiced is hard-blocked. `voidInvoice` does not appear to restore `quantityInvoiced` (to verify).
5. **Supplier Invoice post** — `postInvoice`: Supplier Ledger credit = `totalAmount`; event `finance.supplier_invoice.posted` with **`taxAmount: '0'` hard-coded**, `grossAmount = totalAmount`. `handleSupplierInvoicePosted`: **Dr GRNI / Cr AP for the invoice net** (control accounts `grni`, `ap`).
6. **Tax engine** — `TaxEngineService` is **ambient** (`this.dataSource`, not Company-scoped) and sales-oriented (`calculateForInvoice`, `resolveTaxAccountCode`, `accounting.default_tax_code`); `TaxCode` has `rate`, `isInclusive`, `type`, `accountMappingRef`. The chart already has a `tax_receivable` control function (Input VAT) — nothing posts to it from procurement.

## Gap (confirmed by reading)
- **PPV:** GR credits GRNI at PO cost; the invoice debits GRNI at the *invoice* cost. Any price difference (+10 / −10 in the CTO's examples) is left **inside the GRNI control account** as a residual (and the GRNI ledger contract, priced at PO cost, no longer matches the GL). No PPV account/config exists.
- **Input VAT:** none — no tax columns, hard-coded `taxAmount '0'`, no VAT-applicability rule, no `tax_receivable` posting, supplier ledger/AP carry net only.
- **Open questions the policy must settle (CTO asked for explicit answers):** is the invoice total VAT-inclusive; VAT amount explicit vs derived from a rate; rate per line or per invoice; supplier not VAT-applicable; behaviour for later credit/debit notes/returns; which configured accounts (PPV account key, Input VAT = existing `tax_receivable` control or a configured key) — **no account code may be invented**; missing-configuration behaviour = fail closed before mutation (as D3/D4).

## Next steps (not done — usage limit reached)
1. Finish the read: `supplier-ledger.service.ts`, `ap-reconciliation` / `grni-reconciliation.service.ts` (how PPV residue would show), `ap-adjustment` (credit/debit note path), PO creation/price source (RFQ), `supplier-payment`, and confirm the `voidInvoice` / `quantityInvoiced` behaviour.
2. Write the **D5 Decision Record** with: current behaviour/chain, evidence, gap, proposed policy, and concrete numeric examples — (1) same price, (2) invoice higher, (3) invoice lower, (4) VAT applicable, (5) VAT not applicable — plus configuration prerequisites and fail-closed rules.
3. Only after the policy is recorded: implement → real-PG A/B spec → regression on an isolated seeded PostgreSQL → closure.
