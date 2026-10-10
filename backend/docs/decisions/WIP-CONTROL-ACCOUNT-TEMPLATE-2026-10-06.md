# WIP control account in the `ifrs-sme` chart template — decision record (2026-10-06)

**Status: IMPLEMENTED → INTEGRATED → VERIFIED (real Postgres, isolated :5544). Not yet UAT-run in a browser. Production: HOLD.**
Origin: Manufacturing handoff **H2** (`acceptance/MANUFACTURING_HANDOFF_2026-10-06.md`) and closure-report gap 2. Owner: Accounting.
Gate: **D10 is CLOSED** (ADR-075, Matrix §53, 2026-10-04) — accounting remediation is permitted; the template change below is chart *data*, not Event-Engine or Manufacturing code.

## 1. Problem (reproduced, not assumed)
A Company that imports `ifrs-sme` (`POST /accounting/chart/import-template` → `GLAccountService.importTemplate`) had no active postable account with `controlFunction = 'wip'`. The three handlers in `manufacturing-events.handler.ts` call `ctx.resolveControlAccount('wip')` and, finding none, return *rejected*. Reproduced red on a fresh real-PG Company before the change: `material_issued` → `REJECTED`, reason `manufacturing.work_order.material_issued: no active postable account has controlFunction "wip" — assign one first`, no journal.

## 2. Decisions
| # | Question | Decision | Why |
|---|---|---|---|
| 1 | Standard account code | **`1150` — "Work in Process" / «إنتاج تحت التشغيل»**, asset, debit-normal (derived), postable, non-contra, `currencyMode = functional_only`, parent **`11` Current Assets** | Next free code after `1140` in the current-assets block, between Inventory `1120` and the non-current block `12`. IFRS (IAS 2) classes WIP as inventory ⇒ current asset. Same code the isolated provisioner already used by hand, so no number change for anyone. Arabic wording reuses the existing Manufacturing term «الإنتاج تحت التشغيل» (`field.wip_value`). |
| 2 | `controlFunction` | **`wip`** (already a valid `ControlFunction`; **not** singleton — ADR-061 allows several, e.g. per product line) | `importTemplate` therefore sets `allowManualJournal = false` automatically (no manual JE to a control account, F03). |
| 3 | In the `ifrs-sme` template? | **Yes, unconditionally** | The template is opt-in, importable only into an empty chart, and every row is customer-owned afterwards (rename/re-code/deactivate). An unused zero-balance asset control account is inert: `WipReconciliationService` yields `no_subledger_source` with *or* without it when Manufacturing is not bound. Making the template conditional on a Manufacturing entitlement would couple chart data to the entitlement/Release engines for no benefit, and the failure mode of omission (first Work Order event of an entitled Company REJECTS) is worse than the cost of one unused row. |
| 4 | Provisioning / import behaviour | **No change to the importer.** It still imports only into an empty chart, same `max_gl_accounts` gate (template is now 50 accounts). **No data migration** into existing charts. | Charts are customer-owned; code `1150` may already be used for something else in an existing Company. Silently inserting rows into a live ledger is not a safe default. |
| 5 | Already-provisioned Companies (chart imported before this change) | Documented operator recovery, **verified**: create an account with control function `wip` (or assign `wip` to an existing asset account) via Chart of Accounts, then **re-drive** each REJECTED Financial Event (Financial Events screen / `redrive`). The event posts at its original `businessDate`. | The rejection is fail-closed by design — nothing was posted and the event row is retained, so re-drive is lossless. |
| 6 | Isolated-DB provisioner | `backend/tools/testing/provision-isolated-ambient-db.js` no longer inserts `1150` by hand (would now collide on the unique code). The template import supplies it. | Removes the workaround the handoff pointed at. |

Not changed: Manufacturing code, Event Engine, handlers, posting gate, `ControlFunction` set, importer, any existing Company data.

## 3. Evidence
New spec `domains/accounting/interface/wip-control-account.company-isolation.spec.ts` — **8/8**, two disposable Company databases on the isolated PG `127.0.0.1:5544` (never `daii_dev` :5433):

