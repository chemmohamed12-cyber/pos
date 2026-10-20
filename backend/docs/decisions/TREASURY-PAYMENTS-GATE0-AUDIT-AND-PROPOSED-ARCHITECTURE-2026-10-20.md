# DAII Treasury, Payments & Financial Control — Gate 0 audit + proposed architecture (2026-10-20)

**Status:** Gate 0 submission (current-state audit) + Gate 1 *draft* (proposed architecture). **Documentation only.** No code, DB, migration, branch, version or deployment was changed. Nothing here is an approved accounting policy; every design item is tagged **[E]** existing behaviour, **[P]** proposed, **[U]** unresolved owner policy.

**Method and limits.** Code read at `main` (clean tree). Findings are from reading source, migrations, decision records and spec files. **I did not run any test, start any database, or open the UI in this pass**, so "verified" below means "a spec exists that asserts it" — not "I re-ran it". Prior-session evidence (D2 record, T-05/T-06/T-08, CUS-01) is cited as such. No stop-condition (duplicate posting, unbalanced journal, company-isolation breach) was *observed* in this read; two structural exposures that come close are flagged in §3 (G-03, G-04) and need a data check before Gate 1.

---

## 1. Current-state audit

Classification: **V** implemented and verified (spec exists) · **I** implemented, insufficiently verified · **P** partial · **M** missing · **R** design requires replacement.

