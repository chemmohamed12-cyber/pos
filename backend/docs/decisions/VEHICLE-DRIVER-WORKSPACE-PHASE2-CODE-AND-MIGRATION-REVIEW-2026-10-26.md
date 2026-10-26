# Vehicle Driver Workspace — Phase 2: code, migration and financial-approval review — 2026-10-26

Reviewed head: `c7a3f6f` (branch `feature/vehicle-driver-workspace`). Method: read every changed source file, the five migrations, and exercise each rule on real PostgreSQL. Defects found are listed in §5 with the commit that fixed them.

## 1. Was the edited migration ever applied in its old form? (item 3)
`1790040200000-CreateCustodyExpenses` was committed in `766e8af` (custody-account version) and corrected in `8b9c01c` (float version). Evidence that no target applied the old form:
- **Never packaged**: all 17 zips in `_release-output/` (1.0.10 … 1.1.13) contain **no** `179004…` migration (`unzip -l` scan).
- **Main dev instance (read-only query, `default_transaction_read_only`)**: `daii_dev` max migration timestamp `1790034600000`; the 9 `company_*` databases max `1790033400000`; `daii_dev_rollback_*` `1789840000000`; **0 rows ≥ `1790040000000` in any database readable** on 5433 (some historical `daii_*` databases deny access and are unrelated test leftovers).
- **Cluster 5546 (tests)**: databases are disposable and re-created per run; the only long-lived one that ever held the old version, `daii_test_biz_t96_vw_co1`, was explicitly reset (`DROP TABLE` + migrations row removed) before the corrected migration ran; the rehearsal (`t98`) databases only ever saw the corrected version.
- The branch was never merged, so no release line contains the old file. **Conclusion: safe to keep the in-place edit.** Had any environment applied the old version, a forward migration would have been required instead.

## 2. Migration-by-migration review (all `logistics`; all idempotent `IF NOT EXISTS`; timestamps strictly after every existing migration on the base line)
| Migration | What it does | Review result |
|---|---|---|
| `1790040000000` AddCustodyRecordAndCollectionConfirmation | `shipment_custodies` (unique number, unique shipment); `collections` + `verificationStatus`(default `recorded`), `confirmedBy/At`, `rejectionReason`, `clientKey` (partial unique), `custodyId`; backfill `remitted → confirmed` | Additive. Backfill is **fact-based only** (a remitted collection was posted by finance; unremitted stay `recorded`). No amount/ledger touched. `down` drops the columns/table (confirmation history lost — documented). Verified on a DB with legacy collections (VW preview) and by upgrade==fresh schema equality. **OK** |
| `1790040100000` CreateShipmentLineDeliveries | append-only per-line events, `CHECK kind IN (...)`, `CHECK quantity > 0`, unique `clientKey` | Additive; the invariant delivered+returned ≤ shipped is enforced by the service under a per-shipment advisory lock (tested concurrent, G5). **OK** |
| `1790040200000` CreateCustodyExpenses (corrected in place) | claim table: `floatAccountId` (NOT the collection custody account), status `CHECK` incl. `reversed`, reversal columns, unique number/`clientKey` | Additive; GL accounts are never stored (category = posting-profile reason code). **OK** (§1 covers the edit) |
| `1790040300000` CreateCustodyHandovers | operational handover record | Additive; moves no money; maker≠checker in the service. **OK** |
| `1790040400000` AddVehicleExpenseFloatAccount | `vehicles.expenseFloatAccountId`; **after the Phase 2 review**: unique index (one float ↔ one vehicle) + `CHECK` float ≠ custody/settlement account | Additive and nullable; the constraint is a DB backstop — a vehicle that already has custody == settlement is unaffected (float is NULL). **OK** (unreleased, so editing it in place is equally safe — §1) |
Release-engine evidence (Phase 3): 299 → 325 migrations, each exactly once, platform and Company DB; **upgrade schema == fresh-install schema** (`ac36b89c…`, `62151525…`); `down()` ×26 returns to the 1.1.10 baseline schema byte-for-byte (`b6a0900c…`, `4423d1fa…`).

## 3. Financial approvals and posting controls (item 4) — each rule, where it is enforced, how it was tested
| Control | Enforcement | Test |
|---|---|---|
| Float assignment | `POST /shipments/vehicles/:id/expense-float`, `logistics.vehicle.edit`; service refuses unknown / inactive / un-GL-mapped / non-cash accounts, any collection custody/settlement/shipping-company account, another vehicle's float; unassign refused with money or open claims; DB unique index + CHECK as backstop | specs H11, H13, H14 (incl. a concurrent race, exactly one wins, DB rejects float==custody) |
| Funding / replenishment / return | ordinary **Treasury transfer documents** (prepare → separate approver `finance.cash_document.approve` → execute) — existing controls, no new posting code | live: prep script funded the float through real documents (approval by a second user) |
| Claim | driver or admin of the shipment; fail closed (no vehicle/float, unmapped float or category) | H1, H7 + API checks |
| Expense approval | FA-01 engine, **every** expense, maker≠checker, live `finance.cash_document.approve` | H3 + API ("claimant cannot approve") |
| Posting | explicit, `finance.cash_document.execute`; existing Treasury cash-out (per-account lock, balance check, Financial Event, **publish-time posting guard — closed fiscal period / unmapped account refuse**), idempotent | H4, H5, H12 (closed period), API |
| Reversal | `finance.cash_document.reverse` + reason; Treasury owner-reversal with the same posting-profile counter (append-only), idempotent | H10, API |
| Collections untouched | expenses read/write only the float; reconciliation keeps collections and float separate; **collections can never be remitted/settled into a float** (remit override, vehicle settlement, shipping-company account setters refuse) | H4/H5/H9 (custody balance & GL 1190 unchanged), H13, K5, K8 |
| GL / settlement / AR | expense journal Dr (reason→account of the posting profile) / Cr float's mapped GL; remittance (`collection.remitted`) unchanged and still fails closed without an AR control account (found by spec K4) | H4, H9 (Treasury == GL, journals balanced), K4 |

