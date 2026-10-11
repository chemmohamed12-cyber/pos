# WP-INV-07 — H5 shipment-transition testability: result (verification session), 2026-10-11

**Scope kept:** test-only. Commit `06ef615` adds `src/foundation/testing/t25-h5-shipment-transitions.biz.real-pg.spec.ts` (new) and one registration line in `tools/testing/biz-run.js`. **No product code, schema, permission or shared-infrastructure change.** The fixture needed none of them (diff reviewed: 2 files).

**Fixture (declared doubles):** real `ShipmentService`, `ProcessEngine`, `InventoryService`, numbering, audit, authorization and the company database. Doubles: fulfilment-order / sales-order read contracts (fixed answers over real `sales_orders`/`sales_order_lines` rows), customers/users/treasury (unused on these paths), and an event bus that records published topics (the real outbox is *not* exercised, so "published once" is a statement about calls to `publish`). The vehicle and its custody warehouse are inserted by SQL (`createVehicle` needs the whole treasury chain; covered by the shipment isolation spec). T-20's H5 row is left BLOCKED as written; T-25 supersedes it as the measurement.

**Provenance:** clean `git archive` of `06ef615e5f6dfde80c52455a62b297c9cdabb16a` (`evidence-clean-snapshot-2026-10-11/06ef615-h5/`, `SOURCE_COMMIT.txt`), run header `commit 06ef615…`, `dirtyPaths: []`, exit 0, databases `daii_test_biz_t25_*` created and removed, other databases unchanged (`post-cleanup.json`). Two earlier attempts in the snapshot failed before any case ran (missing build; leftover `daii_test_biz_t25_*` databases of an earlier working-tree attempt, dropped by name) — they wrote no evidence. A working-tree dry run (not evidence) gave the same classification.

| Case | Style | Result | Observation |
|---|---|---|---|
| H5-1 concurrent pickup ×8 | plain manager | PASS | 1 success, 7×409; 1 pickup tracking event; 4 relocation movements (2 products); reservations moved to custody |
| H5-1 | transaction manager | PASS | same |
| H5-2 concurrent deliver ×8 | plain | PASS | 1 success, 7×409; `shipment.delivered` published once |
| H5-2 | transaction | PASS | same |
| H5-3 pickup, custody transfer fails | transaction | PASS | error 23503; state, reservations, movements, tracking unchanged |
| **H5-3 pickup, custody transfer fails** | **plain manager (what `POST /shipments/:id/transition` passes)** | **FAIL-DEFECT (observation)** | the call fails (FK 23503) but **state is already `picked_up`**, a `pickup` tracking event and a transition record exist, **one of two reservations at the main warehouse was drained (active 2→1) and no reservation exists at the custody warehouse**; no relocation movement written |
| H5-4 pickup then outer rollback | transaction | PASS | state/reservations/movements/tracking identical to before |
| H5-5 legal path, single caller | plain | PASS | assigned→picked_up→in_transit→out_for_delivery→delivered; 5 transition records, one tracking event per step |
| H5-6 illegal transition / unauthorized actor | plain | PASS | 409 for `deliver` from `assigned`; 403 for non-driver and for a dispatcher-only action; no side effect |

Totals: 8 PASS, 1 FAIL-DEFECT, 0 BLOCKED, 0 SKIPPED.

## New candidate defect (documented, NOT fixed, scope not widened)
**H5-D1 — partial custody transfer on the controller path.** `ShipmentController.transition` passes the Company DataSource's plain manager; `transitionShipment` then runs `run(manager)` with no transaction, so the state change, the tracking event and each reservation relocation commit separately. If the custody transfer fails midway, the shipment is left `picked_up` with part of its reservations released and not re-created at the custody warehouse — a lost reservation (oversell exposure) and a state that cannot be retried (`pickup` is no longer legal). Trigger needs a failing relocation (for example a vehicle whose custody warehouse no longer exists, or insufficient active reservation); it is not a race. Same root cause class as N-01/N-02 (plain-manager pattern), and the same fix shape would apply (run the body through `runInTransaction`) — **that is a product change and needs its own authorization.** The DeliveryService path is protected (it passes a transaction manager; H5-3 transaction PASS).

## Status
- WP-INV-07: **testability DONE** (all six H5 cases executed). H5 is no longer BLOCKED.
- H5: measured — concurrency (H5-1/2), rollback (H5-4), authorization (H5-6) behave as required; **H5-3 plain-manager shows a defect (H5-D1)**.
- N-02: **OPEN** (a new open item, H5-D1, was added by this measurement). PA-33 OPEN. CI NOT GREEN (LA-1 lint, unchanged). Release NOT APPROVED.
- Limits: event bus is a recorder; tested shape is 8-way, 2 products, one vehicle; no carrier (shipping-company) path; no delivery-service end to end.
