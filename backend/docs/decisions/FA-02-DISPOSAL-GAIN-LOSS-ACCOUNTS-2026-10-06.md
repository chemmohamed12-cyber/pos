# FA-02 — Fixed-asset disposal: separate Gain / Loss accounts, fail-closed before mutation (2026-10-06)

**Status: CLOSED (2026-10-06) — IMPLEMENTED / REAL-PG VERIFIED. Browser verification NOT PERFORMED (no UI change).**

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

## Status
**FA-02 = CLOSED (2026-10-06).**
