# Vehicle Driver Workspace — Stage C consolidated report — 2026-10-22

Branch `feature/vehicle-driver-workspace` (worktree `vehicle-workspace`). **Nothing merged to `main`, nothing deployed, no production or `daii_dev` data touched, no version change.** Local test success is not a release decision (CTO instruction); the remaining release steps are in §6.

## 1. What was delivered (isolated commits, each with its own tests)
| # | Commit | Scope |
|---|---|---|
| F-1 | `5ecdba9` | Server-side permission/scope on vehicle list / overview / shipping-company overview (`VehicleAccessService`; denied = 404). |
| F-2 | `a0682ed` | COD enforced on the server: no `delivered` outcome without a collection; collection recording is one transaction under a per-shipment lock; amount validated before any posting. |
| F-3..F-5 | `e4d18e4` | One permission-checked workspace read model `GET /vehicle-workspace/:id` (driver display name without user-list permission, vehicle filter on the backend, complete batched collection read with per-shipment visibility). |
| review | `2c9a934` | Accounting/Treasury review per operation **before** any new financial entity. |
| C1 | `4ef30e5` | `shipment_custodies` + collection confirmation: several collections per shipment under Σ(recorded+confirmed) ≤ expected; driver records / **someone else** confirms or rejects (rejection reverses the custody leg append-only); idempotent `clientKey`; remit re-checks under the lock and auto-confirms a recorded collection. |
| C2 | `a43a7fd` | `shipment_line_deliveries` (append-only): per-line delivered / returned, never above shipped, only while out for delivery; "partially delivered" is **derived**; `delivered` outcome needs every line accounted for once events exist. |
| C3 | `766e8af` | `custody_expenses`: claim fail-closed (category must be a mapped `custody_*` reason of the company disbursement posting profile **and** the custody account GL-mapped); **every** expense needs a separate approver through FA-01 (maker ≠ checker, live permission); posting is an explicit existing Treasury cash-out (balance check, lock, Financial Event, audit). |
| C4 | `1e137a6` | `custody_handovers` (driver declares ≤ cash he is expected to carry; confirmation by someone else) + server-side reconciliation; expense posting serialised with handovers. |
| C5 | `8804d1b` | UI for all of the above; the browser only displays server-computed figures. |

## 2. Migrations (all additive, `logistics` tag, no data rewrite except the C1 fact-based backfill)
`1790040000000-AddCustodyRecordAndCollectionConfirmation` (legacy `remitted` → `confirmed`, others `recorded`), `1790040100000-CreateShipmentLineDeliveries`, `1790040200000-CreateCustodyExpenses`, `1790040300000-CreateCustodyHandovers`. `down` drops the new objects (history lost once in use → forward-fix). Applied and verified on the isolated copy `daii_test_biz_t96_vw_co1` (which holds legacy collections).

## 3. Existing engines reused — nothing invented
Treasury cash-in/cash-out/`reverseOwnedLeg`, `collection.remitted` as the **only** GL trigger for collections (unchanged), FA-01 approval engine, numbering engine, advisory locks/`runInTransaction`, Accounting Policy `treasury_disbursement_reason_accounts`. One additive contract method (`cashOutForCustodyExpense`). No new permission node, no new GL account, no netting journal.

## 4. Test evidence (this session, cluster 5546 namespace `biz_t99_`, test DBs only)
- New real-PG A/B specs: C1 E1–E9 + W8, C2 G1–G7, C3 H1–H9, C4 K1–K6 (+ pure unit spec) — all pass.
- Updated (legitimately changed invariant): F-2 spec D2/D6 messages (second instalment is now allowed up to the expected total); constructor signatures in 3 specs.
- `release-migration-registry.real-pg.spec.ts` negative control was **order-dependent** (it assumed the newest migration lives in a tag the old 6-tag registry cannot resolve); it now computes the expected leading run from the data. Passes 21/21.
- Backend unit suite 509/509; frontend model tests 13/13; `tsc` clean (backend + frontend).
- Final regression list (18 specs: delivery ×8, shipment ×2, returns ×3, reports, treasury ×3, release registry): 18/18 pass, see §7.
- Browser (isolated env :5696 → :3697): custody reconciliation renders legacy data consistently (counted 1,600 / expected account 700 = Treasury balance 700); a 500 instalment recorded on a 1,200 COD shipment (remaining 700 shown); an 800 over-collection refused by the server with its message; mobile 375 px: no horizontal overflow on sheet / custody / expenses / summary.

## 5. Known limitations / open items (not hidden)
1. **Accounting-policy blocker (finance owner):** an expense paid from collected cash lowers the custody balance that the *gross* remittance expects. Until the owner picks (A) remit net, (B) separate float, or (C) other, posting is refused when the custody balance does not cover it and remittance stays gross and fail-closed. The reconciliation shows both figures separately; no netting is booked.
2. **No expense reversal** after posting yet (only cancel before posting). A reversal would use the document-style reverse path and needs the same policy decision.
3. **Partial delivery does not post stock/AR**: the final `delivered` outcome still fulfils the order's reservations; units that came back go through the existing Returns flow. A short-delivery credit/stock effect is a Returns-Engine decision.
4. **Custody accounts / categories must be mapped by Accounting** (`custody_*` reasons in `accounting.treasury_disbursement_reason_accounts`; custody account GL code). Until then the UI says so and no claim is possible.
5. Expense approver reuses `finance.cash_document.approve`, poster `finance.cash_document.execute`, collection/handover confirmation `logistics.collection.post` — role templates were not changed; the *driver* role has no approval power (verified by maker ≠ checker, not by the UI).
6. Reconciliation is per vehicle over all time; a period filter was not added (cumulative cash-in-hand semantics).
7. Driver-role browser pass (login as `driver1`) was not repeated after C5; driver permissions are covered by the real-PG specs (W1–W4, K2) and the existing Stage B pass.
8. Branch remains free text (D-6); no branch security is claimed.

## 6. Remaining release steps (none started)
1. CTO/finance decisions: §5.1 (expenses vs gross remittance), §5.3, expense reversal policy.
2. Accounting configuration in the target company: `custody_*` reason→GL map, GL-map vehicle custody accounts, `ar` control account present (remittance fails closed without it — found by spec K4).
3. Merge approval of `feature/vehicle-driver-workspace` (4 migrations) into the release line; **Procurement owns 1.1.12/1.1.13 — do not start a parallel version**; build a package only after merge and run the unmodified-engine rehearsal.
4. Upload/deploy on the test host (no access from this environment), then browser acceptance with real roles (driver, cashier, finance approver) before any production decision.

## 7. Final regression run
**18/18 PASS** on cluster 5546 (`biz_t99_`): delivery ×8 (incl. the four new Stage C specs and the pure unit spec), shipment ×2, returns ×3, reports, treasury ×3, release-migration-registry (21 tests). Backend unit suite 509/509 re-run after C5.
