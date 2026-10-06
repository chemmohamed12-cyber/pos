# D3 — Inventory movement posting policy (2026-10-04)

**Status: POLICY APPROVED (CTO). D3-A and D3-B IMPLEMENTED + REAL-PG VERIFIED (2026-10-04/05). Closure per the gate in §7 — see the Status section at the bottom for the final word.**

## 1. Approved policy (CTO, 2026-10-04)

**Account model — Model A: ONE central Inventory Control Account** (`1120`, control function `inventory`). A Warehouse is an operational stock dimension, NOT a GL-account dimension. No per-warehouse GL accounts in D3.

| Movement | Inventory valuation | GL posting | Journal |
|---|---|---|---|
| Opening Stock | yes | **yes** | Dr Inventory / Cr Opening Balance (configured offset) |
| Purchase Receipt / GR | yes | **yes** (already) | Dr Inventory / Cr GRNI — unchanged |
| Manual Receipt | yes | **yes** | Dr Inventory / Cr Inventory Adjustment-or-Clearing **by movement reason**; no generic fallback |
| Adjustment Increase | yes | **yes** | Dr Inventory / Cr Inventory Adjustment Gain |
| Adjustment Decrease | yes | **yes** | Dr Inventory Adjustment Loss / Cr Inventory |
| Transfer A→B (central account) | yes | **no** | valuation moves between warehouse ledgers; total company valuation unchanged |
| Return-In | yes | **yes** — a financial event must exist | counter-account / reversal / customer impact are **D4**, not D3 |
| Dispatch | yes | yes (existing) | Dr COGS / Cr Inventory — unchanged |

Rules: counter accounts (Opening Balance, Adjustment Gain, Adjustment Loss, GRNI, COGS) must be **configured/approved, never invented or auto-picked**; if the chart lacks them it is a **configuration prerequisite** (fail-closed REJECTED event), not a guess. No generic fallback account. Out of scope: D4 return policy, D5 PPV/VAT, per-warehouse GL accounts, chart redesign, customer/supplier accounting architecture.

**Required proof before closure:** opening→GL; receipt→GL; adjustment ±→GL; transfer A→B no GL with valuation preserved; return-in financial event generated; Dr=Cr; Company A/B isolation; Platform/shared DataSource never touched; no fallback account; real PostgreSQL; regression — and a **reconciliation**: Σ inventory valuation = GL Inventory Control Account after all movements that are supposed to post.

## 2. Evidence-based findings (read from source; T0 baseline: valuation 180 vs GL 100, the 80 = opening stock)

- `recordMovement` publishes `inventory.movement.recorded` only for `INVENTORY_GL_MOVEMENT_TYPES = {dispatch}` (ADR-040 D2). ADR-041 D7/D20 explicitly stated "a receipt has no accounting entry, only a valuation-subledger one" — D3 supersedes that for the movement types above.
- Valuation (`MovingAverageCostEngine`, per product×warehouse) is bootstrapped only for `receipt` with a supplied `unitCostBase` (GR, opening import `referenceType='excel_import'`, and `POST /inventory/movements`). **Adjustments and transfers never touch valuation today** (valuation qty drifts from the stock ledger); transfers (`transfer_out`/`transfer_in`) carry no cost to the destination.
- Warehouse-transaction documents (`receipt`/`adjustment`/`transfer`/`count`) have **no cost field** on their lines and a free-text `reason` (varchar 255) — no coded reason taxonomy.
- Config keys available: `accounting.inventory_cogs_account_code` only. Sibling opening-balance keys exist for AR/AP/Cash (`accounting.{ar,ap,cash_bank}_opening_balance_account_code`) — precedent for the shape. No inventory opening/gain/loss keys exist. (Config values are installation-wide — Gate D / Package 4 — same limitation as every configured account today.)
- Return-In (`return_in`) is not published at all today; `return.completed` is IGNORED by the Financial Core.

## 3. Split

