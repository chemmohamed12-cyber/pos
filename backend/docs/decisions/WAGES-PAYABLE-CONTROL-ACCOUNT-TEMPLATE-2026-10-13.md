# Wages Payable control account in the `ifrs-sme` chart template — documented fix scope and decision record (2026-10-13)

**Status: IMPLEMENTED → VERIFIED (real Postgres, author track; see §4). Not independently accepted. Production: HOLD.** Origin: WP-PAY-01 runtime finding (`evidence-clean-snapshot-2026-10-13/3bf740b-wp-pay-01/`), contract M0-6 "template completeness" and H0-4, CTO execution directive of 2026-10-13 (Phase B: "address the WP-PAY-01 results including the missing `wages_payable` and the rejected Financial Event, within a documented fix scope and suitable tests"). Pattern and precedent: the WIP fix H2 (`WIP-CONTROL-ACCOUNT-TEMPLATE-2026-10-06.md`).

## 1. Problem (measured, not assumed)
A freshly provisioned Company had no active postable account with `controlFunction = 'wages_payable'`. The ratified payroll posting handler (`payroll-run-posted.handler.ts`, ADR-070 §16) resolves that control account and, finding none, returns *rejected*: the `PayrollRun` reaches `posted` while its Financial Event is REJECTED and nothing reaches the ledger. Reproduced at runtime by WP-PAY-01 on a disposable database, and again red-first by the new spec on the unchanged template (4 of 8 tests failed).

## 2. Scope — what is and is not changed
| Changed | `ifrs-sme` template: one row `2150 Wages Payable` / «رواتب وأجور مستحقة», liability, credit-normal (derived), postable, non-contra, parent `21` Current Liabilities, `controlFunction = wages_payable`. The template is now 51 accounts |
|---|---|
| **Not changed** | the importer (still imports only into an empty chart, same account-count limit gate); the payroll handler and `PayrollService`; the Event Engine; the posting gate; the `ControlFunction` set; **any existing Company's data** (no migration into live charts: code `2150` may already be used there); the posting *shape* (gross only, no commission, no disbursement leg — PA-34/PA-35 are policy decisions of H0-4/DEC-03/DEC-04 and are **not** touched); `grni` and `fixed_asset` template items (same failure class, not named in this scope, still open) |
Why code `2150`: it is the code the earlier payroll fixtures and the earlier development database already used for this control account (`payroll-phase1.spec.ts` seeds exactly `2150 Wages Payable` under `21` only when no `wages_payable` account exists, so it does not collide), and it is free in the template (the liability block holds 2101, 2110, 2120, 2130). Account naming and numbering of a customer chart remain customer-owned after import (rename, re-code, deactivate).

## 3. Already-provisioned Companies (not changed here)
A Company whose chart was imported before this change still lacks the account. Documented recovery, verified by the new spec (cases B): create an account with control function `wages_payable` (or assign it to an existing liability account), then **re-drive** each REJECTED Financial Event; it posts at its original business date. Applying this to any existing Company (for example the development Companies) needs the owner's go; nothing was applied.

## 4. Verification (author track; commit and runs in the execution report)
New spec `domains/accounting/interface/wages-payable-control-account.company-isolation.spec.ts`: static template contract ×3; **A** fresh Company imports the template → exactly one active postable `wages_payable` account (2150, liability, credit, `functional_only`, `allowManualJournal = false`, parent `21`) and the real payroll handler posts `Dr 5201 / Cr 2150` for the run total, balanced, nothing else touched; **B** a chart that pre-dates the fix (2150 removed) still fails closed with the explicit reason and posts after the documented recovery; **isolation** A's and B's accounts are different rows with their own balances. Red first on the unchanged template (4 failed / 4 passed), green after (8/8) on the dedicated cluster through the guard. Added to the 92-spec isolation regression list. The WP-PAY-01 characterization spec was updated: on a freshly provisioned database the payroll Financial Event now POSTS.

## 5. Risks and open items
* The account is inert until payroll posts; the limit on the number of GL accounts (`accounting.max_gl_accounts`) applies to the template import, which is now one account larger — a Company limited to exactly 50 accounts can no longer import the template (the H2 change had the same effect at 50).
* The posting amount (gross only), the missing commission and the missing disbursement leg are unchanged and remain OPEN under H0-4.
* `grni` (2115) and `fixed_asset` remain hand-seeded or absent in fresh Companies; their scope is the CTO's (owner request C12).
* Independent review of this change: pending (no eligible reviewer).
