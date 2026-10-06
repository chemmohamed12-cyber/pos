# D5 — Purchase Price Variance (PPV) + Input VAT: Decision Record (2026-10-05)

**Status: POLICY APPROVED (CTO gate, 2026-10-05, with the amendments in §10) → IMPLEMENTED → INTEGRATED → REAL-PG VERIFIED → CLOSED (2026-10-05). §1–§9 below are the proposal as submitted; §10 records the approval and the binding amendments.**
Sequence (CTO): read-only trace → complete evidence → **this record** → CTO policy gate → implementation → real-PG A/B → accounting reconciliation → isolated regression → VERIFIED/CLOSED. Supersedes the draft `D5-PPV-INPUT-VAT-AUDIT-NOTES-2026-10-05.md` (kept as the working notes).

## 1. CTO mandate (D5)
GR stays `Dr Inventory / Cr GRNI`. If the supplier invoice price ≠ receipt price, the difference goes to a **configured PPV account** — never hidden in GRNI, never hard-coded. Input VAT is an **explicit accounting component** when the purchase is VAT-applicable — never inferred from the total. **No account code is invented**: a missing account is a configuration prerequisite, rejected before mutation. The Tax Engine's ambient DataSource is not to be touched unless D5 actually needs it.

## 2. Current behaviour — the accounting chain, with evidence

| Step | Where | What happens today |
|---|---|---|
| PO price | `PurchaseOrderService.create` (`unitCostBase` per line, typed by the buyer, or copied by `RfqService` award) | `purchase_order_lines.unitCostBase` NUMERIC(18,4) is the **agreed price**. No tax fields on PO / line / supplier invoice / invoice line. |
| GR | `GoodsReceiptService.post` | receipt value = qty × **PO** unit cost; valuation bootstrapped at that cost; event `procurement.goods_receipt.posted` → `handleGoodsReceiptPosted`: **Dr Inventory (control `inventory`) / Cr GRNI (control `grni`)**. |
| GRNI subledger | `GrniLedgerService` | outstanding = Σ (quantityReceived − quantityInvoiced) × **PO** cost (no table; derived). |
| Invoice draft | `SupplierInvoiceService.createDraftInvoice` | line carries the **supplier's own** `unitCostBase`; `totalAmount = Σ qty × invoice cost`; per-line `unitCostVariance` and header `priceVarianceAmount = Σ|variance|×qty` are **stored, informational only**. `quantityInvoiced` is incremented **at draft time**. Quantity guard: invoiced ≤ received − already invoiced. |
| Invoice post | `postInvoice` | Supplier Ledger **credit = `totalAmount`**; event `finance.supplier_invoice.posted` with **`taxAmount: '0'` hard-coded**, `grossAmount = totalAmount`; `handleSupplierInvoicePosted`: **Dr GRNI / Cr AP, both = invoice net** (control `grni`, `ap`). |
| Invoice void | `voidInvoice` | reverses the ledger entry and publishes `finance.supplier_invoice.voided` → mirror journal. **`quantityInvoiced` is NOT restored** (neither for a posted void nor for `cancel_draft`). |
| AP reconciliation | `ApReconciliationService` | GL `ap` balance vs Σ Supplier Ledger — currently consistent because both carry the invoice net. |
| GRNI reconciliation | `GrniReconciliationService` | GL `grni` balance vs Σ (recv − inv) × **PO** cost. |
| Credit / debit notes | `ApAdjustmentService` + `ap-adjustment.handler.ts` (FA-01-gated, manual) | `Dr AP / Cr <expense account>` (default **'5299' hard-coded** when no code supplied; opening balance default '3103'). Not linked to an invoice, to PPV or to VAT. |
| Tax engine | `TaxEngineService` | reads `accounting_tax_codes` through the **ambient** `DataSource`; sales-oriented (`calculateForInvoice`, `resolveTaxAccountCode`, `accounting.default_tax_code`). `TaxCode` has `rate`, `isInclusive`, `type`, `accountMappingRef`. The chart already has a **`tax_receivable`** control function (Input VAT) that nothing in procurement posts to. |
| Supplier | `suppliers.taxRegistrationNumber`, `vatRegistrationNumber` | the only VAT-related supplier data (no explicit "VAT-applicable" flag). |

