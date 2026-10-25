# Financial decisions awaiting the CTO — recommendations with impact and acceptance tests (2026-10-25)

Scope: the six financial points of the CTO order. **Nothing here is approved.** For each point: what the code does today, the recommendation, the alternatives, the effect on data / ledger entries / disbursement, and the acceptance tests that would close it. No new financial assumption was implemented to make a test pass; where a point is undecided, the code takes the conservative, documented behaviour listed under «Today».

Evidence base: branch `feature/hr-payroll-gap-closure`, browser acceptance record `evidence-browser-2026-10-25/`, regression logs `evidence-regression-2026-10-25/`.

---

## F-1 Commission adjustments: available without an independent approval?

**Today.** `commission.adjustment.create` records an immutable adjustment (non-zero exact decimal, reason required). The first open run consumes it exactly once (`payroll_input_consumptions`, unique live source) and the amount appears in the run's «inputs» panel and in `adjustmentsAmount`. The only independent control is the run's own approval (approver ≠ preparer ≠ submitter). The adjustment's author is **not** required to differ from the run's preparer, and a single user can create a positive adjustment that is paid in the next run.

**Recommendation (R-F1).** Treat an adjustment as consumable only after a second person approves it, by the existing generic approval engine (request type `commission.adjustment_approval`); the author may not approve their own. Cheap, no new table beyond a status column, and it removes the one single-person path to a payment.

**Alternatives.** (B) Threshold: no approval below an amount set per Company, approval above it. (C) Keep today's behaviour and rely on the run approval, accepting that the approver sees adjustments only as a total line.

**Impact.** Data: `commission_adjustments.status` (`pending` / `approved` / `rejected`). Entries: none change (adjustments already flow into `totalExpense`). Disbursement: an unapproved adjustment is simply not in the run, so nothing is paid on it.

**Acceptance tests.** (1) author cannot approve own adjustment; (2) pending adjustment is not consumed and is listed as an exception; (3) approved adjustment is consumed once, by one run only, under two concurrent calculations; (4) rejected adjustment is never consumed; (5) negative adjustment reduces `totalExpense` and the payable by the same amount.

**State:** PROPOSED. Not implemented (would change the commission adjustment contract).

---

## F-2 Journal basis: Dr 5201 / Cr 2150

**Today.** `payroll.run.posted` → Dr `5201` Salaries & Wages Expense = `totalExpense` (gross + approved commission + adjustments); Cr the `wages_payable` control account (2150 in the template) = `totalNet`. Deductions are not modelled; if a run carries any, the handler **rejects** the event rather than guess a split. Supplementary runs post the delta and may be negative. Browser check: runs of 20,000.00 and 1,000.00 produced 5201 Dr 21,000.00 = 2150 Cr 21,000.00.

**Recommendation (R-F2).** Keep one expense account for gross + commission for the first release, one payable account, and **no** deduction line until the deductions rule exists. Add a Company-level setting only when a separate commission expense account (e.g. 5202) is actually wanted; the handler already resolves accounts through the template, so this is a template/configuration change, not a code rewrite.

**Alternatives.** (B) Separate commission expense account from day one. (C) Accrue to payable at gross and post deductions to liability accounts — blocked by F-6 (no deduction rule).

**Impact.** Data: none. Entries: (B) adds one debit line per run. Disbursement: none; payouts settle `wages_payable` regardless.

**Acceptance tests.** Journal balanced per run and per revision; sum of expense debits = sum of run totals; payable credit = Σ net; supplementary negative delta posts reversed sides; a run with a deduction is refused (no partial posting); chart without a `wages_payable` account leaves the event rejected and visible.

**State:** IMPLEMENTED for the basis above and VERIFIED on real PostgreSQL and in the browser; **APPROVAL of the basis itself pending.**

---

## F-3 Entry date at approval

**Today.** The journal entry's business and posting date is the **date of approval** (2026-10-25 in the browser run), not the period end (2026-10-31, which was in the future). A run approved after the period closes in accounting is refused by the fiscal-period gate; the event stays rejected and can be re-driven after the period is reopened.

**Recommendation (R-F3).** Accrual by period: date the expense entry at the **period end date** (or the approval date when later), so a month's payroll lands in that month even if approved in the next. Needs the open fiscal period check to run on the period end and a documented late-approval rule (period already closed → approval date).

**Alternatives.** (B) Keep approval date (simple, today). (C) Approver chooses the date inside the open period.

**Impact.** Data: event payload carries `businessDate`. Entries: month-end reports include the payroll expense in the right month. Disbursement: none.

**Acceptance tests.** Run for period ending 31st approved on the 3rd of next month → entry dated 31st when the fiscal period is open, rejected-and-visible when closed; supplementary run of a closed payroll period → dated at its approval date; timezone boundary cases are blocked on F-6.

