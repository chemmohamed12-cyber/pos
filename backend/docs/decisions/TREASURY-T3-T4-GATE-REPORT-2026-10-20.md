# Treasury program — T3 gate report (documents & workflows) and T4 status (workspace UI) — 2026-10-20

Branch `feature/treasury-integrity`; T2 = `548255a`. Real-PG runs on the dedicated cluster 5546 (`biz_t66_`…`biz_t69_`), coordinated with the Procurement session. `daii_dev`, the company databases on 5433 and every other worktree were not touched (a request to create cloned databases on 5433 for a browser check was refused by the permission layer and was **not** worked around — see §5).

## 1. T3 — scope delivered / not delivered

| Required workflow / control | Status |
|---|---|
| Customer collection to one or **several** invoices, with optional unapplied remainder (customer advance) | **Done** — `PaymentsService.recordCollection` via `FINANCE_COLLECTION_CONTRACT`; one Treasury cash-in, one payment, N ledger credits (+1 unapplied), **one** GL event, status recomputed per invoice |
| Supplier payment and allocation to one or several invoices | **Not done here — owned by Procurement** (their branch already implements it; not merged; reuse will follow the merge, see T2 report §5) |
| Cash↔bank, bank↔cash, bank↔bank transfers; bank deposit / withdrawal | **Done** — document kind `transfer`, subtypes `account_transfer` / `bank_deposit` / `bank_withdrawal` with account-type validation (cash/custody ↔ bank) |
| Approved miscellaneous receipts and disbursements | **Done** — reason code → company posting profile (`accounting.treasury_receipt_reason_accounts` / `…disbursement_reason_accounts`, managed in the existing Accounting Policy screen, postable non-control accounts only, fail-closed) |
| Opening balances and authorized adjustments | **Already exist** (FA-01 `CashBankAdjustmentService`: opening_balance, bank_adjustment, write-off, reclassification) and are unchanged; not duplicated |
| Cash-count variances | **Deferred to T5** (needs cash sessions); will reuse receipt/disbursement documents with profile reasons |
| Draft → submit → approve → execute → post, locked transitions, optimistic concurrency | **Done** — status machine `treasury-document.ts`; `SELECT … FOR UPDATE`; `version` column; stale version refused |
| Configurable approval | **Done** — FA-01 engine (maker ≠ checker and live permission enforced there) + `finance.treasury_document_auto_approve_limit` (empty = never auto-approve; the owner sets the number) |
| Atomic document + allocation + movement + event | **Done** — execution is one transaction; failure (closed period, unmapped reason, control account as counter) leaves the document `approved` and nothing moved |
| Linked correction instead of editing | **Done** — `reverse` per kind (collection → payment reversal; transfer / receipt / disbursement → Treasury reversal carrying the same profile counter, never the clearing account); cancel for non-executed |
| Expected accounting effect shown before posting | **Done** — `GET /treasury/documents/:id/effect` (roles + mapped GL codes known to Treasury; nothing invented) |
| Backward-compatible representation of history | **Done** — additive tables, no backfill; historical movements simply have no document |
| Duplicate / over-allocation / cross-company refused | **Done** — tests D3, D8 |
| Back-/forward-dated execution | **Refused by design** — `[U]` owner policy; document date must equal execution date |

New schema (additive, empty): `treasury_documents`, `treasury_document_allocations` (migration `1790030100000`), `customer_payment_reversals` (T2, `1790030000000`), terminology (`1790030200000`). Manifest: nodes `finance.cash_document.{view,create,submit,approve,execute,cancel,reverse}`; config keys for the two profiles and the auto-approve limit; new GL event topic `finance.payment.reversed`.

## 2. T3 verification (actual)
- **Regression** `REGRESSION_NS=biz_t68_ … --regression <29 specs>` → **27/29 passed, 230 tests passed**. The 29 = the 21 prior specs + integrity + recovery + payment-reversal + **documents** + accounting-policy + approval-engine + company-migration-runner + H3 release-migration-registry. The two non-passes, classified:
  1. `accounting-policy-config` — a test that hard-coded "13 keys"; the product intentionally adds two (the Treasury posting profiles). Spec updated to 15 and **re-run: 8/8 PASS** (`biz_t69_`).
  2. `release-migration-registry.real-pg` — refuses to run unless the **isolated instance 127.0.0.1:5544** exists; it is not running in this environment. This is the same known environment-blocked spec recorded in the handover baseline; **BLOCKED, not failed, not a product defect**; must be run when the isolated instance is available (its expectations about migration counts should be re-checked then, because three migrations were added).
