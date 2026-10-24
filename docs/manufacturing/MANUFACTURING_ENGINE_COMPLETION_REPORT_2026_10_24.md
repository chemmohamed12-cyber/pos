# Manufacturing Engine — completion report (2026-10-24)

Executed under the owner's "Direct Execution & Completion Order". Branch `feature/manufacturing-engine-design` (worktree `preview-shared`). **Nothing is merged into the Protected Baseline, nothing is released or deployed.** The prior accounting decisions (ADR-060 D1–D5, material-only cost policy) are unchanged; no labour / machine / overhead / standard cost / variance exists anywhere in the engine. The comprehensive Audit review was not started.

Decisions D-ME-1…5 and the outcome-class table: `MANUFACTURING_ENGINE_DECISIONS_2026_10_24.md` (each marked *owner sign-off pending*).

## What was built (all additive; the current work-order path is the "Basic Profile", behaviour unchanged)
| Slice | Content | Migration (manufacturing tag unless noted) |
|---|---|---|
| S1 | Eight outcome classes live: scrap (pooled cost → configured loss account, no stock), capped recovery, rework / rejected / held tracked and blocking close; accounting handlers + policy key `accounting.manufacturing_scrap_loss_account_code` | `1790033000000` (+ core `1790033100000` terminology) |
| S2 | Units & pack conversion by integer base-unit scaling (exact, never rounded); recipe lines accept a decimal quantity + unit | `1790033200000` |
| S3 | Versioned process definition: typed operation graph (sequence / parallel / join / optional / repeatable), alternates, intermediate & final outputs (good / co-product / by-product), configurable operation-type catalogue; draft → active → retired, one active per product | `1790033300000` |
| S4 | Process-bound work orders: release snapshots raw material from the version, graph-gated operation runs, per-operation consumption & yields, derived production ledger (per-operation WIP = quantity + material value) | `1790033400000` |
| S5 | Multi-output receipt (pooled cost shared by weight × quantity), operation-level scrap and quality outcomes | — |
| S6 | Quick assembly on the Work Order path (`POST /manufacturing/quick-assembly`; one transaction, full rollback on failure); Assembly screen uses it | — |

UIs (all browser-verified on a dev preview): Work-order *Production results* panel (S1), *Product units & pack conversions* + unit selector in BOM editor (S2), *Process definitions* page (S3: list / editor / clone / activate), *Process work order* card on the Work Orders page and the *Process execution* panel on the order (S4/S5).

## The seven cases (configuration only — no case-specific code)
| # | Case | Result |
|---|---|---|
| 1 | Lamps | PASS — Basic Profile (S1 spec, S4-10) and as a process |
| 2 | Electronics, parallel branches | PASS — S4 spec + browser run (board ∥ housing → join → optional inspection; 10 lamps at 140.00) |
| 3 | Multi-output blending | PASS — good + co-product share 300.00 by weight, by-product at 0; retry creates nothing |
| 4 | Metal machining, recoverable scrap + rework | PASS — scrap 2 at the operation, 12.00 recovered, rework via repeatable operation; GL: scrap loss 28.00, WIP 0 |
| 5 | Unit → pack → carton | PASS — "1 dozen" = 12 base units; chained orders carry cost up |
| 6 | Independent quality operation | **PARTIAL** — quantity side PASS (held units block closing until released). **Costing the inspection itself is BLOCKED**: it needs a cost element (labour / machine / overhead), which D2/D3 forbid. The schema deliberately has no place for one. |
| 7 | Disassembly / complex | PASS — stocked item broken into parts at carried cost shared by weight; alternates + intermediates covered in S4 |

## Verification
* Real-PostgreSQL (isolated cluster 5546, two-Company A/B, real cost engine + journals): S1 10/10 · S2 7/7 · S3 9/9 · S4 11/11 · cases 6/6 · S6 3/3.
* Regression of existing behaviour: manufacturing entitlement/permission, master data, work-order, inventory valuation, oversell/assembly, inventory-lifecycle C1 — all PASS; accounting-policy spec updated for the 18th key (17 → 18) and PASS (8/8). DB-free unit suite 70 suites / 523 tests PASS.
* Browser (dev preview): every new screen driven by real clicks; end-to-end process order created, run, received and completed through the UI; journals visible on the order.
* Known property: unit costs are stored at 4 decimals by the cost engine, so a multi-output split can leave a residual ≤ qty × 0.00005 in WIP (same as the Basic Profile; inside the 0.01 closing tolerance).

## Dev-environment record (shared dev DB — all known and verifiable)
* Migrations above applied to `daii_dev` and the nine `company_*` dev databases (additive tables/columns only); `core/1790033100000` applied to `daii_dev` (+ `nav.manufacturing_processes`, policy labels).
* Alpha (`company_f3ea8a2e…`) configuration changed for the tests: `accounting.manufacturing_scrap_loss_account_code` = 5299; `accounting.inventory_manual_receipt_reason_accounts` = `{mfg_s1_test: 3101}`.
* Alpha test data (SKU prefixes `MFG-S1-`, `ELEC-`): products, BOMs, stock receipts, process ELEC-LAMP v1 (active), work orders WO-2026-000001…000003.
* Ports 3500 / 5173 belong to another session's main-checkout servers and were not touched; verification ran on this worktree's backend `:3501` + Vite `:5174` against the same dev DB.

## Risks / remaining decisions (for the owners)
1. **Costed operations** (labour / machine / overhead / standard cost / variance) — not built, by order; needs the separate cost-policy ratification (blocks the costed half of case 6).
2. **Legacy `POST /inventory/assemble`** still exists for API/test consumers; the UI no longer uses it. Owner to decide retirement (two endpoints = a latent parallel path).
3. D-ME-1…5 sign-offs (scrap fully expensed — no "normal loss" capitalisation; integer base-unit scaling; additive model; class semantics; quick-assembly re-base).
4. Allocation basis is weight × quantity only; other bases (market value, net realisable value) would be a policy change.
5. Alternates are chosen per order at creation (explicit, no silent default); changing them later requires a new order.
6. Release/deploy: migrations `1790033000000…1790033400000` (+ core `1790033100000`) must travel together in order; no package was built.

## Hand-off for consolidation
Commits on `feature/manufacturing-engine-design`: 57bc78e (S1), cb3b571, d6b434e (S2), 8c37b10 (S3+S4), f32517b (S5+S6) and the closing commit. Regression list: `backend/tools/testing/regression-specs-mfg-engine.txt`; shared test kit: `manufacturing-engine-test-kit.ts`.