| # | Capability | Class | Evidence (code → test) |
|---|---|---|---|
| 1a | Treasury accounts + account types (data-driven hierarchy, active/inactive) | V | `treasury/infrastructure/treasury-account*.entity.ts`, `treasury.service.ts:66-165` → `treasury.company-isolation.spec.ts` (6 tests) |
| 1b | Account → GL mapping, mandatory at first financial posting | V | `requireGlMappedAccount` `treasury.service.ts:165`; `D2-TREASURY-BANK-LEG-POLICY-2026-10-04.md` → `treasury-bank-leg.company-isolation.spec.ts` (7), `finance-handlers.bank-leg.spec.ts` (7) |
| 1c | Account currency, custodian, branch/location, permitted transaction types, limits, blocked state | **M** | Entity has only `code,name,accountTypeId,status(active/inactive),orgUnitId,glAccountCode`. Event currency is hard-coded `'EGP'` (`treasury.service.ts` emit helpers; `payments.service.ts` event) |
| 2a | Cash in / cash out (direct) | **R** | `POST /treasury/cash-in|cash-out`, `CashMoveDto` = `accountId, amount, customerId?, salesOrderId?, reference?, reason?` (`treasury.controller.ts:44`). No purpose/type, no source document; gated only by `finance:editable`; no approval; `movementDate = new Date()` (not user/period-validated) |
| 2b | GL effect of direct cash in/out | P | `handleCashRecorded` (`finance-handlers.ts:273`): Dr/Cr mapped bank vs configured **clearing** account `accounting.cash_movement_clearing_account_code` (fail-closed if unset). Not revenue — good — but it is an undifferentiated suspense; nothing classifies or clears it |
| 2c | Transfers between accounts | I | `transferCore` writes two linked legs under sorted advisory locks + `transferGroupId`; reversal reverses both. GL: `handleTransferCompleted` Dr to / Cr from. **Same-day, instant, single-step**: no in-transit state, no approval, no cross-currency; GL event only if *both* accounts mapped (else Treasury moves with no GL) |
| 2d | Idempotency of direct movements | V | `withIdempotencyInTransaction` (T-06x) → `t05-treasury.biz`, T-06 evidence. **Opt-in header** — a caller without `Idempotency-Key` gets no protection |
| 2e | Reversal of treasury movement | I | `reverseTransaction` `treasury.service.ts:897`: append-only reversal row + status flip + opposite GL event; re-check under lock (S5 fix). Reason required (`ReverseDto`). No approval, no SoD, any `finance:editable` user |
| 3 | Customer receipts vs AR | P | `PaymentsService.recordPayment` (one payment ↔ **one** invoice; `Payment.invoiceId`), on-account receipt + `applyPayment` partial apply (CUS-01 Option 1: Cr `ar`, unapplied credit in ledger). No multi-invoice allocation in one receipt, no discount/withholding/write-off, **no refund or reversal of a customer payment** (grep: none). Specs: `payments.company-isolation` (5), `on-account-payment` spec, `t08-payment-apply.biz` |
| 4 | Supplier payments vs AP | P | `SupplierPaymentService.recordPayment`: one payment ↔ one invoice, partial allowed, advisory lock per invoice, atomic with treasury leg (`:62-135`). No batch/proposal, no multi-invoice, no advance/prepayment, no approval, no reversal/return/cancel (grep: none), no cheque/bank-reference lifecycle. Spec: `supplier-payment.company-isolation` (6) |
| 5 | POS settlement, refunds, cash-drawer close | **M** | No POS/shift/drawer/session code exists (grep of `src` for drawer/shift/pos-session/cash-count: only terminology seed + event contract names). `delivery` COD: `collection.remitted` → Dr bank/Cr `ar` (ADR-042), `CollectionSettlements.tsx`; deposits: `deposit-control` approve → `createDepositTransaction` (no emit; GL via `deposit.verified`) |
| 6 | Payment methods / batches / approval workflows | **M** | `method` is a free `varchar(32)` on payment rows. No batch, no proposal. The generic approval engine exists and is used by cash/bank *adjustments* only (below) |
| 7 | GL posting via Financial Events, idempotency, reversals | V (platform) | Treasury publishes `treasury.cash.recorded` / `treasury.transfer.completed` through the outbox in the caller's transaction, key `treasury:txn:{id}:recorded` / `treasury:transfer:{group}:completed`; reversals use their own key + `reversalOf` |
| 7b | Operational row vs GL atomicity | **P — exposure** | Handler failure (unmapped-to-chart code, unset clearing account, closed period) leaves the **Treasury row committed and the event REJECTED** (D2 record "Residual, by design"; also deposits/collections). Treasury balance and GL then drift until someone re-drives. See G-03 |
| 8 | Fiscal periods / period lock | I | Enforced **only at journal posting** (`journal-entry.service.ts:352` `assertOpenForPosting`). Treasury/payment services do no period or date validation, so a closed-period movement is accepted operationally and fails later at the event |
| 9 | Bank statements, matching, reconciliation | **M (statement side)** | `CashBankReconciliationService` reconciles **Treasury ledger ↔ GL** per account (drift in SQL NUMERIC), read-only. **No statement entity, import, duplicate-file detection, matching rules or line status exist** (only `cash_bank_reconciliation_runs`). Today's "reconciliation" is internal-vs-internal, not internal-vs-bank |
| 9b | Bank fees / interest / opening balance / write-off | V-ish | `CashBankAdjustmentService` → FA-01 approval, kinds `bank_adjustment`, `opening_balance`, `unreconciled_write_off` (2 approvers), `reclassification`; threshold-gated; permissions `accounting.cash.{view,create,adjust,approve}`. `cash-flow-date-validation.company-isolation.spec.ts` exists. This is the only maker-checker flow in the domain |
| 10 | Permissions / SoD / audit / company isolation | P | Company isolation: strong — every path uses `req.companyContext.dataSource.manager`; A/B real-PG specs per controller. Audit: `AuditService.record` on every movement (action, resource, after). Permissions: **treasury controller uses the single node `finance:editable` for everything** — create account, set GL mapping, cash-in/out, transfer, reverse, status change — no separation of prepare/approve/execute/reverse. Customer payments `finance.payment.create`; supplier `procurement.supplier_payment.create`. No self-approval rule outside FA-01 |
| 11 | Screens | P | `TreasuryAccounts.tsx` (334), `TreasuryLedger.tsx` (306, generic cash-in/out form posting `{accountId, amount, reference, reason}` — the screen the directive criticises), `Payments.tsx` (128), `CollectionSettlements.tsx`, `accounting/CashBankReconciliation.tsx`, `TreasuryCover.tsx`, prints for deposit/collection/payment. No Treasury workspace/dashboard, no forecast |
| 12 | Reports | P | Ledger list (paged), balances (`getAllTreasuryBalances`, book balance only), cash-flow statement page, Cash/Bank↔GL reconciliation, AR↔GL reconciliation (`ar-reconciliation.service.ts`). Missing: cash book, bank book, receipt/payment registers with defined semantics, aging of unmatched, variance, custody |