### D3-A — decided, implemented now
1. New config keys (default `''` = fail-closed): `accounting.inventory_opening_balance_account_code`, `accounting.inventory_adjustment_gain_account_code`, `accounting.inventory_adjustment_loss_account_code`. Resolved with `resolveConfiguredPostableAccount` (must exist, active, postable, **non-control**) — no fallback.
2. **Opening stock** (`receipt` + `referenceType='excel_import'` with a supplied cost): publishes the movement event; handler posts Dr Inventory / Cr Opening Balance (config) for qty × the supplied unit cost. GR receipts (`referenceType='goods_receipt'`) are NOT re-published (their own GRNI event already posts).
3. **Adjustment** (`movementType='adjustment'`): increase — cost = the warehouse's current moving-average cost from the valuation engine (the only authorised cost source, ADR-041 D3/D8), valuation increased at that cost, Dr Inventory / Cr Adjustment Gain; decrease — cost consumed from the moving average (`consumeIssueCost`), Dr Adjustment Loss / Cr Inventory. No valuation source ⇒ REJECTED (`no_valuation_source`), never a guessed cost.
4. **Transfer** (paired `transfer_out`/`transfer_in` call sites): valuation carried A→B at A's average cost; **no GL**; total valuation unchanged. If the source has no usable valuation state the physical transfer proceeds and no cost is carried (documented, never blocks an operational move).
5. **Return-In**: movement event published; handler returns REJECTED with reason `return_in: financial treatment is defined by D4 (pending)` — visible and re-drivable once D4 defines the counter-account; not silently ignored, no invented account.

### D3-B — Manual Receipt (CTO decision received 2026-10-04 — implemented, see §8)
*(The paragraph below is the original escalation, kept for the record.)*
**Manual Receipt** (warehouse-transaction `receipt` documents and `POST /inventory/movements` receipts that are neither GR nor the opening import). The approved row requires the offset "by movement reason" with no generic fallback, but (i) warehouse receipt lines carry no unit cost, so no monetary journal can be formed, and (ii) `reason` is free text with no reason→account mapping. Needs a decision on: where the cost comes from (a required unit-cost input on receipt lines? valuation-less receipts forbidden?), and a coded reason taxonomy with its configured clearing accounts. Until decided, these receipts remain as today (stock effect; no GL; valuation only when a cost is supplied) — a known, documented source of valuation↔GL difference.

## 4. D3-A implementation (2026-10-04)

- `inventory.service.ts`: `glKindFor()` replaces the `{dispatch}` allow-list — publishes `inventory.movement.recorded` with a `glKind` for `dispatch`, `opening_stock` (receipt + `excel_import` + supplied cost; payload carries the supplied unit cost/total), `adjustment`, `return_in`. New `recordTransfer()` is the single paired transfer (used by `relocateReservedStock` and warehouse-transaction transfers): `transfer_out` + `transfer_in` + valuation carry at the source average, no GL.
- `inventory-costing-handler.service.ts`: routes on `glKind`. **Every account is resolved before any valuation mutation** — a handler returning `rejected` does not roll back, so the old order (consume cost, then resolve COGS) could leave valuation changed with no journal; this ordering defect existed on the pre-D3 dispatch path too and is fixed there as well (policy unchanged).
- `accounting.manifest.ts` 1.15.0: +3 fail-closed config keys `accounting.inventory_{opening_balance,adjustment_gain,adjustment_loss}_account_code` (resolved with `resolveConfiguredPostableAccount`: exists, active, postable, non-control).
- `inventory-events.contract.ts`: `InventoryGlKind`, optional `glKind` on the event.

## 5. Verification

- **Real-PG A/B** `domains/accounting/interface/inventory-posting.company-isolation.spec.ts` (9/9), full GL pipeline real (D10), real moving-average valuation, inert ambient: opening 10@4.00 → Dr 1120 40 / Cr 3105 40 (valuation 10/40); GR not re-published (GRNI event posts it; valuation 20/100); adjustment +4 → Dr 1120 20 / Cr gain 20 at avg 5.00; adjustment −2 → Dr loss 10 / Cr 1120 10; **transfer 6 WH1→WH2: no journal, no event, valuation WH1 16/80 + WH2 6/30, total unchanged, stock 16/6**; return-in → event exists, REJECTED with the D4 reason, no journal, valuation untouched, stock +1; **reconciliation Σ valuation = GL 1120 = 110.00**, all journals balanced; **fail-closed**: unset gain config → REJECTED (config key named), no fallback account, valuation NOT mutated; after configuring, `redrive` → POSTED and Σ valuation = GL 1120 = 120.00; Company B has 0 rows everywhere, control-plane outbox 0; B's DataSource never requested during A's opening import.
- Build clean; lint clean (D3 files). Frontend not touched.
- **Full regression (one run):** 748 tests — 738 passed, 1 skipped (opt-in T0 spec), 9 failed in 7 suites on the first run. Disposition: `inventory`, `sales-returns`, `shipment-returns` isolation specs — REAL, caused by D3 (their `InventoryService` fixtures passed `{}` as the event bus; `adjustment`/`return_in` now publish) → fixtures now use a real `EventBusService` with the ambient repo still inert; all pass (inventory + sales-returns 23/23 together; shipment-returns 8/8 alone — its first re-run was a suite-level teardown failure). `f03-deadlock`, `attendance-biometric-import`, `payroll-phase1`, `company-membership-provisioning` — transient contention/teardown; isolated serial re-run 31/31 PASS. Wording per CTO: **738/748 first run (+1 skipped), failures isolated and individually cleared** — not "clean", not 748/748.

