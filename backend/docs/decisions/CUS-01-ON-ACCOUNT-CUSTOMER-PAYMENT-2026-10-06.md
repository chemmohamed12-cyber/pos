# CUS-01 — On-account / advance customer payment (Decision Record, 2026-10-06)

**Status: DECISION RECORD WRITTEN — one accounting question for the CTO before code (§4). No code written.**
CTO decision received: on-account / advance customer payment is ALLOWED (B); money received before an invoice is a **Customer Advance / Unapplied Receipt**, "not AR and not revenue", with a clear settlement path to a later invoice; examine the existing accounting/ledger model, use the *exact existing* GL mapping, no invented account, no fallback.

## 1. Evidence — what the existing model already does (code read)
| Fact | Where |
|---|---|
| A customer payment REQUIRES an invoice (`invoiceId` mandatory; overpayment rejected — "credit on account is future work") | `customer-finance/application/payments.service.ts`, DTO in `payments.controller.ts`, `customer_payments.invoiceId NOT NULL` |
| `finance.payment.recorded` → **Dr bank (the Treasury account's mapped GL) / Cr `ar` control** | `handlePaymentRecorded` |
| **Money received before an invoice ALREADY exists today** — a verified customer **deposit** (`deposit.verified`) and a remitted **COD collection** (`collection.remitted`) → **Dr bank / Cr `ar` control** (ADR-042 D1/D2/D9), and the Customer Ledger gets an *unapplied* credit (`invoiceId = NULL`) | `handleDepositVerified`, `handleCollectionRemitted`, `CustomerLedgerEntry.invoiceId` doc |
| Settlement path today: `InvoiceService.postInvoice` → `CustomerLedgerService.sweepUnappliedFor(customer, salesOrder, invoice)` sets `invoiceId` on the unapplied credits of that customer + **sales order**; `getInvoiceRemaining` = gross − Σ(credit − debit) of entries carrying the invoice id; `recomputeStatus` advances `posted → partially_paid → paid` | `customer-ledger.service.ts`, `invoices.service.ts` |
| AR sub-ledger ↔ GL reconciliation compares the Customer Ledger **total** (unapplied credits included) with the GL `ar` control balance | `ar-reconciliation.service.ts` → `getAllCustomerBalances` |
| The chart's control functions are `ar, ap, bank, inventory, tax_payable, tax_receivable, retained_earnings, fx_gain_loss, rounding, fixed_asset` — **there is NO customer-advance / unearned-receipts control function and no configured account for it** | `ChartOfAccounts.tsx` / `gl-account` control functions |

**Conclusion:** the "exact existing GL mapping" for customer money received before an invoice is **Dr (mapped bank) / Cr `ar` control**, with the unapplied credit visible in the Customer Ledger — i.e. the existing model treats it as a *credit balance inside the single AR control*, not as a separate liability account. A separate "Customer Advances" account does not exist and cannot be used without creating one (forbidden to invent).

## 2. The conflict that needs a ruling
The CTO wording ("not AR") and the existing ADR-042 mapping (Cr `ar`) disagree on the GL leg. Both options keep the same operational feature; they differ only in the credit account:

| | **Option 1 — reuse the existing ADR-042 mapping (recommended)** | **Option 2 — a distinct Customer Advances liability account** |
|---|---|---|
| GL on receipt | Dr bank / Cr `ar` control — identical to a deposit | Dr bank / Cr *new configured liability account* (config key, e.g. `accounting.customer_advance_account_code`, mandatory, fail-closed — same pattern as D4/D5 config) |
| Account invented? | **No** | A new account **code must be chosen by the CTO/accounting owner** (a config value; not defaulted) |
| On later settlement against an invoice | **No GL entry** — the credit already sits in AR; the invoice debit and the receipt net inside `ar` | A GL **reclass** journal Dr advances / Cr `ar` at application time (new posting, new event, new failure modes) |
| AR sub-ledger ↔ GL reconciliation | Unchanged — reconciles | **Breaks** unless the reconciliation is changed to exclude unapplied credits from the sub-ledger total (or to add the advance account to the compared total) — touches closed AR/closing code |
| Consistency with today's deposits / COD | Same treatment for every pre-invoice receipt | Deposits and COD would stay in AR while payments go to advances — **two policies for the same event class** (the exact inconsistency TRS-02 / D2 removed for banks) unless deposits/COD are migrated too |
| Reporting | "Customer advance / unapplied" shown in the Customer Account screen and aging as credit balances (read-model labelling, no GL change) | Balance sheet shows advances as a separate liability line |

## 3. Design that is identical under both options (nothing here needs the ruling)
1. `POST customer-payments` accepts an on-account payment: `invoiceId` optional; with no invoice a **`customerId` + optional `salesOrderId`** is required. `customer_payments.invoiceId` becomes nullable (migration); `Payment` row, Treasury `cash_in` (mapped account required — D2 rule, rejected before mutation) and a Customer Ledger **`payment` credit with `invoiceId = NULL`** (unapplied) are written in one transaction, exactly like a deposit.
2. Settlement ("apply to invoice"): (a) automatic — the existing `sweepUnappliedFor` already applies unapplied credits of the same customer+order when the invoice is posted; (b) explicit — a new `POST customer-payments/:id/apply` (`invoiceId`, `amount ≤ unapplied remainder ≤ invoice remaining`) that sets the link through the same single narrow backfill the ledger already documents, partial application splitting the entry into applied + remainder rows so the ledger stays append-only; invoice status recomputed.
3. Fail closed before mutation: unmapped treasury account, invoice of another customer, amount above the unapplied remainder or the invoice's remaining, reversed/zero amounts.
4. UI: Payments screen "on account" mode, unapplied-receipts list per customer, apply action.
5. Real-PG proof (A/B, reconciliation: ledger total vs GL `ar`), regression of customer-finance / treasury / deposits / AR reconciliation suites.

## 4. Question for the CTO (single)
**Option 1 or Option 2?** Recommendation: **Option 1** — it is the only one that uses an existing mapping (no invented account), keeps the AR sub-ledger ↔ GL reconciliation green, and treats payments, deposits and COD identically; "Customer Advance / Unapplied Receipt" is then how the screens and aging present the credit balance. If Option 2 is chosen: name the liability account to configure, and approve changing the AR reconciliation + migrating deposits/COD to the same account (otherwise two policies coexist).

Until answered, CUS-01 stays OPEN; FA-02 proceeds.
