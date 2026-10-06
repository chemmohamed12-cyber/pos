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

## Status
**D8 = VERIFIED / CLOSED (2026-10-05)** — manual JE + link kept; UI workflow completed; JE-creation helper deferred pending a counter-account policy. Next in the CTO order: D9 (closed), D7 (closed), COA/remaining.