**What is genuinely good and must be preserved [E]:** append-only ledger with computed balances; reversal-by-offset; per-account advisory locks with sorted ordering; mandatory GL mapping before posting with no `bank`-control fallback; transactional outbox; atomic receipt/payment + treasury leg + subledger; company isolation proven by A/B specs; maker-checker engine already wired for adjustments.

---

## 2. Answers to the directive's "non-negotiable principle" checks

| Rule | Today |
|---|---|
| Arbitrary cash movement must not silently become revenue / collection / settlement | **Not revenue** (goes to clearing account). But optional `customerId`/`salesOrderId` on a *direct* cash-in only tags the treasury row — it does **not** credit the customer ledger, so a user can label a receipt "customer X" with no AR effect (**G-02**) |
| Transfer is not income/expense | **Met [E]** (Dr/Cr both bank accounts) — but only if both mapped; otherwise operational-only |
| Bank deposit of cash creates no revenue | **Met by construction**, because no deposit-to-bank document type exists; it would currently be a transfer or a pair of clearing-account entries |
| Supplier payment must not double-expense | **Met [E]** (Dr AP / Cr bank at payment) |
| Approval before execution | **Not met**: cash-in, cash-out, transfer, reversal and both payment types execute on a single permission with no approval step |

---

## 3. Gap and risk matrix

Severity: **H** high · **M** medium · **L** low. Priority: P1 before any new feature, P2 core redesign, P3 enterprise.

| ID | Gap | Business risk | Accounting risk | Depends on | Sev | Prio |
|---|---|---|---|---|---|---|
| G-01 | Generic cash-in/out with no purpose, source document or approval | Unexplained money in/out; fraud surface for any `finance:editable` user | Accumulates in one clearing account with no clearing process | taxonomy, approval engine | H | P1 |
| G-02 | `customerId`/`salesOrderId` on direct cash-in is a label with no AR effect | Receipts "assigned" to customers but invoices stay open | AR subledger ≠ treasury attribution; misleading reports | receipt-to-AR flow | H | P1 |
| G-03 | Treasury row commits even when the GL event later rejects (closed period, unset clearing, bad chart code); no pre-validation of date/period | Treasury balance and GL drift silently until re-drive | Treasury↔GL drift; posting to wrong period if re-driven later | pre-mutation validation hook, period service | H | P1 |
| G-04 | Transfer/cash event emitted only when mapped; unmapped *transfer* moves cash with no GL (cash-in/out via contract callers too) | Operational balance without books | Hidden off-GL movement (D2 closed this for payments only) | extend D2 guard to transfer + direct | H | P1 — **needs data check** whether any unmapped account has movements in daii_dev/prod |
| G-05 | Single permission `finance:editable` for all treasury actions; no SoD, no limits | Preparer can also approve/execute/reverse | Control failure for audit | authz foundation (F1-F6) | H | P1 |
| G-06 | No customer-payment or supplier-payment reversal/refund/cancel | A wrong payment cannot be corrected except by hand-made treasury reversal that does not touch the subledger | Treasury reversed but AR/AP ledger and invoice status unchanged → subledger≠GL | linked reversal doc | H | P1 |
| G-07 | One payment ↔ one invoice; no multi-invoice allocation, no discounts/withholding/write-off | Real receivables/payables processes impossible | Workarounds distort | allocation entity | M | P2 |
| G-08 | No bank statement import / matching / unmatched aging | "Reconciled" only means Treasury=GL, not Bank=Book | No evidence cash exists | statement entities | H | P2 |
| G-09 | No cash count / drawer / shift / petty-cash / custody / POS | Cannot run cash-handling businesses | No variance accounting | custodian model, POS (out of scope today) | M | P2/P3 |
| G-10 | No payment execution lifecycle (pending/sent/confirmed/returned), no batch/proposal, no duplicate-payment detection beyond invoice-remaining | Payment "recorded" = "paid"; returns unmodelled | AP cleared before cash cleared | payment doc model | M | P2 |
| G-11 | Hard-coded `EGP`; no account currency/FX | Single-currency only | No FX gain/loss path for treasury | currency policy [U] | M | P3 |
| G-12 | Idempotency header opt-in on treasury UI routes | Double-click/retry duplicates | Duplicate journals (each is individually valid) | server-derived keys | M | P1 |
| G-13 | `movementDate = new Date()`; no back-dating policy, UTC date used for businessDate | Cairo 00–03h boundary (known defect class, see UTC business-date fix) | Wrong period near midnight | business-date policy | L | P2 |
| G-14 | No treasury workspace, forecast, available-vs-book, pending/approval views | Visibility | n/a | document model | M | P2 |
| G-15 | Free-text `method` on payments | Reporting by method unreliable | n/a | method master | L | P2 |
| G-16 | Test depth: treasury isolation spec 6 tests; no real-PG test for closed-period rejection of a treasury movement, no failure-injection for G-03 | Regressions undetected | — | — | M | P1 |