- **New spec** `treasury-documents.company-isolation.spec.ts` — **10/10** (also re-run after the final backend edits). Covers D1 profile-based receipt + Treasury==GL, D2 multi-invoice collection (1 leg/1 payment/1 event/1 journal/3 ledger rows; remaining/status; reversal restores everything), D3 allocation controls incl. other-Company invoice, D4 three transfer purposes + never touches income/expense + reversal, D5 profile disbursement / unmapped reason / control-account counter refused before commit / reason removed later blocks execution, D6 separation of duties + optimistic concurrency + preparer-only edit/submit/withdraw + reject, D7 auto-approval limit (fail-closed when unset), D8 closed-period atomicity + 5 concurrent executes → 1 movement + idempotent repeat, D9 owned-leg protection + back-dated refusal, D10 reversal on the same profile account + final reconciliation (Treasury == GL, journals balanced, no non-POSTED event, AR ledger == GL AR, Company B untouched).
- **Unit**: `treasury-permissions.spec` now 23 tests (each Treasury-Documents route → its own node, in the Finance manifest), `treasury-generic-cash.spec` 5; navigation / plans / permission / module-enforcement suites re-run: 79 + 86 pass. `tsc --noEmit`, backend `eslint` (treasury, navigation, accounting application, customer-finance), frontend `tsc -b`: clean.
- Not tested: HTTP-level role-based authorization against a running server; Arabic/English text of the new UI in a browser.

## 3. Defects found and closed
| Defect | Closure |
|---|---|
| Test data used one-character purposes (validation correctly refused) | test data corrected; validation unchanged |
| `accounting-policy-config` spec pinned the old key count | updated to 15 (intentional, documented) |
| Reversal of a document-owned movement would have booked the clearing account | `reverseTransaction` takes the same posting-profile counter (`options.counter`); D10 asserts the profile account moves and clearing stays 0 |

## 4. T4 — workspace UI: **code-complete, gate NOT passed**
Delivered (frontend, compiles under `tsc -b`): **Treasury workspace** (`/treasury/workspace`: book balances per account, awaiting-approval / ready-to-execute / drafts tiles, unmapped accounts, posting exceptions with cause / amount / age, quick actions gated by permissions); **documents list** with status tabs; **purpose-first creation form** (six purposes; only the relevant fields; invoice allocation grid with running total; reason list from the posting profile; no account typed); **document detail** (all fields, who/when per stage, expected accounting effect, only the actions the status and permissions allow, self-approval message); navigation items + section-cover shortcuts; idempotency key on the legacy Treasury ledger forms; required reason/reference there.
Honest limits: **book balances only** (no available / bank / reconciled balance — the data does not exist until T5); pending-transfers-in-transit, cash-count discrepancies and custody are T5; Arabic/English strings are inline (no terminology dependency); **nothing has been seen in a browser yet** — no desktop/mobile test, no 5173 check, no empty/loading/error-state review on a live page.

## 5. Blocker (stop-and-report for the affected operation only) and the decision needed
Browser verification needs a backend running the new code against a database that already has the new migrations. Options considered:
1. Migrate `daii_dev` and its company databases on 5433 — **not authorized** (the directive requires an explicit scope).
2. Create throw-away **clones** of `daii_dev` + the four company databases on 5433 by dump/restore (read-only on the sources, new databases only, run on separate ports) — attempted and **refused by the permission layer** ("modify shared resources"); not retried by another route.
3. Use the 5546 test cluster — its DB guard accepts only `daii_test_*` names and it is shared with the Procurement session; a long-lived browser environment there would also need the full installation bootstrap.
**Minimum decision to resume T4 verification (and T7):** the owner chooses (a) permission to create the 5 clone databases on 5433 for a throw-away preview on ports 3611/5181, or (b) permission to apply the four listed migrations to `daii_dev` + Alpha/Beta/Gamma/Delta (with `down` available) so :5173 can show the work. Independent work (T5 backend, tests, docs) continues meanwhile.

## 6. Residuals
Supplier-side items wait for the Procurement merge; the H3 registry spec needs the 5544 instance; approval thresholds, back-dating and idempotency-enforcement dates are owner policies `[U]`; the `finance.cash_document.*` nodes inherit from `finance` (no role gains or loses anything) — narrowing is an owner action; no role template was edited.

## 7. Decision
**Gate T3: PASSED** (customer-side and Treasury-owned workflows complete and verified; supplier allocation reuse and cash-count variance explicitly deferred). **Gate T4: NOT passed** — code-complete; browser verification blocked as in §5. Proceeding to T5 on the independent backend scope.
