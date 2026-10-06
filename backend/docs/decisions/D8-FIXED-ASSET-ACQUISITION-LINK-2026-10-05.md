# D8 — Fixed assets: keep manual JE + link-acquisition, complete the UI workflow (2026-10-05)

**Status: CLOSED (2026-10-05) for the approved scope — IMPLEMENTED / INTEGRATED / REAL-PG VERIFIED. One optional capability deliberately NOT built and recorded as a follow-up decision (§5).**
Execution rule in force (CTO): started immediately after PRC-01 closed; stop only at a genuine accounting decision (§5).

## 1. Approved scope (CTO preliminary D8)
**Keep** the manual-JE + `link-acquisition` architecture (ADR-045 D7: register creation posts nothing; the asset stays `pending_acquisition` until a separately **POSTED** journal entry that debits the asset's cost account for **exactly** the cost is linked). **Complete the UI/workflow:** pending → JE → link → active.

## 2. Evidence (FA-01, code read)
- Backend already complete: `POST /accounting/fixed-assets/:id/link-acquisition` (validates the entry exists, is POSTED, has a line on the asset's cost account whose debit equals the cost exactly, and is not already another asset's acquisition — DB-unique) and the lifecycle `pending_acquisition → active → disposed`.
- **Gap (UI only):** `FixedAssets.tsx` had no status column, no link action and no way to find the journal — an asset could never reach `active` from the UI, and nothing told the operator what to do (FA-01).
- The fixed-asset controller is now Company-scoped (closed) — D8 adds one additive read route and re-proves it.

## 3. Implementation (read-only helper + UI; nothing is created or posted by D8)
| Piece | Where |
|---|---|
| `FixedAssetService.listAcquisitionCandidates(assetId)` — the POSTED journal entries that satisfy the link rules (a debit on the asset's cost account for exactly the cost, not already linked); only a `pending_acquisition` asset has candidates; limit 50 newest | `fixed-asset.service.ts` |
| `GET /accounting/fixed-assets/:id/acquisition-candidates` (permission `accounting.fixed_asset.view`) | `fixed-asset.controller.ts` |
| UI: lifecycle **Status** column (Pending acquisition / Active / Disposed); **Link acquisition journal** action on pending assets → three-step guidance (record the manual JE debiting the cost account for exactly the cost → post it → pick it here), a picker of the candidates (entry number · date · debit · description), a link button, and a shortcut to the Journal Entries screen | `frontend/.../accounting/FixedAssets.tsx` |
| Terminology (ar/en) | core migration `1789960000000-SeedFixedAssetAcquisitionLinkTerminology` |
The link itself still goes through the unchanged `linkAcquisitionJournalEntry`, which **re-validates every rule at link time**.

## 4. Verification (real PostgreSQL)
**Spec** `accounting/interface/fixed-asset-acquisition-link.company-isolation.spec.ts` — **3/3**, real Company DBs A/B, real Journal engine (manual entries created and posted through `JournalEntryService`): (1) candidates are exactly the POSTED entry with a debit of 12000.0000 on the cost account — a **draft**, a **wrong-amount** entry and a **wrong-account** entry are excluded; the call creates nothing (journal count unchanged) and leaves the asset `pending_acquisition`; (2) **link activates** the asset (rules re-validated), the linked entry is no longer a candidate for a second asset with the same cost and linking it again is rejected, and an active asset has no candidates; (3) A/B isolation — B sees only its own entries/asset, A's asset id and journal are unknown to B, never requests B's DataSource.
**Blast radius:** `fixed-asset.company-isolation` (4/4, the Area 21 spec), `general-ledger` (9/9 tests; one suite-level teardown flag), D6 `rfq-award-visibility` (7/7, markers re-grepped present). Build / `tsc` clean (backend + frontend); D8 files lint clean (two pre-existing lint errors exist in other sessions' files `accounting.controller.ts` / `subledger-controllers…spec.ts`, untouched).
**Regression:** targeted (additive read route + frontend); last full run on the isolated seeded PostgreSQL 894/915 (+1 skipped, no stage-caused failure). **Not browser-verified.**

## 5. Decision recorded — "does the UI also help CREATE the acquisition journal?" → NOT built
The register asked whether the UI should also create the acquisition JE or only link an existing posted one. D8 **links only** and guides the manual JE (the existing Journals screen already records manual entries). A "create the acquisition journal for me" helper would have to **choose the credit-side account** (Accounts Payable? cash/bank? a clearing account?) — an accounting policy decision that must not be guessed. If wanted, it needs a CTO policy first (counter-account source: supplier invoice / treasury account / configured clearing account). Recorded as a follow-up decision, not part of this closure.

## 6. Known limits
Candidates are limited to the exact-cost debit rule (the same rule the link enforces); a capitalisation split over several JEs is not supported (V1 per ADR-045). UI type-checked, not browser-verified.

## 7. Verification evidence (CTO requested the Real-PG / A/B proof be shown explicitly — 2026-10-05)
Real PostgreSQL (isolated seeded cluster, two real Company databases A/B created by the two-company harness; Platform/shared `daii_dev` not used), re-run on 2026-10-05 in one serial run together with the D7 regression set:
- `fixed-asset-acquisition-link.company-isolation.spec.ts` — **3/3 passed**: (1) candidates = exactly the POSTED entry debiting the cost account for the exact cost (draft / wrong-amount / wrong-account excluded; nothing created, asset still `pending_acquisition`); (2) link activates the asset, the linked entry stops being a candidate, re-link rejected (Conflict); (3) **A/B isolation** — B sees only its own entries/asset, A's asset id is 404 for B, A's journal unknown to B on link, and Company B's DataSource is never requested for A's call (`assertDataSourceNeverRequestedFor`).
- `fixed-asset.company-isolation.spec.ts` (the closed Area 21 controller) — **4/4 passed** in the same run.
- Same serial run: 22 suites, 135 passed + 1 skipped, 0 failed (see D7 record §7).
Status after evidence: **D8 = VERIFIED / CLOSED** (Browser verification: NOT PERFORMED; JE-creation helper still deferred — §5; FA-02 gain-on-disposal account is a separate open accounting decision).

## 8. Acquisition-Journal Helper — CTO decision Option C (2026-10-06) — IMPLEMENTED / REAL-PG VERIFIED / BROWSER-VERIFIED
**Decision (CTO):** the helper's counter-account is a **Fixed Asset Acquisition Clearing** account — not AP (Acquisition ≠ vendor invoice), not Bank (Acquisition ≠ Payment). `Dr Fixed Asset Cost / Cr Fixed Asset Acquisition Clearing`; the clearing account is settled later by the real workflow (AP integration, payment, transfer). The helper must NOT mix with AP/Treasury, must NOT invent an account code, and the account comes from the existing configuration mechanism, **fail-closed**. The manual-JE + link workflow stays available and unchanged.

**Implementation**
| Piece | Where |
|---|---|
| Config key `accounting.fixed_asset_acquisition_clearing_account_code` (string, default '' = fail-closed; manifest 1.19.0; set through the existing `PUT /config/values/:key`) | `accounting.manifest.ts` |
| Handler: Dr the asset's cost account / Cr the configured clearing account for exactly the cost; clearing resolved by the existing `resolveConfiguredPostableAccount` (exists, active, postable, NOT a control account) | `financial-events/fixed-asset-acquisition.handler.ts` |
| `FixedAssetAcquisitionService.createAcquisitionJournal`: asset must be `pending_acquisition`; **pre-flight of the clearing account before any write**; then ONE transaction: ingest the event (business date = the asset's acquisition date, idempotency key per asset) → POSTED journal → the existing unchanged `linkAcquisitionJournalEntry` (re-validates every rule) → audit; any non-POSTED outcome throws and rolls everything back | `application/fixed-asset-acquisition.service.ts` |
| `POST accounting/fixed-assets/:id/acquisition-journal` (feature `accounting.fixed_assets`, permission `accounting.fixed_asset.edit`) | `fixed-asset.controller.ts`, `accounting.module.ts` |
| UI: "Create acquisition journal" button + hint in the Link-acquisition panel (server errors shown); terminology core migration `1789994000000` | `FixedAssets.tsx` |
No new table, no migration other than terminology, no new permission node, no AP/Treasury code touched.

**Verification (real PostgreSQL, isolated seeded cluster)** — spec `fixed-asset-acquisition-helper.company-isolation.spec.ts` **5/5**: (1) clearing account unset / unknown / header / inactive / control-function (AP) each rejected naming the config key with zero journal/event rows and the asset still pending; (2) happy path: Dr cost 12000 / Cr clearing 12000, balanced, event POSTED, asset ACTIVE with the journal linked, GL read-back cost +12000 / clearing −12000, **AP and Bank nets stay 0**; (3) a second call is refused (no longer pending) and creates nothing, and the activated asset is charged by a normal depreciation run (1000); (4) an acquisition date with no open fiscal period → rejected with the engine's reason, nothing persisted, asset stays pending; (5) A/B isolation — B's helper posts only in B against B's chart, A unchanged, B's DataSource never requested for A's calls, the Platform DB holds none of the accounting tables.
**Live in the real app (isolated environment):** the Fixed Assets screen shows the new button in the link panel; with the key unset one click returns the fail-closed message and the asset stays pending; after setting the key through `PUT /config/values` one click makes the asset **Active** and the GL holds `JV-2026-000002: Dr 1210 6000 / Cr 2900 6000`.
**Regression (one serial run, isolated PG): 14 suites, 76/76 passed** — fixed-asset ×5 (4+3+5+5+5), general-ledger 9, event-engine 8, journal-numbering 5, accounting.company-isolation 5, subledger-controllers 5, inventory-posting 9, grni-reconciliation 3 (boots the full `AppModule`), fiscal-period-closing 4, module-registry guards 6. Not a full-repository regression. Backend/frontend `tsc` clean, eslint clean on the touched backend files.

**Notes / limits:** the clearing account is not settled by anything yet — settlement against AP/Bank belongs to those workflows (future). The helper uses the asset's acquisition date as the journal date (a closed/absent period rejects it; use the manual path then). Browser verification developer-level, no screenshots; **UAT pending.** Status: **D8 helper = VERIFIED — UAT READY; Production HOLD.**

**CTO acceptance (2026-10-06):** D8 Acquisition-Journal Helper = VERIFIED / UAT READY; **UAT = PENDING; Production = HOLD.** The helper only RECORDS the acquisition (Dr Fixed Asset Cost / Cr Fixed Asset Acquisition Clearing) and does **not** settle the clearing account — settlement against AP / Bank belongs to those future workflows and **no settlement logic may be added to this helper**. Not to be changed: the manual-JE + link workflow, AP, Treasury, the chart architecture, the clearing-account selection logic (configuration only; no fallback; no account code chosen in code).

## Status
**D8 = VERIFIED / CLOSED (manual JE + link) and the Acquisition-Journal Helper = VERIFIED — UAT READY (2026-10-06).**
