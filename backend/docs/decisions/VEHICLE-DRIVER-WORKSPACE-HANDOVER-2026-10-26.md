# Vehicle Driver Workspace — consolidated handover / release-candidate evidence — 2026-10-26

Branch `feature/vehicle-driver-workspace`, head **`aec56be`**. **Not merged, no package, no deployment** (final merge / release / production remain deferred per the CTO decision). Supersedes the Stage C report (`…STAGE-C-REPORT-2026-10-22.md`) where they differ (the expense policy changed to the separate float).

## 1. Commits (this program, oldest → newest)
`71eb4c2` Stage B UI · `5ecdba9` F-1 · `a0682ed` F-2 · `e4d18e4` F-3..F-5 · `2c9a934` accounting review · `4ef30e5` C1 collections/custody record · `a43a7fd` C2 per-item delivery · `766e8af` C3 expenses · `1e137a6` C4 handover/reconciliation · `8804d1b` C5 UI · `e34dcd4` Stage C report · **`8b9c01c` separate expense float (backend)** · `d864c05` float UI · `aec56be` partial-delivery view + chip fix. Design doc for the policy: `VEHICLE-DRIVER-WORKSPACE-EXPENSE-FLOAT-DESIGN-2026-10-26.md` (written before implementation).

## 2. Migrations (all `logistics` tag, additive; none applied to `daii_dev`, original company DBs or production)
`1790040000000` collections confirmation + `shipment_custodies` (legacy `remitted` → `confirmed` backfill) · `1790040100000` `shipment_line_deliveries` · `1790040200000` `custody_expenses` (**corrected in place for the float policy — the feature was never released**: `floatAccountId`, reversal columns, status `reversed`) · `1790040300000` `custody_handovers` · `1790040400000` `vehicles.expenseFloatAccountId`. `down` drops the new objects. Any environment that already ran the *earlier* `1790040200000` (only the isolated verification DB did) must drop `custody_expenses` and its `migrations` row first (script `vw-reset-expenses.js` in the evidence folder).