**Recommended first action (needs your decision):** G-03/G-04 are *data questions* before they are design questions: query each company DB for (a) treasury transactions with no matching journal (rejected events) and (b) movements on unmapped accounts. That is read-only SQL. I have not run it; it needs a database target.

---

## 4. Proposed architecture (Gate 1 draft — all **[P]** unless marked)

### 4.1 Principle: separate the seven acts
Introduce a **Treasury Document** layer *above* the existing append-only `treasury_transactions` ledger, which stays the execution record **[E]**. Documents carry purpose, source, approval; only an explicit *execute* creates ledger legs; only the existing Financial Event path posts GL. No second posting mechanism.

```
Document (draft→submitted→approved) ──execute──▶ treasury_transactions legs ──outbox──▶ Financial Event ──▶ Journal
         │                                              │
         └── allocations (AR/AP) ◀── same transaction ──┘       Bank statement line ──match──▶ ledger legs (reconcile)
```

### 4.2 Transaction taxonomy (data-driven, per directive §3.2) and accounting direction
Counter-account is **resolved from a posting profile per type** (config keys, fail-closed, never hard-coded). Codes below are *roles*, not account numbers.

| Type | Source document required | Dr / Cr (role) | Subledger effect | Approval default [U] |
|---|---|---|---|---|
| Customer collection | Invoice(s) or on-account | Dr bank-or-cash / Cr `ar` | AR credit, invoice remaining ↓ | none under threshold |
| Supplier payment | Supplier invoice(s) / advance | Dr `ap` / Cr bank | AP debit | payment proposal approval + execute step |
| Transfer cash↔bank/bank↔bank | none (pair) | Dr destination / Cr source (via *in-transit* role if confirmation required) | none | threshold |
| Bank deposit of cash / cash withdrawal | none (is a transfer, subtype) | as transfer | none | threshold |
| Other approved receipt | reason code + evidence | Dr bank / Cr profile account for reason code | none | **always** |
| Expense/employee disbursement | expense claim / payroll run | Dr profile expense or payable / Cr cash | payroll/employee | **always** |
| Petty-cash replenishment | custody fund | transfer to custody account | custody | threshold |
| Cash-count variance | closed count | Dr/Cr cash over/short role | variance record | **always** |
| Bank fee / interest | statement line | existing `bank_adjustment` flow **[E]** | none | existing threshold |
| Opening balance | — | existing flow **[E]**, always gated | none | existing |
| Refund / repayment | original receipt/payment | mirror of original | AR/AP reversal | **always** |

