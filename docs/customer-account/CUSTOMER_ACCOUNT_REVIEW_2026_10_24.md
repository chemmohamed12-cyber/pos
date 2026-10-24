# Customer account & statement — current-state review, gaps and proposed design (for approval)

Date 2026-10-24 · base: `preview/shared-dev-2026-10-24` (`722fc73`, what 5173 serves) · work branch: `feature/customer-account-statement` · status: **review + design only — no application code changed yet; implementation starts after the design in §6 is approved** (brief §7 step 3).

## 1. What exists today (read from code, checked against live `daii_dev` data on 5173)

### 1.1 Financial engine (reuse, do not change)
| Piece | Where | Facts |
|---|---|---|
| Customer Ledger | `customer_ledger_entries`, `CustomerLedgerService` | Append-only sub-ledger. `direction` debit/credit + positive `amount`; types: sales_invoice, deposit, payment, payment_application, cod_collection, return_credit_note, debit_note, adjustment, opening_balance, refund. **Balance = SUM(debit) − SUM(credit) over ALL rows, no status filter** (a reversed row is cancelled by its own opposite row `reversalOfEntryId`). Never stored. |
| Entry links | same table | `invoiceId` (back-filled once from null by `sweepUnappliedFor`), `salesOrderId`, `depositId`, `paymentId`, `returnCreditId`, `shipmentId`, `treasuryTransactionId`, `reference`, `reason`, `entryDate`, `createdByUserId`. |
| Credit summary | `GET /customer-finance/credit-summary/:id` | balance, `creditLimit` (customer field), `availableCredit = limit − balance`, `overdueAmount` (invoices past `dueDate` with remaining > 0). |
| Invoices | `sales_invoices` (`totalAmount`, `dueDate` = invoice date + customer `paymentTermsDays`) | remaining per invoice = total − Σ applied credits (`getInvoiceRemaining`). |
| Aging | `GET /customers/:id/ar-aging`, `GET /ar-aging` | fixed buckets Current / 1-30 / 31-60 / 61-90 / 90+, per-invoice rows, computed with one query set per invoice. |
| Payments | `customer_payments` + `payments.controller` (`finance.payment.create`) | invoice payment, on-account payment, apply-to-invoice. |
| GL-side statement | `GET /accounting/ar/statement/:id` (`accounting.ar.view`) | thin wrapper over the same `listLedger` + credit summary. |
| Customer master | `customers` | `creditLimit`, `paymentTermsDays`, `taxRegistrationNumber`, `address`, `governorate`, phone. **No currency column anywhere in customer-finance** (single company base currency). |

### 1.2 Screens
`/customer-accounts` (list, balances) · `/customers/:id/account` (881 lines: ledger tab, invoices tab, aging tab, profile tab, plus action forms for invoice/payment/apply/credit) · `/customer-statement` (filters + table + CSV button + print link) · `/print/customer-statement/:id` · `/invoices`, `/payments`, `/ar-aging`. Navigation group already has: accounts, statement, invoices, payments, ar-aging.

## 2. Verified gaps (G = gap; evidence from code or live data)