## 4. Compatibility with Inventory / Procurement / Treasury / posting policies (item 5)
- Branch base is `release/1.1.11` (`c85479e`): it already contains Procurement, Treasury, Inventory C1 etc. Regression on top of that base: Treasury (ledger, documents, posting integrity, HTTP), customer payment reversal, accounting policy config, returns, reports, shipment, delivery and the release-migration registry — see the final report for the run.
- New contract method on the shared `FinanceTreasuryContract` (`cashOutForCustodyExpense`, `reverseCustodyExpense`) is additive; the only implementer is `TreasuryService`.
- No inventory or procurement code path was changed. Partial-delivery records post no stock or receivable effect (documented limitation).
- Conflicts with *other* feature branches are analysed in the merge plan.

## 5. Defects found in this review and fixed (each re-tested)
1. **Authorization inconsistency** — the direct reconciliation route let any fleet reader (e.g. a role with only `logistics.vehicle.view`) read collection/handover/float figures that the workspace read model hides from that role. Fixed: one rule `VehicleAccessService.canSeeVehicleCash` (assigned driver | `act_any` | `logistics.collection.view`) for both. Test K7.
2. **Wrong float reconciliation after a reversed funding transfer** — the funded total excluded the reversed original but included its reversal leg, producing a false difference. Fixed: mirror the Treasury balance rule (every leg counts). Test K8.
3. **Float uniqueness race / data drift** — nothing prevented two vehicles claiming the same account concurrently, or a float equal to a collection account. Fixed: unique index + CHECK (migration `1790040400000`, unreleased) and a service conflict mapping. Tests H13/H14.
4. **Collections could be remitted into a float** through the explicit `treasuryAccountId` override of `remitCollection`, or by setting a float as a vehicle settlement / shipping-company account. Fixed in all three entry points. Tests H13, K8.
5. **Release build gate** — the official `tsc -b` of the frontend failed (`filterByTab` lost the row type, so `lineProgress` was missing); `tsc --noEmit` and `vite build` had both passed. Fixed in `c7a3f6f`; also removed a backend lint error. (Lesson recorded: `tsc -b` is the gate, not `--noEmit -p`.)
6. Posting-guard coverage for the new payout was untested — added H12 (closed fiscal period refuses and leaves the expense approved).

No defect remained open from the review. Items intentionally *not* changed are listed as limitations in the final report.

## 6. The four reviewed fixes — previous behaviour, new behaviour, tests (scope check)
| Fix | Before | After | Tests | Scope note |
|---|---|---|---|---|
| **Visibility consistency** (`8a36b05`) | `GET /delivery/custody-reconciliation/:vehicleId` allowed any user who could read the vehicle (e.g. a role with only `logistics.vehicle.view`); the workspace endpoint hid the same figures from that role | both use `VehicleAccessService.canSeeVehicleCash`: assigned driver, `act_any`, or `logistics.collection.view`; others get 404 | K7 (fleet-only → 404; collection-viewer and driver → 200); W4 unchanged | within Stage C; no change to existing endpoints |
| **Float uniqueness and guards** (`8a36b05`, migration `1790040400000`) | nothing stopped two vehicles sharing a float, or a float equal to the vehicle's own custody/settlement account (service check only, racy) | service conflict + unique index + `CHECK`; DB error codes 23505/23514 mapped to 409 | H11, H13, H14 (concurrent race: exactly one wins; DB rejects float==custody) | migration unreleased → edited in place (§1) |
| **Funded-total calculation** (`8a36b05`) | float expected balance used only `status='posted'` legs: after a reversed funding transfer the reversal leg counted but its original did not → false difference | every leg counts, exactly like `getAccountBalance` (reversal legs offset their originals) | K8 (reversed funding → balance/expected/difference `0.00`) | read-model only; no posting change |
| **Remit-into-float guard** (`8a36b05`) | `remitCollection(..., treasuryAccountId)` and the vehicle-settlement / shipping-company-account setters would accept a float account, putting customer collections into the driver float | all three refuse an account that is any vehicle's float (`assertNotAnExpenseFloat`) | H13 (setters), K8 (remit override; collection stays `pending`) | **behaviour change on two pre-existing endpoints and on remit, only when the target is a float** — directly required by the approved policy (collections never touch the float); no change otherwise (regression 22/22) |
No fix altered an accounting posting rule: payout/reversal reuse the existing Treasury cash-out/owner-reversal; remittance posting is untouched.

## 7. Technical results vs business / accounting approvals (kept separate)
Technical gates (this document, regression, rehearsal) do **not** substitute for the approvals below, and the approvals do not substitute for the tests. **Business / accounting approvals still required and not yet given** (see the final report §6): finance-owner confirmation of the float GL account and the `custody_*` expense categories→accounts per target company; who holds the approve/post/reverse roles; owner decision on inventory/receivable effects of partial delivery; owner/CTO acceptance of the open limitations; version number/ordering decision for the release.