**Rule [P]:** no document type may name an arbitrary offset account; the direct `cash-in/cash-out` endpoints are retired from the UI immediately and from the API after a deprecation gate. Residual clearing-account balance becomes a monitored exception report.

### 4.3 Target domain model (additive)
- `treasury_documents` (type, number, status, company-scoped, purpose, amount, currency, accounting date, source refs, created/submitted/approved/executed by+at, `reversalOfDocumentId`).
- `treasury_document_allocations` (document → invoice/supplier-invoice/customer, amount) — enables one-to-many and many-to-one **[P]**; existing `Payment`/`SupplierPayment` rows become executed documents via backfill (compatible, no historical mutation).
- `treasury_account` gains: currency, custodian, allowed types, per-type limits, restricted flag (all nullable/defaulted — additive).
- `transfer` gains `in_transit` state with confirm step (optional by policy).
- `bank_statements`, `bank_statement_lines` (file hash unique per account → duplicate detection; opening/closing balance; status unmatched/suggested/matched/excluded), `bank_match` (line ↔ ledger leg(s), confidence, matched-by). Matching never auto-confirms ambiguous lines.
- `cash_counts` + `cash_custody_sessions` (open/close, expected vs counted, variance doc; closed sessions immutable except by linked reopen).
- Payment execution state separate from document state: `pending → sent → confirmed | rejected | returned` **[P]**; GL recognition of the liability settlement timing is **[U]** (at execute vs at confirm).

### 4.4 Lifecycle
`Draft → Submitted → Approved → Executed → (Confirmed) → Reconciled → Closed`; policy table per type declares which stages apply and whether *execute* and *post* are one atomic step (default: yes, same transaction — satisfies invariants 2–4). Posted documents are never edited; correction = linked reversal/adjustment document **[E principle, P mechanism]**.

### 4.5 Authorization matrix [P] (permission nodes to be created; none exist today beyond `accounting.cash.*`)
| Action | Preparer | Approver | Executor | Reverser | Reconciler |
|---|---|---|---|---|---|
| Customer collection | `treasury.receipt.create` | threshold only | same as preparer under limit | `treasury.receipt.reverse` + approval | `treasury.reconcile` |
| Supplier payment | `treasury.payment.create` | `treasury.payment.approve` (≠ preparer) | `treasury.payment.execute` (≠ approver where risk) | approval | `treasury.reconcile` |
| Transfer | `treasury.transfer.create` | `treasury.transfer.approve` | execute | approval | — |
| Misc receipt / disbursement | create | approve (always) | execute | approval | — |
| Account master / GL mapping | `treasury.account.manage` (separate from all of the above) | second approver [U] | — | — | — |
Platform-level roles never imply any of these (consistent with F4 PlatformGuard **[E]**). All checks server-side; SoD "approver ≠ preparer" enforced in the approval engine, which already supports min-approvers **[E]**.

### 4.6 Workflows (summary)
- **Receipt:** choose purpose → pick customer → system lists open invoices with remaining → allocate → preview Dr/Cr + subledger effect → submit → (approve if over threshold) → execute: ledger leg + allocations + invoice recompute + event in one transaction; Idempotency-Key server-issued with the draft.
- **Payment:** proposal (due-date, terms, limits) → approval → explicit *execute* (never on save) → bank reference → confirm/return → reconcile.
- **Transfer:** initiate → approve → execute (out leg → in-transit) → confirm (in leg) or reject/cancel; reversal pairs both legs.
- **Cash closure:** open session with float → movements accrue → count → variance document (approval) → close → controlled reopen only.
- **Bank reconciliation:** import (hash-dedup) → auto-suggest by amount/date/reference → human confirm → unmatched aging → fees/interest via existing adjustment flow.