## 6. Known limits / follow-ups (disclosed)
- ~~D3-B ESCALATED: Manual Receipt~~ — decided and implemented, see §8.
- Opening stock imported WITHOUT a unit cost gets stock but no valuation and no GL (no amount to post).
- `adjustment` events are flushed by the per-Company dispatcher/next flush (`WarehouseTransactionsService` has no in-request flush); the 30 s sweep posts them.
- Return-In: stock only; valuation + GL = D4 (events accumulate REJECTED, re-drivable after D4).
- Config values are installation-wide (Gate D / Package 4) like every configured account.
- Individual `POST /inventory/movements` `transfer_in`/`transfer_out` calls (unpaired) carry no valuation — only the paired helper does.
- Dispatch events already REJECTED on dev data (`negative_on_hand`, `no_valuation_source`) are unaffected.

## 8. D3-B — Manual Receipt (CTO-approved policy, implemented 2026-10-04/05)

**Approved policy (CTO):** a Manual Receipt has an explicit, mandatory Unit Cost; no cost ⇒ REJECT before mutation; no moving-average fallback, no last-purchase fallback, no estimate; accounting value = Quantity × Unit Cost. `reason` becomes a controlled reason code; each financial reason has a configured `Reason Code → Offset GL account` (configuration, not hard-coded); a small initial set covering real cases only (no speculative catalog); missing offset account ⇒ FAIL CLOSED before mutation. Posting: `Dr Inventory / Cr reason-configured offset`, no generic fallback.