**State:** PROPOSED. Today's behaviour VERIFIED but **not approved** as the accounting policy.

---

## F-4 Returning money already paid

**Today. NOT IMPLEMENTED.** A payout item that is `paid` cannot be returned; a failed item before payment is kept as history and its remainder re-issued. There is no contract for cash coming back (bank rejection after settlement, overpayment recovery). The Treasury cash-in used by other domains is non-emitting and has no payroll semantics.

**Recommendation (R-F4).** Return = new item state `returned` created through a Treasury **reversal of the original cash-out** (the existing `transactions/:id/reverse` path) that emits `payroll.payout.returned`; handler posts Dr 1102 (treasury-mapped account) / Cr `wages_payable`, restoring the payable, after which the remainder can be re-issued as a new item. Requires the CTO to confirm that a Treasury reversal is allowed for a payroll cash-out and who may do it (SoD stage `reconcile`).

**Alternatives.** (B) Manual journal entry by accounting, outside the payroll module. (C) New Treasury «cash-in with payroll reason» without reversing the original.

**Impact.** Data: item state + link to the reversing transaction. Entries: one balanced return entry per returned item. Disbursement: payable outstanding increases again; reconciliation continues to equal.

**Acceptance tests.** Full and partial return; return of an item already returned (refused); reconciliation after return and re-issue (paid = net, outstanding 0); closed fiscal period → rejected-and-visible; Company isolation of the reversal.

**State:** PROPOSED — **BLOCKED** on the Treasury reversal decision. Not implemented.

---

## F-5 SoD policy and waiver

**Today.** Stage actors are recorded per run and enforced on the server for every route that reaches a stage, including the generic approvals route.
- Mandatory floor (every profile): approver ≠ preparer, approver ≠ submitter.
- `standard` (default): floor + exception acknowledger ≠ preparer + disburser ≠ approver.
- `strict`: all of the above + preparer, reviewer, submitter, approver, acknowledger pairwise different + reconciler ≠ disburser.
- `minimal` profile and waivers: **not implemented**. Refusals are audited (`payroll.sod.refused`, result `denied`) and returned as `SOD_VIOLATION` (localized in the UI).
Browser: preparer acknowledging own run refused; submitter approving refused; reject → resubmit → approve by a third person accepted.

**Recommendation (R-F5).** Keep `standard` as the default. Offer `strict` per Company. Do **not** build a waiver mechanism until a Company actually has fewer than four people able to act; if one is needed, a waiver must be (a) per run, (b) approved by a role outside the run's actors, (c) reason and approver recorded in the audit, (d) never applicable to the floor.

**Alternatives.** (B) Allow `minimal` for small Companies with a logged acknowledgement. (C) Single global profile.

**Impact.** Data: `payroll_settings.sod_profile` (exists); waiver would add a table. Entries/disbursement: none directly — fewer people can complete a payment cycle under `minimal`.

**Acceptance tests.** Every rule row refused in its profile and accepted in the profiles that do not list it; direct API/approvals-route bypass attempts; profile change audited; last-admin and anti-elevation rules unaffected.

**State:** IMPLEMENTED (standard/strict) and VERIFIED (real PG, browser). Policy and waiver **not approved**.

---

## F-6 Deductions, calendar, timezone

**Today.** Deductions of any kind are **not modelled** and a run carrying one is refused by the posting handler; attendance coverage is a documentation exception (`NO_ATTENDANCE_COVERAGE`) and unpaid-leave/holiday handling is absent; business dates use the UTC-day helper, with the move to the Cairo calendar day still an open CTO decision (00–03h false drift).

**Recommendation (R-F6).** Decide in this order: (1) timezone — a single Company timezone setting, stored once, used for every business-date derivation; (2) holiday calendar — a Company calendar table with weekly rest days and dated holidays, read by attendance and payroll; (3) deductions — each deduction type as a ratified rule (statutory, advance, penalty) with its own liability account, never a free-text amount. Until then keep refusing rather than computing.

**Alternatives.** (B) Ship without deductions and handle them as signed adjustments (they would be paid net with no liability account — not recommended). (C) Fix timezone to Cairo globally.

**Impact.** Data: new calendar and deduction tables. Entries: each deduction type adds a credit to its liability account and lowers the payable. Disbursement: net pay falls by the deduction.

**Acceptance tests.** Business date at 23:30 and 00:30 Cairo time lands on the right day; holiday inside a period changes the expected working days; each deduction type posts a balanced entry, lowers the payable and reconciles; a run with an unmapped deduction account is refused before approval.

**State:** BLOCKED (owner decisions D-06 / H0-2). Nothing implemented beyond the refusal.