| # | Gap | Evidence | Severity |
|---|---|---|---|
| G1 | **Period filter drops the last day.** `listLedger` compares `entryDate <= :to` with a bare date → everything on the `to` day after 00:00 is excluded. | Live: customer with 7 entries on 2026-10-22 and 1 on 2026-10-20; `from=to=<day>` returns **0** for both days. | **High** (wrong statements) |
| G2 | **No opening balance.** Statement/print compute the running balance in the browser starting from **0** over the filtered rows. Any `from` date shows a wrong running balance and wrong closing balance. | `CustomerStatement.tsx` (`let running = 0`), `CustomerStatementPrint.tsx` (`running: 0`). | **High** |
| G3 | **Technical English descriptions.** The description shown is the raw `reason` written at posting: `Customer deposit (cash)`, `Sales invoice posted`, `On-account payment (cash)`, `COD remitted (cash)`, `Payment (wallet)`, `Return credit applied to invoice`. Not translatable, no party/document context. | posting sites: invoices.service:301, payments.service:129/224/307, deposits.service:203, delivery.service:441, returns.service:667. | High (UX) |
| G4 | **Cash ↔ customer ledger mismatch after a one-sided Treasury reversal.** Treasury movement `TRS-IN-2026-000006` (payment 2.00 on INV-2026-000002) is *reversed* in Treasury, but customer ledger entry `CLE-2026-000007` and payment `PAY-2026-000003` stay posted → customer balance −14.00 although cash supports −12.00. The fix exists as a separate, unmerged line (`feature/treasury-integrity`: `CreateCustomerPaymentReversals`, already applied in `daii_dev`, **code not in the preview line**). | live data on 5173 (see §3). | **High — dependency (Case A)**: statement can only be correct once reversals propagate; until then it must at least *show* the discrepancy, never hide it. |
| G5 | **No statement document.** No statement number, issue date, period, company letterhead/tax data, customer tax id/address, page numbering/repeated header, PDF, Excel, EN/LTR. CSV is client-side, unlabeled, running balance from 0. | `CustomerStatementPrint.tsx` is a generic `DocumentPrint`. | High |
| G6 | **Running balance order not deterministic** for equal timestamps (`entryDate, createdAt` only; no id tiebreaker); computed in the browser. | `listLedger` order by. | Medium |
| G7 | **Authorization is thin.** `customer-ledger.controller` has `RequireModule('finance')` + customer scope but **no `PermissionGuard`/`RequirePermission`** (view/print/export/details are not separately gateable); invoices `GET`s likewise. | controller source. | Medium–High |
| G8 | **Indicators have no stated definition.** Header shows ledger balance, limit, available, overdue; "total sales", "payments", "returns" are not computed from one source; available credit ignores unapplied credits semantics (it is limit − net balance, which is fine) but overdue ignores unapplied credits (overstates overdue when the customer has unapplied receipts). | `getOverdueAmount`, `getCreditSummary`. | Medium |
| G9 | **Aging is hard-wired and slow.** Buckets fixed in code; one remaining/aging computation per invoice (N+1) for the all-customers screen. | `getArAging*`, `computeAgingRow`. | Medium |
| G10 | **Reversed rows are mixed in without separation.** Reversed original + reversal rows both appear (correct arithmetically) but the screen only dims them; no posted/reversed separation or subtotals. | `CustomerStatement.tsx` opacity 0.5. | Medium |
| G11 | No link from a row to receipt/payment/return/deposit/shipment documents (only invoice via `invoiceId`). | `onClick` only invoice. | Medium |
| G12 | Single-currency only; mixed currency cannot occur today but nothing states the statement currency. | no currency column. | Low (state the currency; no multi-currency totals) |
| G13 | The all-customers list/aging screens have no export; `/customers/:id/account` mixes dashboard, statement, invoices, aging and *write actions* in one 881-line page. | page structure. | Medium |

## 3. Live reconciliation performed (preview DB `daii_dev`, company Alpha, read-only API calls)
- 1 customer with ledger rows; balance endpoint = credit-summary = Σ ledger = **−14.00** (consistent inside the sub-ledger).
- Ledger: invoices 2 × 10.00 debit = 20.00; credits 34.00 (deposits 10+2, payments 10+2+2, COD 8) → −14.00.
- Treasury for the same customer: 5 posted receipts totalling 32.00, plus one receipt of 2.00 that is reversed together with its reversal leg → cash-supported credit 32.00 vs ledger credit 34.00; the 2.00 difference is exactly G4.
- Also visible in the data: a 10.00 deposit **and** a 10.00 on-account payment on the same order (SO-2026-000001) — both credited; data-entry/test pattern, not a code defect, but the statement must show both with their documents so the accountant can see it.

## 4. Reuse / change / new
- **Reuse unchanged:** the ledger engine and balance formula, posting services, invoice remaining computation, customer scope checks, credit fields on the customer.
- **Change (read side only):** `listLedger` period semantics (G1); aging bucket source and performance (G9); credit-summary extended with defined indicators (G8); permission gating on reads (G7).
- **New (read side only, no new posting, no schema change planned):**
  1. `GET /customer-finance/statement/:customerId` — period statement: opening balance (Σ of all entries **before** `from`, same formula), rows with deterministic order (`entryDate, createdAt, entryNumber`), server-computed running balance, period debit/credit totals, closing balance (= opening + debit − credit; asserted equal to the engine balance when `to` is open), posted vs reversed separation, document links, bilingual business descriptions, filters echo, discrepancy flags (G4).
  2. Statement export: PDF (server-rendered, letterhead, page numbers, repeated header, AR/EN + RTL/LTR), XLSX, CSV — same payload, same filters.
  3. Business description/label mapping from `entryType` + `reason` pattern + linked document (never invented; «غير محدد» when absent).
- **Statement number:** needs a persisted number sequence → *would need a numbering sequence row (data) and, to keep issued statements reproducible, an optional issued-statement log table (schema)*. **Decision needed (§7-D4).** Default proposal: no new table; statement reference = `ST-<customerCode>-<from>-<to>-<generatedAt>` generated at export time, clearly marked "generated, not an issued legal document".