**Implementation decisions (within the approved policy, not policy changes):**
- **Config:** `accounting.inventory_manual_receipt_reason_accounts` — a `json` Configuration-Engine key, map `{ "<reasonCode>": "<glAccountCode>" }`, default `{}`. The set of allowed reasons IS this map, so nothing is hard-coded and no catalog is invented; with the default every manual receipt is rejected until Accounting maps at least one reason (configuration prerequisite, same as Opening/Gain/Loss). Accounting manifest 1.16.0. Each target must exist, be active, postable, non-control.
- **Pre-mutation gate across the module cycle:** `foundation/inventory-posting-policy` (registry holder + `@Global()` module) — accounting's `InventoryPostingPolicyService` binds itself at init; `InventoryService`/`WarehouseTransactionsService` read it `@Optional()`. Unbound ⇒ no accounting ⇒ a receipt is rejected (fail-closed), never accepted without validation.
- **Single entry point:** `InventoryService.recordManualReceipt(...)` validates quantity, cost > 0, reason code, and the policy (offset account valid in the Company's chart) BEFORE its first write; then `recordMovement` with reserved `referenceType='manual_receipt'` + the supplied cost (valuation bootstrapped at that cost) and `glKind='manual_receipt'`. `POST /inventory/movements` with `movementType='receipt'` now routes here (DTO gains `reasonCode`); new `GET /inventory/manual-receipt-reasons` lists the configured reasons for the UI.
- **Warehouse receipt documents:** migration `inventory/1789860000000` adds `warehouse_transactions.reasonCode` and `warehouse_transaction_lines.unitCostBase` (additive, nullable). `createTransaction` for `receipt` requires `reasonCode` + a positive `unitCostBase` on every line and validates the policy at creation; `postTransaction` re-validates inside the posting transaction (config may change between draft and post). Free-text `reason` stays a human note and never drives accounting.
- **Event time:** `InventoryCostingHandlerService` `manual_receipt` branch — account for the event's `reasonCode` resolved via the new `HandlerContext.resolveConfiguredMappedAccount(configKey, mapKey)` (same exists/active/postable/non-control validation) BEFORE anything else; otherwise REJECTED naming the reason and the config key (re-drivable). GL only (valuation was bootstrapped at movement time).
- **Frontend:** `WarehouseTransactionForm` (receipt type) — reason-code select (from the endpoint), mandatory per-line unit cost; detail page shows the code. Core terminology migration `1789870000000` (not applied to the dev DB). Frontend type-checks; not browser-verified.
- **Reversal (decision recorded, flag for CTO awareness):** a posted cost-bearing manual receipt can NOT be reversed as a *document* — rejected before any mutation with "post an Adjustment (decrease) instead". Reason: a document reversal cannot exactly unwind valuation (the moving average may have moved) and would have to invent a reversal accounting path the policy did not define; Adjustment decrease already has an approved policy (Dr Loss / Cr Inventory at the consumed average cost) and keeps Σ valuation = GL. Legacy (pre-D3-B, cost-less) receipt documents keep their previous stock-only reversal.
- **Raw `recordMovement(... 'receipt', otherRefType)` callers are unchanged** (Goods Receipt → GRNI; opening-stock import → `opening_stock`; test seeds) to limit blast radius.

**Real-PG proof** — `domains/accounting/interface/manual-receipt.company-isolation.spec.ts` (12 tests, real Company DBs A/B, real GL pipeline, real moving-average valuation, real `InventoryPostingPolicyService`/registry, ambient outbox inert), mapped to the CTO's 10 required cases:

| # | Required case | Test |
|---|---|---|
| 1 | valid cost + valid reason → GL posted | 1 (document path: 10 @ 3.50 → Dr 1120 35.00 / Cr 4201 35.00, valuation 10/35) and 1b (DONATION → its own account 3105, Dr 1120 10.00 / Cr 3105 10.00) |
| 2 | missing cost → rejected, zero mutation | 2 (null / '' / 0 / −1 / 'abc' on the document path; null / undefined / '' / 0 / −2 on the movement path) — snapshot of stock, documents, lines, valuation, outbox, journals identical before/after |
| 3 | missing reason → rejected | 3 (null / '' / whitespace; free-text `reason` alone not accepted) |
| 4 | reason without configured GL → rejected | 4 (both paths; no fallback account) |
| 5 | wrong GL mapping → rejected | 5 (account not in chart; control account) · 5b (config removed between draft and post → post rejected, nothing mutated, document not posted) · 5c (event-time: mapping removed between movement and GL event → REJECTED naming reason + config key, no journal; restored → `redrive` POSTED) |
| 6 | A→A only | 1, 1b, 5c post only in A |
| 7 | B untouched | 7/8 (B has 0 rows in stock, documents, valuation, events, journals, outbox) · 7b (B's own receipt posts only in B; A's snapshot unchanged) |
| 8 | Platform/shared DataSource never requested | 1 and 7b run inside `assertDataSourceNeverRequestedFor` for the other Company; control-plane `event_outbox` = 0 |
| 9 | valuation = GL inventory | 6/9/10: Σ valuation = GL 1120 (= 55.00 = 10×3.50 + 4×2.50 + 2×5.00) |
| 10 | journal balanced | 6/9/10: no unbalanced journal |

Also: 5d — reversal of a posted cost-bearing manual receipt rejected before mutation.

## 7. D3 closure gate — evidence per movement type (real PostgreSQL)

| Movement | Evidence | Spec |
|---|---|---|
| Opening Stock | Dr 1120 40 / Cr 3105 40, valuation 10/40 | `inventory-posting.company-isolation.spec.ts` #1 |
| Purchase Receipt (GR) | not re-published by D3; its own GRNI event posts Dr Inventory / Cr GRNI; valuation +60 | same, #2 |
| Manual Receipt | explicit cost + controlled reason → Dr 1120 / Cr configured offset; every reject path pre-mutation | `manual-receipt.company-isolation.spec.ts` (12) |
| Adjustment Increase | Dr 1120 20 / Cr gain 20 at avg 5.00 | `inventory-posting…` #3 |
| Adjustment Decrease | Dr loss 10 / Cr 1120 10 | #4 |
| Transfer | no journal, no event, valuation carried (WH1 16/80 + WH2 6/30), total unchanged | #5 |
| Return-In | financial event exists, REJECTED with the explicit D4 reason (accounting is D4's) | #6 |
| Reconciliation | Σ valuation = GL 1120 (D3-A: 110.00 → 120.00 after redrive; D3-B: 55.00) | #7, #8; manual-receipt #6/9/10 |

Build, lint (D3 files), affected isolation specs (`inventory`, `warehouse-transactions`, `inventory-posting`, `manual-receipt`: 35/35 together) — see Status for the regression line.

## 9. Regression record (D3-B run, 2026-10-05) and Status

**Full run (one run, JSON-recorded):** 117 suites / 760 tests — 708 passed, 51 failed (17 suites), 1 skipped (opt-in T0 spec). Per CTO wording: **708/760 first run (+1 skipped); failures classified below; NOT "clean", NOT 760/760.**

| Class | Suites | Tests | Disposition |
|---|---|---|---|
| Real-PG harness contention (`relation "user_roles" does not exist` during provisioning under parallel load) | `work-order.company-isolation`, `shipment.company-isolation` | 13 | Re-run serially in isolation: **PASS** (both also passed in the previous full run). Transient, cleared individually. |
| **Dev-DB fixture dependency — (at the time of this run: NOT cleared; superseded by §10: 97/97 on a seeded isolated DB)** | `payroll-phase1`, `integrated-attendance-payroll-commission-gl-e2e`, `hr-phase1`, `attendance-phase1`, `attendance-biometric-import`, `commission-phase1`, `fiscal-period-closing-workflow`, `closing-snapshot-recovery`, `closing-snapshot-key-rotation`, `grni-reconciliation`, `grni-posting`, `wip-reconciliation`, `work-order`, `work-order-phase3-e2e`, `f03-deadlock-retry-verification` | 38 | Deterministic on serial re-run. These specs boot the full `AppModule` against the **shared dev database** and assume seeded fixtures. Read-only inspection of the dev DB (2026-10-05): `users` = 8 rows (fixed approver `f539302e-…` used by the specs is absent), `accounting_gl_accounts` = 2 rows (only `wip`/`wages_payable` created by specs; no `ar`/`inventory` control account, no account `21`/`1120`), 0 journal entries. Failure points are all *before* any inventory code (e.g. `Not authorized to decide this approval request (requires "hr.leave_request.approve")`, `No active `inventory` control account`). The same suites passed in the D3-A regression, i.e. the dev DB was changed/reset after that run — no code in the repo deletes users/chart rows. **I did not modify the dev DB.** |

**Not caused by D3-B on the evidence above, but not proven by a green run either.** Re-seeding the shared dev DB (or pointing these specs at a disposable seeded DB) is a decision for the CTO — see Status.

**Verified for D3 (all green):** build; lint (D3 files); `inventory-posting` (9), `manual-receipt` (12), `inventory`, `warehouse-transactions` isolation specs (35 together); the full real-Postgres isolation set passes in the full run apart from the two harness-contention suites above (cleared serially).

**Dev-DB ruling (2026-10-05, HR/acceptance session + CTO):** `daii_dev` was rebuilt fresh on 2026-10-05 (CTO-authorized; rollback DB `daii_dev_rollback_20261004_2358`), which explains the missing fixtures. **No uncontrolled full jest may run against the shared `daii_dev`** — my D3-B regression runs wrote ambient test data into it before that ruling reached me (the owning session re-cleans; I acknowledged and stopped). Regression for ambient-DB suites runs on isolated test DBs only.

## 10. Closure verification on an isolated, seeded PostgreSQL (CTO directive, 2026-10-05)

**Question:** do the 15 suites / 38 tests that failed because `daii_dev` lost its fixtures work on a sound, isolated PostgreSQL? **Answer: yes.**

**Environment (disposable, dedicated):** new PostgreSQL 18 cluster `127.0.0.1:5656` (own data dir; not `daii_dev`, not the HR session's `5544`); database `d3verify_main`; all 251 repo migrations applied (incl. D3-B's `1789860000000`/`1789870000000`); fixtures seeded **only what the specs hard-code**: users `admin@daii.example` / `debug-admin@daii.example` / `wh-admin@daii.example` (admin role, role id re-pointed to this DB), the 52-account chart of accounts, 2 suppliers, 1 GL-mapped Treasury account, one fiscal year/period covering today — copied read-only from the pre-reset dev copy `daii_dev_rollback_20261004_2358` or created with the same shape the specs use. No application code changed.

**Result (exact, `d3verify-15c.json`): 15/15 suites, 97/97 tests PASSED** (serial, one run on the completed fixture set): payroll-phase1 10/10, integrated-attendance-payroll-commission-gl-e2e 4/4, hr-phase1 15/15, attendance-phase1 12/12, attendance-biometric-import 15/15, commission-phase1 10/10, fiscal-period-closing-workflow 4/4, closing-snapshot-recovery 4/4, closing-snapshot-key-rotation 3/3, grni-reconciliation 3/3, grni-posting 2/2, wip-reconciliation 5/5, work-order 2/2, work-order-phase3-e2e 7/7, f03-deadlock-retry-verification 1/1.
Earlier attempts on the same disposable DB (disclosed): attempt 1 invalid (my seeded `user_roles` pointed at the old DB's role ids → authorization failures); attempt 2 = 75/97 with 22 failures that were all missing fixtures (fiscal year covering today → events REJECTED "No fiscal year covers business date"; second admin user; supplier; GL-mapped Treasury account for the cash/bank reconciliation) — fixed in the test environment, not in application code.

**Classification of every failure seen in the D3-B regression work:**
| Failure | Class |
|---|---|
| 38 tests / 15 suites on shared `daii_dev` (missing approver user, chart, FY, supplier, mapped treasury account) | **fixture/setup issue** (dev DB rebuilt 2026-10-05) — now 97/97 on a seeded DB |
| 13 tests / 2 suites `work-order.company-isolation`, `shipment.company-isolation` (`user_roles does not exist` during provisioning under parallel load) | **infrastructure/teardown contention** — pass serially (and passed in the previous full run) |
| D3-caused regressions | **none** |
| unrelated pre-existing | none observed |

## 11. Final re-verification against the ratified policy (CTO directive "D3 → H3", 2026-10-06)

**Policy ratified by the CTO, unchanged from §1:** Opening Stock → GL · Manual Receipt → GL · Adjustment → GL (configured gain/loss accounts) · Transfer → NO GL · Return-In → financial event, never stock-only (revenue/AR/credit-note/COGS/refund = D4) · Dispatch → GL (existing) · Per-Warehouse Inventory GL → **NO** (Model A, `1120` = Company Inventory Control Account) · missing configuration → FAIL CLOSED. **VERIFY result:** the implementation already matches this policy exactly (`glKindFor` publishes opening_stock / manual_receipt / adjustment / return_in / dispatch; transfer publishes nothing; accounts resolved before any valuation mutation). **No code was changed; nothing was re-implemented.**

**Evidence map (all on fresh disposable real-PostgreSQL Companies A/B, isolated instance 127.0.0.1:5544, run 2026-10-06; D3 migrations `inventory/1789860000000` + `core/1789870000000` applied by the harness):**

| CTO item | Proof | Result |
|---|---|---|
| A Opening Stock → stock + valuation + GL | `inventory-posting` #1; clean-run lifecycle | PASS |
| B Manual Receipt → stock + valuation + GL | `manual-receipt` (12), clean-run lifecycle | PASS |
| C Adjustment ± → stock + valuation + configured GL | `inventory-posting` #3/#4; clean-run | PASS |
| D Transfer → stock moves, no GL, no event, valuation carried | `inventory-posting` #5; clean-run (journal and event counts unchanged) | PASS |
| E Return-In → stock + financial event path | `inventory-posting` #6 (event exists, REJECTED with the D4 reason — no invented account); D4 `returns-accounting` (12): completion posts Dr 1120 / Cr COGS at the original cost | PASS (see limit L1) |
| F Dispatch → existing GL intact | clean-run lifecycle (Dr COGS / Cr 1120 at the moving average); `returns-accounting` setup dispatches; `shipment` isolation | PASS |
| G Missing configuration → FAIL CLOSED | `inventory-posting` #8; `manual-receipt` 2–5; `returns-accounting` #11; clean-run test 2 (REJECTED naming the config key, valuation not mutated, re-drive → POSTED) | PASS |
| H Invariant: GL 1120 = Σ valuation, Σ Dr = Σ Cr, 0 unexplained REJECTED/IGNORED | **new** `d3-clean-run-closure.company-isolation.spec.ts` — Opening → Manual Receipt → Adjustment ± → Transfer → Dispatch: Σ valuation = GL 1120 = 95.00, every journal balances, **0 REJECTED/IGNORED events (all POSTED)**, 0 negative on-hand, stock ledger = valuation quantity per warehouse. Afterwards the only non-POSTED events are the two explained ones (return_in → D4; missing config → named key), and re-drive restores the invariant | PASS |
| I Company A/B isolation | every spec above: B has 0 rows in stock/valuation/events/journals/outbox, control-plane outbox 0, B's DataSource never requested during A's lifecycle | PASS |

**Regression (isolated PG 127.0.0.1:5544, DB env `daii_test_h3_ambient`):**
- D3 core set: `inventory-posting`, `manual-receipt`, `inventory`, `warehouse-transactions`, `inventory-valuation` = 5 suites / 39 tests PASS; D4/returns + `shipment` isolation = 5 suites / 37 tests PASS; new closure spec = 3/3 PASS.
- Domain regression `accounting + inventory-warehouse + inventory-valuation + returns + shipment + procurement` (`jest -w 2`): **first run 41 of 44 suites passed; 263 tests passed, 5 failed, 1 suite skipped (opt-in T0)**. The 5 failures (3 suites: `closing-snapshot-recovery`, `closing-snapshot-key-rotation`, `fiscal-period-closing-workflow`) are **environment/configuration, not D3**: the closing snapshot run ended `failed` with "No Closing Snapshot signing key is configured (CLOSING_SNAPSHOT_SIGNING_PRIVATE_KEY / _KID)" because this worktree has no `.env`. Re-run with a throwaway test key (ephemeral Ed25519, random kid — no repo/dev secret used): **3 suites / 11 tests PASS**. Wording per CTO convention: *263/269 first run (+1 skipped), the 5 failures classified (missing signing-key environment) and individually cleared* — not "clean".
- Baseline comparison: D3-B record §9/§10 (708/760 first run → 97/97 of the dev-DB-dependent suites on a seeded DB; D3-caused regressions: none) — unchanged; no new D3-caused failure.

**Findings (disclosed, no scope opened):**
- **L1 — KNOWN DEFERRED BOUNDARY / D4 DEPENDENCY (not a D3 defect; CTO 2026-10-06): raw `return_in` leaves a 1-unit stock/valuation difference until D4's path values it.** A raw `recordMovement('return_in', …)` with no cost (the legacy `ReturnRequest` path, flagged in D4) writes the stock movement and a REJECTED financial event (D4 reason) but does not touch valuation, so stock ledger − valuation quantity = the returned units. Money invariants (Σ valuation = GL 1120, Σ Dr = Σ Cr) are unaffected. The D4 return-completion path (sales/shipment returns) values the stock at the original dispatch cost and posts; only the legacy raw path remains stock-only. This is the documented D3-A limit (§6), restated: CTO to decide whether the legacy raw `return_in` producer should be routed through D4 or retired (D4 follow-up, not D3).
- **F1 — `t0-clean-company-baseline.spec.ts` (opt-in `T0_BASELINE=1`) is stale since D7**: it builds products as drafts and `ProductLifecycleGate` now rejects the PO (`draft item whose New Item Request has not been approved`). Not D3-related; its role (clean-run reconciliation) is now covered by the new closure spec. Not fixed here.
- **F2 — the three closing-snapshot suites need `CLOSING_SNAPSHOT_SIGNING_PRIVATE_KEY`/`_KID` in the environment** (a fresh worktree/CI has no `.env`); worth recording in the test-environment notes.

## Status (2026-10-06)
**D3 = CLOSED — policy ratified by the CTO, implementation verified against it with fresh real-PostgreSQL evidence (items A–I), regression recorded, no code change.** Limits L1 and findings F1/F2 are disclosed above. Per the CTO sequence: D3 CLOSED → H3 final verification (hosting gate) may proceed.

## Status (2026-10-05 record, superseded by the 2026-10-06 status above)
**D3 = VERIFIED / CLOSED (2026-10-05).** D3-A + D3-B implemented, integrated, real-PG verified (opening, GR, manual receipt, adjustment ±, transfer, return-in event; Σ valuation = GL 1120; A/B isolation; Platform DataSource never requested); build, lint, affected isolation specs, and the full-regression question answered on an isolated seeded PostgreSQL (97/97). Return-in *accounting* stays with D4. `daii_dev` is out of the regression loop. D4 / D5 = HOLD until the CTO releases them.