## 3. The approved policy and how it is enforced
1. Expenses are paid **only** from the vehicle's **expense float** — a GL-mapped Treasury `cash` account assigned to the vehicle (`POST /shipments/vehicles/:id/expense-float`, permission `logistics.vehicle.edit`). Assignment refuses unknown/inactive/unmapped/non-cash accounts and any account that is a collection custody/settlement/shipping-company account or another vehicle's float; unassign refused while the float holds money or claims are open.
2. **Funding / replenishment / return** = ordinary Treasury **transfer documents** (prepare → separate approver → explicit execute) — existing controls, no new posting code.
3. **Claim** fails closed: no vehicle, no float, float not GL-mapped, float equal to a collection account, unmapped `custody_*` category → 409, nothing recorded.
4. **Approval**: every expense, FA-01 engine, maker ≠ checker, live `finance.cash_document.approve`.
5. **Posting**: explicit Treasury cash-out from the float (balance check under the account lock, Financial Event, journal Dr expense account from the posting profile / Cr float's mapped GL). Refused (409) if the float cannot cover it — collections are never a fallback.
6. **Reversal** of a posted expense (`finance.cash_document.reverse`, reason mandatory): Treasury owner-reversal with the same counter, append-only, expense `reversed`.
7. **Collections untouched**: remittance unchanged (gross, per collection, `collection.remitted` the only GL trigger); no net remittance, no netting journal. The reconciliation shows collections and the float as **separate blocks**; `cashInDriverHand = counted collections − handovers` (expenses are not part of it).

## 4. Configuration required in a target company (otherwise the feature fails closed, by design)
- `accounting.treasury_disbursement_reason_accounts` containing the `custody_*` categories (e.g. `custody_fuel`, `custody_toll`) → expense GL accounts (Accounting policy screen/API).
- A GL account for the float (bank-control or equivalent, mapped by Accounting) and the float Treasury account assigned to each vehicle that will claim expenses; vehicle custody accounts GL-mapped.
- An AR control account in the chart (remittance of collections fails closed without it).
- Roles: expense approval `finance.cash_document.approve`, posting `finance.cash_document.execute`, reversal `finance.cash_document.reverse`, collection/handover confirmation `logistics.collection.post`, float assignment `logistics.vehicle.edit`. Role templates were **not** changed; assign deliberately.

## 5. Verification (after the last code change `aec56be`)
| Evidence | Result |
|---|---|
| Real-PG regression, cluster 5546 `biz_t99_` — 18 specs (delivery ×8 incl. C1–C4 + float, shipment ×2, returns ×3, reports, treasury ×3, release-migration-registry) | **18/18 PASS** (`evidence-…/regression-final-18of18.log`) |
| Backend unit suite | 66 suites / **509 tests PASS** |
| Frontend model tests / `tsc` (backend + frontend) / production `vite build` | **14 PASS** / clean / OK |
| Direct HTTP API acceptance on the real running backend (isolated DBs): driver-level authorization, collections, handover, float, reversal (`vw-api-checks3.js`) | **42 PASS / 0 FAIL** (`evidence-…/vw-api-checks3.txt`) |
| Driver authorization re-checked after final UI: driver1 → driver2's workspace / reconciliation / expenses / line events = 404/403; cannot record collection, claim expense or declare handover for another driver/vehicle; cannot assign float, approve, post, reverse, confirm/reject; unauthenticated = 401 | PASS |
| Browser acceptance (isolated preview): all four sections, mobile 375 px (driver) and desktop 1280 px (admin) — 0 overflow, 0 touch targets < 44 px; item delivery recorded through the UI (in-progress → partial; "Partial delivery 1" filter; Deliver disabled while items outstanding); collection recorded, over-collection refused by the server; float card/assignment visible; fail-closed banners | PASS |
| Fail-closed mappings (specs H1/H7/H11 + API): unmapped category, no float, unmapped float, float = collection account, category removed after approval | PASS |

## 6. Preview integration (CTO authorization, port 5173)
5173 (Vite pid 440) and 3500 (backend pid 15544) belong to the **main-checkout development environment**. As instructed I did **not** stop or replace them; the CTO chose **side ports**.
- **Source:** worktree `…/.claude/worktrees/vehicle-workspace`, branch `feature/vehicle-driver-workspace`; backend `dist` built from head `aec56be` (backend sources last changed in `8b9c01c`); frontend served by Vite from the same working tree (`aec56be`). **Backend and frontend are both from this branch — updating only the frontend would not activate Stage C** (the four migrations, the `/vehicle-workspace` read model and the float endpoints live in the backend).
- **Method:** no merge/copy — the preview runs in place from the worktree. **Data:** isolated DBs `daii_test_biz_t96_vw_main` / `_co1` on cluster 5546 (test accounts `admin@`, `checker@`, `driver1@`, `driver2@daii.example`; credentials in the verification folder, not in the repo).
- **Startup:** `cd backend && npm run build`; apply migrations to the isolated company DB (`vw-apply-c.js`); start backend with `DB_NAME=daii_test_biz_t96_vw_main PORT=3697 NODE_ENV=development ENTITLEMENT_MODE=unlicensed-full node dist/main.js` (env from `rehearsal.env`); seed Stage C data `vw-prep-c.js` (float funded by real Treasury documents); `cd frontend && VITE_API_TARGET=http://127.0.0.1:3697 npm run dev -- --host 127.0.0.1 --port 5696 --strictPort`. **URL:** `http://127.0.0.1:5696/` (backend :3697). Nothing runs on 5173/3500 from this branch; if the CTO later wants 5173 itself, that is an explicit replace of the main-checkout services and needs approval and a migrated DB.

## 7. Known limitations / explicit out-of-scope (not hidden)
1. **Inventory / receivables effects of a partial delivery are NOT posted.** The per-item records are operational. The final `delivered` outcome still fulfils the order's reservations for the whole order; units recorded as *returned* must go through the existing Returns flow to restore stock and adjust receivables/credit. No automatic stock return, credit note or AR change is made here.
2. No automatic float top-up, per-driver floats, float limits, or approval thresholds (every expense needs a separate approver; there is no auto-approve).
3. The float assignment screen lists accounts from `/treasury/accounts`, which needs `finance.cash.view`; without it the UI falls back to typing the account id.
4. Reconciliation is per vehicle over all time (cumulative); no period filter.
5. Branch stays free text (D-6); no branch security is claimed.
6. Legacy collections are backfilled by fact only (`remitted` → `confirmed`, others `recorded`).
7. Release engine: the migration-registry negative-control spec was made order-independent (it assumed the newest migration lived in a tag the old registry could not resolve).
8. Verification used `unlicensed-full` entitlement mode and local test cluster 5546; a real-host rehearsal through the unmodified release engine has **not** been done for this branch.

## 8. Release instructions (for when the CTO authorizes — nothing below was started)
1. Final CTO review of this handover; decide the open items in §7 (esp. 1).
2. Merge `feature/vehicle-driver-workspace` into the designated release line (5 migrations; Procurement owns the current version number — do not start a parallel version).
3. Build the package from a `git archive` export (never `npm ci` in a junction worktree), run the full regression and the **unmodified-engine rehearsal** (fresh + upgrade migrations, schema signature).
4. Upload to the test host; configure §4 in the target company; browser acceptance with real driver / cashier / finance-approver accounts.
5. Only then a production decision (separate authorization).
