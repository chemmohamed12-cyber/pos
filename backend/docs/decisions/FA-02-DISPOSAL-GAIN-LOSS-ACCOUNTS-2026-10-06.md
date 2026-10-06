# FA-02 — Fixed-asset disposal: separate Gain / Loss accounts, fail-closed before mutation (2026-10-06)

**Status: VERIFIED — UAT READY (2026-10-06). Sequence: IMPLEMENTED → INTEGRATED → VERIFIED → UAT READY. Production = HOLD. Browser verification NOT PERFORMED.**

## 1. CTO decision (verbatim intent)
Two separate accounts — *Gain on Disposal of Fixed Assets* and *Loss on Disposal of Fixed Assets*. The Disposal engine picks by RESULT: Gain → credit the gain account; Loss → debit the loss account. The required account must be configured and postable; missing configuration → **reject before mutation**; no fallback, no hard-coded account. (FA-02 is independent of D8.)

## 2. Evidence (code read, before the change)
- The engine already had the two separate config keys (`accounting.fixed_asset_gain_on_disposal_account_code`, `…_loss_…`) and the gain/loss plug (Cr gain / Dr loss) — the audit's "2 disposals REJECTED" were these accounts being unset.
- Gaps against the decision: (a) the handler required **both** accounts even when the result needed only one (a gain disposal was rejected because the *loss* account was unset, and vice-versa); (b) a missing account was only discovered **after** the approval, as a REJECTED financial event — the disposal row, the approval request and the approval decision had already been written; (c) the "disposal approved → asset disposed" transition then silently did not happen.

## 3. Implementation
| Piece | Where |
|---|---|
| `disposalGainLoss(proceeds, accumulatedDepreciation, cost)` — the ONE calculation (positive = gain, negative = loss, zero = none) shared by the handler and the pre-flight; config-key constants exported | `financial-events/fixed-asset-disposal.handler.ts` |
| Handler resolves **only the account the result needs** (no gain account for a loss, no loss account for a gain, none at break-even); unresolved → `rejected` naming the config key | same |
| `FinancialEventService.preflightConfiguredPostableAccount(configKey, manager)` — the handler context's own resolution (exists / active / postable / non-control) exposed for pre-mutation checks | `financial-events/financial-event.service.ts` |
| `FixedAssetDisposalService.assertDisposalAccountConfigured`: runs in **`submitDisposal` before any write** and in **`decide(…, 'approved')` before the approval is recorded** (fresh accumulated depreciation — a Depreciation Run may have posted since submission) → `ConflictException` "…results in a loss/gain of N but the … account is not usable (reason). Configure "<key>"…" | `application/fixed-asset-disposal.service.ts` |
No schema change, no new config key, no terminology, no frontend change (the server message is shown by the existing screen). Configuration stays the existing config-engine values — **no account code is chosen by the code.**

## 4. Verification (real PostgreSQL, isolated seeded cluster)
Spec `accounting/interface/fixed-asset-disposal-gain-loss.company-isolation.spec.ts` — **5/5** (real Company DBs A/B, real approval engine, real posting): (1) LOSS: unset / unknown / header (non-postable) / inactive / control-function accounts are each rejected before mutation (no disposal row, no approval request) with the reason + config key; a usable loss account posts Dr loss / Cr cost, balanced, no gain line; (2) GAIN: rejected while the gain account is unset **even though the loss account is also unset** (only the needed side matters); configured → Dr cash / Cr cost / Cr gain, balanced, no loss line; (3) break-even → no gain/loss line and neither account needed; (4) approval re-check: the account becomes unusable after submission → the decision is refused **before it is recorded** (zero decisions, asset still `active`), and succeeds once fixed (asset `disposed`); (5) A/B isolation — B untouched by A's disposals, B's DataSource never requested for A's calls, B resolves its own chart.
Existing spec `fixed-asset.company-isolation.spec.ts` (closed controller) updated to configure gain/loss accounts (its disposal had been silently relying on unconfigured accounts) — 4/4.
**Accounting reconciliation:** every posted disposal journal asserted balanced (Σdebit = Σcredit) and the fixed-asset reconciliation run stays local per Company (existing assertions).
**Regression (one serial run, isolated PG):** 17 suites — fixed-asset (3 specs), event-engine, general-ledger, inventory-posting, manual-receipt, returns-accounting, supplier-invoice-ppv-vat, treasury-bank-leg, subledger-controllers, grni-reconciliation (boots `AppModule`), payroll GL e2e, navigation/guards — **133 passed + 1 skipped (T0 baseline, skipped by design), 0 failed.** Backend `tsc` clean; eslint clean on all touched files.