## 3. Gap (confirmed)
1. **PPV is buried in GRNI.** GR credits GRNI at PO cost; the invoice debits GRNI at the invoice cost. Invoice 110 vs receipt 100 ⇒ GRNI ends **10 Dr** (a permanent residue); invoice 90 ⇒ **10 Cr**. The GRNI subledger (PO-cost based) and the GL then disagree forever (`drift_found` in GRNI reconciliation). The 10 never reaches the P&L.
2. **Input VAT does not exist.** Hard-coded `taxAmount '0'`; no tax data on the invoice; no `tax_receivable` posting; supplier ledger/AP carry net only, so a real supplier invoice with VAT cannot be recorded correctly (AP understated by the VAT, VAT asset never recognised).
3. **GRNI integrity on void:** after a void, the GL re-credits GRNI but `quantityInvoiced` stays incremented ⇒ the subledger understates outstanding GRNI (drift) and the quantity can never be re-invoiced.
4. Manual AP credit/debit notes use hard-coded fallback accounts and have no VAT/PPV awareness (pre-existing; see §9).

## 4. Does D5 need the Tax Engine? — **No (proposed).**
Under the proposed policy the VAT amount is **explicit data from the supplier's own invoice** (it is the supplier's legal document: it states the VAT). Nothing is calculated, so `TaxEngineService` (ambient) is **not used by D5** and is left untouched. If the CTO later wants VAT *calculated from a tax-code rate*, that becomes a **dependency/isolation finding that must be solved first** (the engine would have to become Company-scoped) — it is deliberately **out of D5 scope**.

## 5. Proposed policy (for the CTO gate)

### 5.1 PPV
- **GR unchanged** (`Dr Inventory / Cr GRNI` at the PO cost; valuation stays at the PO cost).
- **Invoice posting clears GRNI at exactly what GR credited** — receipt basis = invoiced qty × **PO unit cost** — and sends the price difference to **PPV**:
  `Dr GRNI (qty × PO cost)`, `Dr PPV` when invoice net > receipt basis **or** `Cr PPV` when lower, `Cr AP (invoice net [+ VAT])`.
  The variance is computed from the stored per-line figures (`qty × (invoice cost − PO cost)`), signed; **PPV is on the net amount only (VAT never enters PPV)**.
