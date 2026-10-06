# CUS-01 — On-account / advance customer payment (Decision Record, 2026-10-06)

**Status: CLOSED (2026-10-06) — IMPLEMENTED / REAL-PG VERIFIED (Option 1, CTO-approved). Browser verification NOT PERFORMED.**
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


## 5. CTO decision (2026-10-06): Option 1 — reuse the existing AR control architecture
On-account / advance payment allowed; **Dr mapped bank / Cr the existing `ar` control**, unapplied credit in the Customer Ledger (`invoiceId = NULL`); "Customer Advance / Unapplied Receipt" is a presentation label only (no GL reclassification). Settlement: `sweepUnappliedFor` (automatic) and an explicit apply (partial supported, ledger append-only). **Forbidden:** a new advances GL account, any AR-reconciliation change, moving Deposit/COD to a new architecture. Fail closed before any mutation: Treasury account GL-mapped; customer ownership matches; amount > 0; amount <= unapplied balance; amount <= invoice outstanding.

## 6. Implementation
| Piece | Where |
|---|---|
| `PaymentsService.recordOnAccountPayment` (customer Scope + optional sales-order ownership check, D2 mapped-account check, Treasury `cash_in`, Payment row `invoiceId = NULL`, unapplied `payment` credit, the SAME `finance.payment.recorded` event → Dr bank / Cr `ar`) | `customer-finance/application/payments.service.ts` |
| `applyPayment` (advisory locks on payment + invoice; two NEW ledger rows of type `payment_application`: a debit taking the amount out of "unapplied" and a credit onto the invoice — net customer balance and GL unchanged, the original row is never modified); `getUnappliedBalance` (derived sum credit−debit of the payment's rows with no invoice); `listUnappliedPayments` | same |
| Sweep guard: `sweepUnappliedFor` never sweeps the remainder of a payment that already has explicit applications (no double application) | `customer-ledger.service.ts` |
| `InvoiceService.assertSalesOrderOfCustomer`; new ledger entry type `payment_application` (domain + finance contract union) | `invoices.service.ts`, `customer-ledger-entry-type.ts`, `finance.contract.ts` |
| Routes (Company-scoped, permission `finance.payment.create`): `POST payments/on-account` (idempotency key supported), `POST payments/:id/apply`, `GET payments/unapplied?customerId=` | `customer-finance/interface/payments.controller.ts` |
| Schema: `customer_payments.invoiceId` nullable + optional `salesOrderId` | finance migration `1789991000000`, `payment.entity.ts` |
| UI: "Customer advance / unapplied receipt" card on the Customer Account screen (record on-account payment, unapplied list, apply to an open invoice); Payments list shows on-account rows; terminology | `CustomerAccount.tsx`, `Payments.tsx`, core migration `1789992000000` |
No new GL account, no config key, no change to AR reconciliation, deposits or COD.

## 7. Verification (real PostgreSQL, isolated seeded cluster; real GL pipeline)
Spec `customer-finance/interface/on-account-payment.company-isolation.spec.ts` — **7/7**: (1) on-account receipt → `1102 D` / `1110 C` (the existing ar control), unapplied credit, invoice untouched; (2) amount <= 0, unmapped treasury account, another customer's sales order, unknown customer → rejected with ZERO treasury/payment/ledger/event/journal/outbox rows; (3) explicit PARTIAL apply (200 of 500): exactly two new ledger rows, original row identical, invoice partially_paid, customer balance and GL unchanged, then the remainder; (4) rejections before mutation: > unapplied, > invoice outstanding, <= 0, another customer's invoice, a paid invoice, unknown payment, an invoice-bound payment (nothing unapplied); (5) automatic sweep settles a payment earmarked to an order when its invoice is posted, and a partially applied receipt is NOT swept; (6) **AR reconciliation:** Customer Ledger total = GL `ar` (1110) balance (−2250 = −2250) including unapplied credits and applications; **Treasury reconciliation:** account balance movement = GL bank-leg (1102) debits; every financial event POSTED; (7) A/B isolation — B posts only in B, A's payment/invoice ids are 404 for B, A unchanged, B's DataSource never requested for A's calls, Platform DB outbox empty.
Backend and frontend `tsc` clean; eslint clean on touched backend files; `oxlint` only the pre-existing load-effect warnings on the two pages.

**Regression — worded exactly (isolated seeded PG, serial):**
- Run 1 (32 suites touching customer ledger / payments / invoices / AppModule): the first attempt failed EVERY harness suite — a genuine defect of mine (a terminology text over 255 chars broke the control-plane migration); fixed, rebuilt, re-run. Re-run result: **167/201 first run (+1 skipped), 8 suites failed**: 4 with missing-schema errors that **cleared individually** in the next run (accounting.company-isolation 5/5, customer-ledger 5/5, payments 5/5, database-provisioning 4/4), and 4 that need other sessions' newer manufacturing migrations the isolated ambient DB does not have (`wip-reconciliation`, `work-order`, `work-order-phase3-e2e`, `f03-deadlock-retry-verification`: `BillOfMaterial.status` then `routings` missing — adding the BOM column alone only moved the error to `routings`). None caused by CUS-01.
- Run 2 (an unintended full run of all 150 suites on the isolated PG): **948/981 passed (+1 skipped), 9 suites failed, none caused by CUS-01**: the 4 manufacturing/WIP suites above (stale ambient schema); `bom.company-isolation` 1 test (the BOM read now returns `unit: null` — another session's change in the tree; the spec expectation is stale; it passed 7/7 earlier today before that change); 4 HR/provisioning-guarded `*.characterization.spec.ts` suites that refuse to run unless `DB_PORT=5544`. All customer-finance, treasury, deposits, delivery, returns, reports and procurement suites passed in that run.

## 8. Known limits / follow-ups
Deposit and COD unapplied credits still settle only through the existing invoice-post sweep (not the new apply route) — out of scope by decision. An unknown customer id surfaces the existing customer lookup's own not-found error (same as `recordPayment`). Browser verification NOT PERFORMED. The failing/stale suites listed above need their owners (other sessions).

## Status
**CUS-01 = CLOSED (2026-10-06).**