## 5. Notes
- The generic Approvals screen can still approve a disposal request directly through the Approval Engine (bypassing the disposal service's `decide`); in that path the handler remains fail-closed (event REJECTED, audited, asset not disposed) — the pre-flight covers submit and the disposal screen's decide. Not widened here.
- Config is read through the existing configuration engine (installation scope); the manifest defaults stay empty (`''`) — nothing is defaulted.


## 6. CTO verification brief (2026-10-06, second message) — evidence map
The implementation above already satisfied the brief; the brief's accounting-math proof points were not all covered by the first spec, so a second DB-level spec was added: `accounting/interface/fixed-asset-disposal-reconciliation.company-isolation.spec.ts` — **5/5** (real PostgreSQL, two Company databases, the GL read back from the Company database). It uses the legitimate lifecycle: asset registered → acquisition journal (Dr cost / Cr offset) posted and **linked** (asset becomes active) → a real **depreciation run** (1000 / 500 over 12 months) → disposal approved → journal lines read from `accounting_journal_lines`.

| # | Brief item | Evidence |
|---|---|---|
| 1 | Disposal with Gain | recon spec test 2: cost 12000, accumulated depreciation 1000 (NBV 11000), proceeds 12500 → Dr accum 1000 + Dr cash 12500 = Cr cost 12000 + Cr **gain 1500** |
| 2 | Disposal with Loss | recon spec test 3: cost 6000, accum 500 (NBV 5500), proceeds 4000 → Dr accum 500 + Dr cash 4000 + Dr **loss 1500** = Cr cost 6000 |
| 3 | Missing Gain account → rejected before mutation | gain-loss spec tests 1/2/4 and recon test 4 (gain of 800.00 with the gain account unset): zero disposal rows, zero journal entries, zero approval requests/decisions |
| 4 | Missing Loss account → rejected before mutation | same (loss of 1100.00 with the loss account unset; also unknown / header / inactive / control-function accounts) |
| 5 | Journal balanced | every posted disposal journal asserted Σdebit = Σcredit; whole-GL Σdebit = Σcredit after all postings |
| 6 | Asset cost removed correctly | GL `cost` account net: 18000 → 6000 after the first disposal → **0** after the second |
| 7 | Accumulated depreciation handled | GL accumulated depreciation net: −1500 → −500 → **0**; the disposal debits exactly the depreciation to date read at posting time |
| 8 | Net Book Value reconciles | NBV = cost − accumulated depreciation (11000 / 5500) computed independently in the spec and matched to the journal |
| 9 | Gain/Loss mathematically correct | gain = proceeds − NBV = 12500 − 11000 = 1500; loss = NBV − proceeds = 5500 − 4000 = 1500; break-even posts neither |
| 10 / 11 | Company A / Company B isolation | gain-loss spec test 5 and recon test 5: B has no journal lines/disposals from A's activity; B's own asset disposal is submitted in B only; B's DataSource never requested for A's calls |
| 12 | Platform DB untouched | recon test 5: the Platform DB has none of the Company accounting tables (`accounting_fixed_assets`, `accounting_journal_lines`, `accounting_fixed_asset_disposals`) |
| 13 | No fallback GL account used | the disposal journal lines are asserted to contain none of the decoy revenue/expense accounts, the other-side account (gain account never touched by a loss and vice-versa) or the depreciation-expense account; decoy accounts' GL net stays 0 |
Not covered: a Company B disposal is only SUBMITTED (B has no approver user in the harness), so B's posting path is proved by the shared engine and A's postings, not by a B approval.

**Regression — worded exactly (isolated seeded PG, serial, this stage):** focused set of 11 suites (the 3 fixed-asset specs + the new reconciliation spec, general-ledger, event-engine, inventory-posting, subledger-controllers, accounting.company-isolation, grni-reconciliation, fiscal-period-closing-workflow): **40/60 first run, 3 suites failed** — all three on `relation "user_roles" does not exist` (event-engine 8, inventory-posting 9, fixed-asset-acquisition-link 3 = 20 tests): **classification: infrastructure/contention** (missing-schema errors from the shared harness, identical to the pattern seen in earlier runs; not an assertion failure, not FA-02-caused; all three passed earlier in this stage's lineage). The three suites were **individually re-run and passed 20/20** (event-engine 8/8, inventory-posting 9/9, fixed-asset-acquisition-link 3/3) — this is NOT a single-run "all passed". Passed in the first run: fixed-asset-disposal-reconciliation 5/5, fixed-asset-disposal-gain-loss 5/5, fixed-asset 4/4, general-ledger 9/9, subledger-controllers 5/5, accounting.company-isolation 5/5, grni-reconciliation 3/3, fiscal-period-closing-workflow 4/4. Earlier in the stage: 17 suites, 133 passed + 1 skipped (T0 baseline, skipped by design). **FA-02-caused failures: none. Unrelated regressions: none observed in this set. A full-repository regression was NOT run for this stage.**

## Status
**FA-02 = VERIFIED — UAT READY (2026-10-06). Not "DONE". Production = HOLD.**