- **PPV account = configuration** (`accounting.purchase_price_variance_account_code`, default `''` = fail-closed; must exist, be active, postable, non-control). Required **only when the variance ≠ 0**.
- Inventory valuation is **not** adjusted for the variance (the CTO's rule: difference to PPV, not capitalised).

### 5.2 Input VAT
- The supplier invoice gets an explicit **`taxAmount`** (VAT as stated by the supplier; ≥ 0, 2 dp) — **`totalAmount` stays NET (tax-exclusive)**, mirroring the sales invoice convention; `gross = net + VAT`. VAT is never derived from a total and never defaulted.
- **VAT-applicable** ⇔ the invoice carries `taxAmount > 0`. Rule proposed: a non-zero VAT on an invoice from a supplier **without a `vatRegistrationNumber`** is **rejected before mutation** (input VAT cannot be claimed from an unregistered supplier). `taxAmount = 0` is always allowed (VAT not applicable).
- **Input VAT account**: the existing **`tax_receivable` control account**, resolved by control function exactly like `ar` / `tax_payable` are today — **required only when `taxAmount > 0`**; missing ⇒ rejected before mutation (proposed: also reject when more than one active postable `tax_receivable` account exists — no "first account" guess). *(CTO option: a dedicated configured key `accounting.input_vat_account_code` instead — same fail-closed rule; the control-function route is proposed because the chart already models it.)*
- VAT is assumed **fully recoverable** (no partial/non-recoverable VAT, no VAT cost-capitalisation) — **flagged for CTO confirmation**.
- **Supplier Ledger and AP carry GROSS** (`credit = net + VAT`) so `AP (GL)` = `Σ Supplier Ledger` keeps reconciling.

### 5.3 Fail-closed flow (same discipline as D3/D4)
`Validate invoice → compute receipt basis / PPV / VAT → resolve PPV + Input VAT + GRNI + AP accounts (pre-flight, via the existing foundation policy registry — no module cycle) → transaction (state + ledger credit + event) → commit`. A missing PPV account (variance ≠ 0), missing Input VAT account (VAT > 0), or unregistered supplier with VAT ⇒ **rejected at `postInvoice` before any ledger/state/outbox write** (and the draft-time VAT rule at `createDraftInvoice`). The handler re-validates at event time (re-drivable `REJECTED`), never a silent success.

### 5.4 Void
The void journal is the **exact mirror** of the posted journal (GRNI, PPV, Input VAT, AP — all reversed from the same stored figures). Legacy invoices posted before D5 (event payload without receipt/variance fields) keep the **old** mirror shape so their voids stay symmetrical. **Proposed in scope:** restore `quantityInvoiced` on void and on `cancel_draft` (GRNI integrity — §3.3), proven by real-PG.

## 6. Numeric examples — expected journals (PO cost 10.00 ⇒ GR of 10 units = 100.00)

GR (all cases): `Dr Inventory 100.00 / Cr GRNI 100.00`.

| # | Scenario | Invoice | Supplier invoice journal (proposed) | Supplier Ledger |
|---|---|---|---|---|
| 1 | **Same price** | 10 × 10.00 = 100.00 net, VAT 0 | `Dr GRNI 100.00 / Cr AP 100.00` — no PPV line; GRNI = 0 | credit 100.00 |
| 2 | **Invoice higher** | 10 × 11.00 = 110.00 net, VAT 0 | `Dr GRNI 100.00` · `Dr PPV 10.00` / `Cr AP 110.00`; GRNI = 0 (today: GRNI left 10 Dr) | credit 110.00 |
| 3 | **Invoice lower** | 10 × 9.00 = 90.00 net, VAT 0 | `Dr GRNI 100.00` / `Cr PPV 10.00` · `Cr AP 90.00`; GRNI = 0 (today: GRNI left 10 Cr) | credit 90.00 |
| 4 | **VAT applicable** | 100.00 net + VAT 14.00 (supplier VAT-registered) | `Dr GRNI 100.00` · `Dr Input VAT (tax_receivable) 14.00` / `Cr AP 114.00` | credit 114.00 |
| 4b | VAT + variance | 110.00 net + VAT 15.40 | `Dr GRNI 100.00` · `Dr PPV 10.00` · `Dr Input VAT 15.40` / `Cr AP 125.40` | credit 125.40 |
| 5 | **VAT not applicable** | 100.00 net, VAT 0 (unregistered supplier) | `Dr GRNI 100.00 / Cr AP 100.00` — no VAT line; a non-zero VAT on this supplier ⇒ **rejected before mutation** | credit 100.00 |
| 6 | Partial invoicing | 4 of 10 units invoiced at 11.00 = 44.00 | `Dr GRNI 40.00 · Dr PPV 4.00 / Cr AP 44.00`; GRNI left = 60.00 (the 6 uninvoiced units) = subledger | credit 44.00 |
| 7 | Void of #2 | — | exact mirror: `Dr AP 110.00 / Cr GRNI 100.00 · Cr PPV 10.00`; `quantityInvoiced` restored | reversal debit 110.00 |
| 8 | Missing config | variance ≠ 0 with PPV account unset (or VAT > 0 with no Input VAT account) | **`postInvoice` rejected before any write**; nothing posted | none |

Reconciliation after the proposed policy: **GRNI (GL) = GRNI subledger** (both at PO cost, residue-free); **AP (GL) = Σ Supplier Ledger** (both gross); PPV and Input VAT each tie to the sum of the invoices' stored figures.

## 7. Configuration prerequisites (no codes invented)
| Key / account | Used when | Rule |
|---|---|---|
| `accounting.purchase_price_variance_account_code` (**new**, default `''`) | variance ≠ 0 | exists, active, postable, non-control; unset ⇒ reject before mutation |
| Input VAT account — `tax_receivable` control (proposed) **or** new `accounting.input_vat_account_code` | VAT > 0 | resolves to exactly one active postable account; else reject before mutation |
| `grni` and `ap` control accounts | always (already required today) | unchanged |

## 8. Implementation outline (only after the gate)
Additive columns (`supplier_invoices.taxAmount`, header signed `ppvBase`; `supplier_invoice_lines.poUnitCostBase` snapshot of the receipt basis) · `createDraftInvoice` accepts explicit `taxAmount`, stores snapshots, enforces the supplier VAT rule · `postInvoice` pre-flight via `InventoryPostingPolicy` (new method), ledger credit = gross, event payload carries `receiptValueBase`, `ppvBase`, `taxAmount`, `grossAmount` · `handleSupplierInvoicePosted/Voided` build the journals above (legacy shape when the new fields are absent) · `voidInvoice`/`cancel_draft` restore `quantityInvoiced` · frontend: VAT field on the supplier-invoice form · real-PG A/B spec for the 8 scenarios above incl. Dr = Cr, GRNI/AP reconciliation, zero-mutation rejections, A→A, B untouched, Platform DataSource never requested · regression on an isolated seeded PostgreSQL only.

## 9. Decisions requested at the policy gate
1. Confirm PPV as above (variance to a configured PPV account on the **net**, inventory valuation untouched).
2. Input VAT account: existing `tax_receivable` control (proposed) vs a new configured key.
3. Confirm the rule "VAT > 0 requires a supplier with `vatRegistrationNumber`" (and that VAT is fully recoverable).
4. Confirm `quantityInvoiced` restoration on void/cancel is in D5 scope (it is a closed-controller write path → real-PG A/B proof).
5. Confirm **out of scope / follow-ups**: manual AP credit/debit notes (hard-coded default account '5299', no VAT reversal), supplier returns, tax-code–driven VAT calculation (needs the ambient Tax Engine fixed first), per-line VAT rates, multi-currency.

## 10. CTO POLICY GATE — APPROVED (2026-10-05) and amendments
The CTO approved §5 with these rulings (they supersede any softer wording above):
1. **PPV approved.** GRNI is cleared only for the original GR/PO cost; the net price difference goes to the configured PPV account — **higher invoice ⇒ Dr PPV, lower invoice ⇒ Cr PPV**; inventory valuation never changes because of an invoice price; AP = invoice net before VAT (+ VAT = gross); no variance left in GRNI. **Both directions must be tested** (the lower case is not "the higher case with a different number").
2. **Input VAT account = the existing `tax_receivable` control account — no new configuration key.** It must resolve to **exactly one** active, postable, Company-correct account, otherwise **reject before mutation**; never auto-created, never a generic fallback.
3. **VAT data = explicit `taxAmount` from the supplier invoice.** No tax-code calculation, no automatic rate, no per-line VAT, no Tax Engine.
4. **VAT with no supplier VAT registration number ⇒ rejected before mutation.** The reason is *insufficient tax data*, not "non-recoverable": the system must not record VAT as recoverable on incomplete data. `taxAmount = 0` is allowed (VAT-free invoice).
5. **Void/cancel restores `quantityInvoiced` atomically** with the Supplier Ledger, AP and GL reversals — in D5 scope, with real-PG A/B proof (closed controller).
6. **Partial invoicing preserved**; PPV is computed per invoiced quantity/value, not again on the whole GR.
7. **Out of D5 (follow-ups, no change now):** credit/debit notes — the manual AP path with hard-coded default account `5299` is **not an approved accounting policy** and must not be read as one; supplier returns; tax-code calculation / per-line VAT / multi-currency; Tax Engine (stays ambient; making it Company-scoped is a prerequisite of any future automatic VAT).

## 11. Implementation (as built)
| Piece | Where |
|---|---|
| Columns: `supplier_invoices.taxAmount`, `receiptValueBase`, `ppvBase` (additive; NULL on legacy rows) | migration `procurement/1789910000000-AddSupplierInvoiceTaxAndVariance`; entity `SupplierInvoice` |
| Draft: explicit `taxAmount` (DTO `taxAmount?`), VAT-registration rule, receipt value (qty × PO cost) and signed PPV snapshot | `SupplierInvoiceService.createDraftInvoice`, `supplier-invoice.controller.ts` |
| Post: re-derive figures from the stored lines (receipt basis = qty × (billed cost − stored variance)); **pre-flight before any write**; ONE transaction: state + Supplier Ledger credit **gross** + event (`payloadVersion 2`: `receiptValueBase`, `ppvBase`, `taxAmount`, `grossAmount`) | `SupplierInvoiceService.postInvoice` |
| Pre-flight (bound through the existing foundation registry — no module cycle): `grni` + `ap` control accounts; configured PPV account when variance ≠ 0; **exactly one** `tax_receivable` when VAT > 0 | `InventoryPostingPolicy.assertSupplierInvoicePostable` (`InventoryPostingPolicyService`) |
| Journal: `Dr GRNI (receipt value) · Dr/Cr PPV · Dr Input VAT / Cr AP (net + VAT)`; legacy payload (no `receiptValueBase`) keeps the old shape | `handleSupplierInvoicePosted` (`supplier-invoice.handler.ts`); `HandlerContext.resolveUniqueControlAccount` |
| Void: mirror built from the ORIGINAL posted event's payload (legacy voids stay symmetric) | `handleSupplierInvoiceVoided` |
| Void/cancel = ONE transaction: ledger reversal + state + void event + `quantityInvoiced` restored (never below zero; integrity failure rolls everything back) | `SupplierInvoiceService.voidInvoice`, `restoreInvoicedQuantities` |
| Gross-aware remaining/status/aging (AP = Σ Supplier Ledger keeps reconciling) | `getInvoiceRemaining`, `recomputeStatus`, `computeAgingRow` |
| Config (fail-closed, default `''`) | `accounting.purchase_price_variance_account_code` (accounting manifest 1.18.0); Input VAT = existing `tax_receivable` control |
| UI | Supplier Invoices screen: VAT amount field + column; core terminology migration `1789920000000` (`field.vat_amount`) |

## 12. Verification (real PostgreSQL)
**Spec:** `domains/procurement/interface/supplier-invoice-ppv-vat.company-isolation.spec.ts` — **16/16**, real Company DBs A/B, real PO → Goods Receipt (real inventory + valuation) → Supplier Invoice → Supplier Ledger → outbox → posting gate → GL.

| CTO-required proof | Evidence |
|---|---|
| same price | `Dr GRNI 100 / Cr AP 100`, no PPV line, valuation unchanged |
| higher invoice | `Dr GRNI 100 + Dr PPV 10 / Cr AP 110` |
| **lower invoice** | `Dr GRNI 100 / Cr AP 90 + Cr PPV 10` (balanced; PPV in the credit direction) |
| VAT applicable | `Dr GRNI 100 + Dr Input VAT 14 / Cr AP 114`; Supplier Ledger credit 114, remaining 114 |
| CTO example | net 110 + VAT 15.40 → `Dr GRNI 100 + Dr PPV 10 + Dr Input VAT 15.40 / Cr AP 125.40` |
| VAT-free | no VAT line, no tax account needed |
| partial invoice | 4 @10 → `Dr GRNI 40 / Cr AP 40`; 6 @11 → `Dr GRNI 60 + Dr PPV 6 / Cr AP 66`; `quantityInvoiced` 10, GRNI 0; the 11th unit rejected |
| void/cancel restores quantity | posted void: ledger reversed, mirror journal `Dr AP 110 / Cr GRNI 100 + Cr PPV 10`, `quantityInvoiced` 10 → 0, re-invoiceable; draft cancel restores too; **all-or-nothing** (integrity failure rolls back state, ledger, outbox) |
| missing PPV account | unset / non-existent / control account ⇒ `postInvoice` rejected, snapshot of invoices/ledger/outbox/journals/quantities identical, state stays `draft`; no variance ⇒ not needed; restored ⇒ the SAME invoice posts |
| missing Input VAT account | none / ambiguous (two `tax_receivable`) ⇒ rejected before mutation; exactly one ⇒ posts |
| invalid VAT-registration condition | non-zero VAT on an unregistered supplier rejected at draft; registration removed after the draft ⇒ rejected at post — zero mutation |
| legacy shape | a pre-D5 posted event posts `Dr GRNI / Cr AP` at net and its void mirrors it |
| A/B + Platform | a full invoice post inside A never requests B's DataSource; B has 0 rows (invoices, ledger, POs, stock, valuation, events, journals, outbox); control-plane outbox 0; A's invoice through B's manager → not found |
| balanced journals · GRNI reconciliation · AP reconciliation | no unbalanced journal; **GL GRNI = GRNI subledger** (PO-cost basis, no residue); **GL AP = Σ Supplier Ledger** (gross); GL Input VAT and GL PPV equal the Σ of the posted invoices' stored `taxAmount` / `ppvBase` |

Closed-controller blast radius re-proved: `supplier-invoice`, `supplier-payment`, `goods-receipt`, `purchase-order`, `purchase-request`, `rfq-supplier` isolation specs; `inventory-posting` (D3), `manual-receipt` (D3-B), `returns-accounting` (D4, 12/12), `sales-returns`, `shipment-returns`, `warehouse-transactions`, `inventory`, GL/GRNI/WIP/event-engine specs, handlers unit spec, module-registry. Build clean; lint clean (D5 files); `tsc` clean for `src`.

## 13. Regression record (isolated seeded PostgreSQL — never `daii_dev`)
**Environment:** the disposable seeded cluster `127.0.0.1:5656` (254 migrations incl. D5's). A first full run was **discarded** (62 suites failed on `relation "user_roles" does not exist` — the harness reads migrations from `dist/`, which another session's `nest start --watch` kept rewriting mid-run). The accepted run uses the **same code** with `process.cwd()` pointed at a **stable snapshot** of `dist/` + `.env` + `package.json` (`jest-cwd`), which removes that race.
**One full run: 139 suites / 890 tests — 840 passed, 49 failed (7 suites), 1 skipped (opt-in T0).** Wording per CTO: **840/890 first run (+1 skipped); failures classified and individually cleared/isolated — not "clean".**

| Class | Suites | Disposition |
|---|---|---|
| Contention (60 s `beforeAll` AppModule boot under parallel load) | `attendance-biometric-import` (15), `work-order-phase3-e2e` (7), `commission-phase1` (10) | Re-run serially on the same DB: **32/32 PASS** |
| Environment-guarded by design (refuse to run unless `DB_PORT=5544`, the HR session's instance) | `provisioning-lifecycle`, `module-add-existing-company`, `limits-scope`, `ui-created-company-admin` (17 tests) | **Not executed by choice**; unrelated to D5 |
| D5-caused | none | — |

## 14. Known limits / follow-ups (disclosed)
1. **Configuration prerequisite:** `accounting.purchase_price_variance_account_code` must be set (postable, non-control) before an invoice **with a price variance** can post; Input VAT requires exactly one active postable `tax_receivable` account (the chart already has one). Invoices with no variance and no VAT need neither.
2. **Behaviour changes:** a non-zero VAT on an invoice from a supplier without a `vatRegistrationNumber` is now rejected; an invoice with a price difference is no longer silently buried in GRNI (it is rejected until PPV is configured); the Supplier Ledger/AP carry the gross.
3. A **draft** supplier invoice still counts as invoiced in the GRNI subledger (existing draft-time `quantityInvoiced` increment) — an un-posted draft shows as a GL-vs-subledger difference until it is posted or cancelled (pre-existing semantics; the cancel path now restores the quantity).
4. **Historical** voided invoices (before D5) never had their `quantityInvoiced` restored — not back-corrected here (follow-up data-repair decision).
5. **Follow-ups (not D5):** manual AP credit/debit notes (hard-coded `5299`; not an approved policy), supplier returns, tax-code driven VAT / per-line VAT / multi-currency, Tax Engine Company scoping; plus the four D4 follow-ups recorded in the D4 record.
6. Operational note: harness specs read `dist/database/migrations` from `process.cwd()` — a concurrent `nest build`/watcher can make provisioning fail with `user_roles does not exist`; run regressions from a stable `dist` snapshot (as above).

## Status
**D5 = IMPLEMENTED / INTEGRATED / REAL-PG VERIFIED / CLOSED (2026-10-05).** D6 has not been started.