### 4.7 UX [P]
One **Treasury workspace** at `/treasury` (replacing the cover): book balances per account, pending approvals, transfers in transit, unreconciled count, exceptions (rejected events, clearing-account balance, drift), cash-count discrepancies. "New transaction" asks **purpose first**, then renders the purpose-specific form with an accounting-effect preview (visible to users holding the view-accounting permission). Existing visual language and routes kept; `TreasuryLedger` stays as the read-only ledger view. A first UI prototype can be shown on the existing preview (`:5173`) without merging, **after** Gate 1 approval.

### 4.8 Migration and rollback
All migrations additive (new tables, nullable columns). Backfill creates executed documents for existing receipts/payments/deposits/collections by reference only — no change to ledger rows, journals, balances or numbers. Rollback limitation: once documents are executed through the new path, rollback to the old UI loses the document view but not financial truth (ledger and journals unchanged). Reconciliation checks: before/after Treasury balance per account, AR/AP totals, journal counts, drift = 0.

### 4.9 API/service contract rules [P]
Server-issued idempotency key per document; single transaction (document + legs + allocations + outbox); advisory locks per account and per invoice/supplier-invoice (existing pattern); pre-mutation validation of accounting date vs fiscal period, mapping, company ownership of every referenced id; 409 for state conflicts with actionable messages; optimistic version column on documents.

### 4.10 Verification matrix
Maps one-to-one to directive §11. Gap today: of its 17 scenarios, covered by existing specs at least partly — single-invoice customer/supplier payment, partial payments, idempotency, company isolation, reversal, treasury↔GL drift detection. **Not covered:** multi-invoice allocation, self-approval, closed period at the treasury layer, failed-posting rollback (G-03), cash count, statement import/matching, fees/FX/rounding, AR/AP/Treasury/GL triple reconciliation. Real-PG tests on disposable databases only; the shared cluster state must be checked before any run.

### 4.11 Phased plan (each phase gated; none authorized)
- **Phase T0 (read-only, proposed next):** data check for G-03/G-04 on a disposable restore or a company DB you name; confirm no stop-condition.
- **Phase T1 — Control hardening of existing behaviour:** pre-mutation period/date + mapping guard for all treasury paths (closes G-03/G-04), server-side idempotency, split permissions (G-05), customer/supplier payment reversal linked to subledger (G-06), tests for each (G-16). No new UI.
- **Phase T2 — Document layer + taxonomy + allocations + workspace + transfer in-transit.**
- **Phase T3 — Bank statements and matching; cash custody/count/shift.**
- **Phase T4 — Payment batches/execution lifecycle, FX, forecast, consolidated views.**

---

## 5. Unresolved owner policies [U] (needed before Gate 1 can close)
1. Payment liability settlement: GL at *execute* or at bank *confirm*? In-transit account role?
2. Approval thresholds by type/amount/currency; who may self-approve under threshold.
3. Counter-account roles per "other receipt/disbursement" reason code (the chart accounts must be named by the accounting owner, not by us).
4. Retire direct cash-in/out immediately or keep a restricted, approved, always-gated "miscellaneous" type.
5. Back-dating and accounting-date rules; Cairo-timezone decision (still open from the UTC business-date fix).
6. Multi-currency scope for treasury (single functional currency EGP assumed today).
7. POS / cash-drawer: is this module in product scope now (no POS code exists)?
8. Customer-advance Option 1 vs 2 (CUS-01) interacts with receipt design; Option 1 was implemented.
9. `R1` Treasury-owner request (payroll disbursement instrument) is still PENDING (`REQUEST-TREASURY_OWNER.md`).

## 6. Not verified in this pass (disclosed)
Specs not re-run; UI not opened; delivery COD and payroll disbursement paths read only at the contract/handler level; no check of existing production/dev data; migration files not individually diffed against the entity definitions; the claim "no reversal exists for customer/supplier payments" rests on a grep of `src/domains` for reversal/void/refund names and on the two services' method lists.