## 5. Indicator definitions (proposed; each tied to its source)
| Indicator | Definition | Source |
|---|---|---|
| Current balance | Σ debit − Σ credit, all entries (positive = customer owes; negative = customer credit) | `getCustomerBalance` |
| Invoiced in period | Σ debit entries of type sales_invoice/debit_note in the period (posted rows, reversal legs excluded) | ledger |
| Collected in period | Σ credit entries of type payment/deposit/cod_collection in the period (reversal legs excluded) | ledger |
| Returns/credits in period | Σ credit of return_credit_note (+ refunds shown separately) | ledger |
| Open invoices / overdue | Σ remaining of invoices with remaining > 0 / those past `dueDate`; **overdue shown net of unapplied credit as a separate line, never silently** | `getInvoiceRemaining` |
| Unapplied credit (advance) | credits not linked to an invoice (`invoiceId IS NULL`) net of applications | ledger |
| Credit limit / available | customer `creditLimit`; available = limit − current balance; shown only when a limit is set; warning when balance > limit or overdue > 0 | customer + balance |
| Aging | per-invoice remaining by days past due; buckets configurable (default 0-30/31-60/61-90/90+) | invoices + ledger |
| Last invoice / last payment / next due | max `entryDate` of type, min future `dueDate` among open invoices | ledger/invoices |
Rule: sales ≠ collections ≠ outstanding; none of them is displayed without its definition tooltip.

## 6. Proposed screen structure (to approve) — reuse before create
| Screen | Decision |
|---|---|
| 1 Customer financial account `/customers/:id/account` | **Keep route, slim it** into the dashboard: customer card, KPIs (§5), aging donut/buckets, last movements, alerts, tabs → Statement · Invoices & payments · Aging · Credit & collection · Profile. Write actions (new invoice, payment, apply) stay but move into a clearly separated actions menu. |
| 2 Customer statement `/customer-statement` (+ print/PDF) | **Keep route, rebuild**: filters (period, branch if applicable, document status, entry type) → period statement from the new endpoint; opening/closing balance; export PDF/XLSX/CSV/print; EN/AR. This is the official document. |
| 3 Invoices & payments | **Reuse** `/invoices`, `/payments`; add the document-type link-outs from statement rows. No new screen. |
| 4 Aging & collection `/ar-aging` | **Reuse**, move aging to server-side bucketed query, configurable buckets, export. |
| 5 Movement details | **New side panel** (drawer) opened from any statement/dashboard row: source document, link, posting user/date, treasury movement, reversal chain, discrepancy flag. |
| 6 Credit & collection management | **Not a new screen**: a tab on the account page (limit, terms, due schedule, overdue list), editing limit/terms stays in the existing customer profile permissions. |
Visual direction: the supplied image (RTL, light cards, left info card + KPI strip, aging donut, filter panel + summary, details drawer) fits the existing DAII shell; no glass effects. The shell/header in the image (top search, theme/lang toggles, different sidebar grouping) is a separate global redesign and is **not** part of this task.

## 7. Decisions needed before implementation
- **D1** Approve the §6 structure (reuse routes, slim dashboard, rebuilt statement, drawer).
- **D2** G4 dependency: (a) bring `feature/treasury-integrity` payment-reversal propagation into the preview line first (recommended — Case A; it is already applied in the database), or (b) ship the statement now with a visible "cash reversed, ledger not reversed" discrepancy flag and leave propagation to that branch.
- **D3** Permissions: introduce `finance.customer_statement.view|print|export` (or reuse `accounting.ar.view`) for the read endpoints.
- **D4** Statement number: generated reference (no schema) vs persisted issued-statement log (new table + numbering).
- **D5** Aging buckets: fixed default 0-30/31-60/61-90/90+ with a company setting later vs configurable now.
- **D6** PDF generation: server-side (consistent output, needs a renderer dependency check) vs browser print-to-PDF.

## 8. Plan after approval
1. Backend read endpoints + `listLedger` fix + tests (real-PG needs an approved isolated cluster — currently unavailable; unit tests for the formula/ordering/opening-balance/reversal handling will run through the existing pure-spec mechanism and be labelled as such).
2. Frontend: statement screen, dashboard slimming, drawer, exports.
3. Browser acceptance on the shared preview (5173), screenshots + a printed sample statement (AR and EN).
4. Handover record for the consolidation team.

## 9. Not done / limits of this review
- No application code, schema or data changed. Live checks were read-only API calls on the one customer returned by the balances endpoint in Alpha; other companies were not inspected.
- Real-PG/jest tests cannot run (guard; isolated cluster 5546 down).
- The image is treated as a visual target, not as data.