| Test | Proves |
|---|---|
| static ×2 | template has exactly one `wip` account: `1150`, asset, postable, parent `11`, not contra; no duplicate codes; parents precede children |
| A-1 | fresh Company, real `importTemplate` → exactly one active postable `wip` account (`1150`, debit, `allowManualJournal=false`, `functional_only`, parent `11`); `inventory` control account `1120` present too |
| A-2 | real Work Order (create → release → issue 4 × 5.00 → return 1 → FG output 1) with **no hand-seeded account**: issue **Dr 1150 20.0000 / Cr 1120 20.0000**; return **Dr 1120 5.0000 / Cr 1150 5.0000**; FG output **Dr 1120 v / Cr 1150 v** (v = the ADR-061 §7 pooled value); all three events `POSTED`, each journal balanced, only `1120`/`1150` ever touched (no P&L) |
| A-3 | `WipReconciliationService.reconcile` on that Company → **`matched`, drift 0.0000**, `subledgerTotalBase = glBalanceBase` |
| B-1 | a chart that pre-dates the fix (template imported, `1150` removed) → issue event **`REJECTED`** with the exact "assign one first" reason, **no journal** (fail-closed preserved) |
| B-2 | recovery: `createAccount(1150, control=wip)` → `redrive` → **`POSTED`**, **Dr 1150 20.0000 / Cr 1120 20.0000** |
| Iso | A's and B's `1150` are different rows; B's 20.00 never in A's balance |

The spec was run **red first** against the unchanged template (A-1, A-2, A-3 failed with the rejection above) and went green only with the template change.

Regression (isolated PG; no test touched `daii_dev`):
* Fresh disposable ambient DB `daii_test_wipfix` provisioned with the updated provisioner (266 migrations, template = 50 accounts, **no hand-seeded 1150**): `work-order-phase3-e2e` (incl. Items 7/8, the GL Dr/Cr proof), `work-order.spec`, `wip-reconciliation.spec`, `f03-deadlock-retry-verification` — **4 suites / 15 tests pass**.
* Harness suites: `accounting.company-isolation` (template import into Company B, count = template length), `wip.company-isolation`, `work-order.company-isolation`, `returns-accounting.company-isolation` (matched by the name filter) — pass. Combined with the new spec: **5 suites / 39 tests pass**.
* ESLint clean on the template and the new spec; `tsc -p tsconfig.build.json` clean.
* This is a **focused** regression, not a full-suite run. `daii_test_ambient` (another session's fixture database on :5544) was deliberately not re-provisioned.

## 4. Observation (not changed — Event Engine is out of scope)
`importTemplate` publishes one `accounting.gl_account.created` outbox row per account and does not flush them. `EventBusService.dispatchAfterCommit` claims at most 50 rows, oldest first. With the template now at 50 accounts, the backlog alone fills one batch, so a Work Order event raised *immediately* after an import is dispatched by the per-Company scheduler / next flush rather than in-request (it was already marginal at 49). Nothing is lost or mis-posted — the row stays `pending` and is claimed later — but a test or script that expects in-request posting right after an import must drain the outbox first (the spec does, with a helper that mirrors the scheduler). If the CTO wants in-request determinism, the fix belongs in the Event Engine (e.g. flush after import) and is a separate, gated change.

## 5. Same-class gaps found while checking (NOT changed — outside H2, need a decision)
The template defines no account for these control functions that handlers/services already require: **`grni`** (Goods Receipt Dr Inventory / Cr GRNI; the isolated provisioner still inserts `2115` by hand), **`wages_payable`** (`payroll.run.posted`; the provisioner's own header comment claims the template supplies it, but it does not), **`fixed_asset`** (cost/contra pairs per category). A fresh Company importing the template will REJECT those events exactly as WIP did. Recommend the CTO decide, per domain, whether each belongs in the template (same reasoning as §2.3 applies to `grni`; `fixed_asset` is category-specific and may not).
Also latent: `resolveControlAccount` uses `findOne` on a non-singleton function, so a chart with two active `wip` accounts resolves arbitrarily — fine for the single template account, worth a policy if per-line WIP accounts are ever introduced.

## 6. Manufacturing integration-matrix rows (evidence for the owner to record)
* **Row 4** (material issue → Dr WIP / Cr Inventory; material return → Dr Inventory / Cr WIP): proven on a template-only chart — A-2, B-2.
* **Row 5** (finished-goods output → Dr FG Inventory / Cr WIP): proven — A-2.
* **Row 7** (GL `wip` control account vs Manufacturing WIP subledger): proven `matched`, drift 0.0000 — A-3.
Caveats to carry over: verified at real-PG service level, **not** through the browser; UAT items below remain.

## 7. UAT / follow-up items
1. Browser check: Chart of Accounts → import template in a fresh Company shows `1150 Work in Process` (English and Arabic names, RTL); then a Work Order issue in the UI shows the event `POSTED`.
2. Any existing Company that imported the template before this change (e.g. the dev Companies Alpha–Delta — not inspected, the shared dev server was not touched) still lacks a `wip` account — apply the §2.5 recovery per Company, with the owner's go.
3. CTO decision on §5 (grni / wages_payable / fixed_asset in the template) and §4 (flush after import).
