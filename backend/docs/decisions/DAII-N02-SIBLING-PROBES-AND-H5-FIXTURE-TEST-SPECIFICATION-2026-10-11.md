# DAII — N-02 sibling probes and H5 shipment fixture: test specification — 2026-10-11

Prepared by Team 3 (documentation and coordination) for the track that owns the guarded test harness. **This is a specification only.** It authorises and changes nothing: no product logic, schema, UI, permission or configuration is altered; the tests it describes are local, isolated, read-and-observe probes on the guarded cluster using disposable databases (`daii_test_biz_t<NN>_*`), under the CTO decisions of 2026-10-11 (items 6, 7, 8, 9): *preparation of specific local tests for the unprobed methods, including `relocateReservedStock`, without changing product logic; an isolated shipment fixture proving that the transitions are testable — not a fix and not a closure; any logic change needs a separate authorization; no cluster runs before the cluster is released and the running pipeline has ended; keep implementation, verification and independent review separate; never count working-tree results as clean-snapshot evidence or generalise one path to the whole system.*

Baseline: audit cutoff `b591d1f`; source read at HEAD `520f2e0` (no product-source change since `5c5b791` in the files below). Status vocabulary: PASS / FAIL-DEFECT / BLOCKED / NOT RUN. Nothing here is a confirmed defect: every "predicted" outcome is **INFERRED from reading the code** and must be observed before being reported.

## 1. Rules for every probe

1. **Two calling styles, always:** (A) the *plain manager* a controller passes (`req.companyContext.dataSource.manager`, no open transaction) and (B) the same call inside `manager.transaction(...)`. Report both; a result in one style is never generalised to the other.
2. **Baseline first, no code change:** run on the unmodified product code; record the commit, `dirtyPaths`, spec name, run id. A probe that finds nothing is reported as PASS for *that scenario only*.
3. **Rollback case:** an outer transaction that performs the call and is then rolled back must leave reservations, movements, counters and audit rows as before (note: audit-chain validity after rollback now depends on the F-AUD-003 change; assert chain validity separately and label which commit it ran on).
4. **Conservation oracle** for every inventory probe: Σ active reserved quantity per (order, product) across warehouses, on-hand per warehouse, number of transfer/dispatch movements and number of audit rows must reconcile to the number of *successful* calls.
5. **Evidence:** working-tree runs are labelled working-tree; the closure-grade run is a clean `git archive` snapshot with `DAII_SOURCE_COMMIT` pinned and `dirtyPaths: []`, executed in a window agreed with the track that reserves the cluster, after the running pipeline has ended. **T-03/T-04 are not started until the cluster is released and the current pipeline is finished**, then run individually on a quiet cluster with the evidence preserved.
6. **No bundling:** each probe has its own baseline, report row and acceptance decision; none is folded into the `fulfillReservation` closure or into PA-33.
7. Outcome classes: FAIL-DEFECT = a *candidate* defect for the CTO to judge (reproduction = the spec); BLOCKED = fixture impossible without a decision; never reported as PASS.

## 2. Sibling methods (same "join the caller's manager" idiom)

| Method (file:line at HEAD) | Idiom | Callers (reach, from source) |
|---|---|---|
| `InventoryService.relocateReservedStock` (`inventory.service.ts:1270`) | `manager ? run(manager) : dataSource.transaction(run)`; takes `pg_advisory_xact_lock` on both warehouse keys, then reads/modifies/saves reservation rows and posts a transfer movement and an audit record | `fulfillment.service.ts:334`, `returns.service.ts:234` and `:425`, `shipment.service.ts:1278` (inside `transferCustodyOnPickup`) |
| `InventoryService.releaseReservedQuantityForReference` (`:1457`) | same idiom; lock `"<warehouse>:<product>"`; read-modify-save of reservation rows; audit | `work-order.service.ts:395` and `:722` |
| `InventoryService.releaseReservation` (`:1353`) | no lock at all; reads one reservation, checks `status === 'active'`, writes `released`, audits | `inventory.controller.ts:585` (HTTP, so controller-reachable with the plain Company manager) |
| `LimitService.check` (`limit.service.ts:94`) | read-only gate (`resolve(..., false)`), no increment | `customers.service.ts:142`, `hr.service.ts:188`, `gl-account.service.ts:212` and `:640` |

### Predicted behaviour under a plain manager (INFERRED, to be observed)
With a plain manager the advisory lock is taken in its own auto-committed statement and released at once (the N-01 mechanism), so the read–modify–write over reservation rows is not serialised. The H2 and H3 probes of `T-20` showed the same shape fail for `releaseReservedQuantity` and `fulfillReservation` before they were changed. Whether these siblings behave the same is **not known** and is what the probes establish.

### Probes
| ID | Target | Setup | Action | Expected if safe (acceptance) | What a FAIL-DEFECT would look like |
|---|---|---|---|---|---|
| S1-A/B | `relocateReservedStock` — concurrent relocation | Company A; product P; 5 units on hand and 5 actively reserved for order O at warehouse W1 (custody warehouse W2 empty) | 8 concurrent calls relocating 1 unit W1→W2 for O (style A, then B) | exactly 5 succeed, 3 are refused (409); Σ active reserved for (O,P) stays 5 (W1 0, W2 5); transfer movements = 5; on-hand conserved (W1 + W2 = 5); audit rows = 5 | more than 5 successes, W1 negative or Σ reserved ≠ 5 (lost update on the destination row), transfer movements ≠ successes |
| S1-C | `relocateReservedStock` — rollback and partial failure | as above | (i) relocation inside an outer transaction then rollback; (ii) force the transfer posting to fail after the reservation rows were moved (for example a destination warehouse that cannot receive) | (i) reservation rows, movements and audit as before; (ii) reservation rows unchanged (all-or-nothing) | reservation moved but no movement (or the reverse) |
| S1-D | `relocateReservedStock` — opposite-direction concurrency with another reserving operation | two orders sharing P and warehouses W1/W2 | concurrent `relocate W1→W2` and `relocate W2→W1` (sorted keys) plus a `reserveStock` | no deadlock (40P01) beyond what the PostgreSQL retry model already absorbs; no negative stock | deadlock rate, or inconsistent totals |
| S2-A/B | `releaseReservedQuantityForReference` | 5 units reserved for reference `WORK_ORDER:W` at warehouse W1 | 12 concurrent releases of 1 (A, then B) | exactly 5 succeed, 7 refused; 0 active; audit rows = 5 | more than 5 successes (as the H2 probe showed for `releaseReservedQuantity` before its change) |
| S2-C | rollback | same | release inside an outer transaction, rollback | reservation quantities restored | not restored |
| S3 | `releaseReservation` (whole reservation) | 1 active reservation | 8 concurrent releases by id (A, B) | exactly 1 success, 7 refused; 1 audit row | more than one "released" audit row for one reservation (no quantity effect expected; low severity if confirmed) |
| S4 | Limit gate on real creation paths (`check` is read-only, so it is not itself probed for an idiom defect) | cap `sales.max_customers = 5` (and, separately, `hr.max_employees`) | 10 concurrent creations through the service as the controller calls it (style A) | at most 5 rows created; counter = 5; the rest refused with the limit message | more than 5 rows (the gate and the increment are not atomic on that path) — to be judged against the T-19 results already recorded for customer creation |
| S5 | Reach analysis (documentation) | — | list, from source, which callers pass a plain manager (controller-reachable) versus a transaction manager for S1–S3 | a table "caller → manager style" | — |

## 3. H5 — shipment-transition fixture (isolated; proves testability, fixes nothing)

**Goal.** Make `ShipmentService.transitionShipment` testable in the guarded harness so the existing H5 row stops being BLOCKED, and observe — not fix — its behaviour. A BLOCKED → PASS/FAIL-DEFECT change is a *measurement*, never a closure; any logic change needs a separate authorization.

**Facts from the code (INFERRED where stated).** `transitionShipment` does: authorization check; for `pickup` a waybill/photo precondition for carrier shipments; then `manager ? run(manager) : dataSource.transaction(run)` where `run` performs `processEngine.transition`, `getState`, `recordTrackingEvent`, and for `pickup` `transferCustodyOnPickup` (which calls `relocateReservedStock` for each active reservation), and publishes `shipment.<state>` for delivered/failed/returned. With a plain manager the `processEngine.transition` call opens its own transaction (N-01 rule), but the steps that follow run as separate auto-committed statements (INFERRED) — so a failure in the custody transfer after the state change could leave the state moved without the custody (needs observation).

**Process (from `shipment-process.ts`).** `created → assigned (assign_driver) → picked_up (pickup) → in_transit (depart) → out_for_delivery (arrive_for_delivery) → delivered (deliver) | failed (fail_delivery) → assigned (retry); in_transit → returned (return_to_sender)`.

**Fixture recipe (all through real services in the harness, Company A, disposable DB).** product with stock at main warehouse; customer; sales order brought to the released state with an active reservation (via the existing sales/inventory helpers); fulfilment order and pack task closed so the shipment can be created; a vehicle (its creation provisions a custody warehouse and treasury account, as the isolation spec shows) or a shipping company; `createShipment(fulfillmentOrderId, actor, null, null, vehicleId)`; `assignDriver`. Required test actors: an admin and the assigned driver. Open technical facts the owner must confirm while building: which helper brings a sales order to *released*, and how the fulfilment order and pack task are created without the full approval chain.

| ID | Case | Expected if safe | Observation to record |
|---|---|---|---|
| H5-1 | 8 concurrent identical `pickup` calls (A and B) | exactly 1 succeeds, 7 refused; exactly one custody relocation per product; one tracking event; reservations at the custody warehouse | successes, relocations, tracking events, reservation rows |
| H5-2 | 8 concurrent identical `deliver` calls | exactly 1 success; `shipment.delivered` published once | outbox rows by type, state history rows |
| H5-3 | `pickup` where the custody transfer fails (for example the custody warehouse cannot be resolved or the reservation relocation is refused) | state unchanged and no partial custody (all-or-nothing) | state before/after, reservation rows, movements |
| H5-4 | `pickup` inside an outer transaction, then rollback | state, reservations and movements as before | same |
| H5-5 | legal path end to end with a single caller | state machine reaches `delivered`; inventory and tracking consistent | the oracle table |
| H5-6 | illegal transition and unauthorized actor | refused with the documented errors, no side effect | error codes, no rows written |
If the fixture cannot be built without a product change, the row stays **BLOCKED** with the exact missing helper recorded — it is never reported as a pass.

## 4. Deliverables and ownership
| Item | Owner (proposed) | Output |
|---|---|---|
| Spec files (new, test-only) and runner registration | verification track | specs under `src/foundation/testing/`, one step per probe family |
| Baseline and closure-grade runs | verification track, in an agreed window | evidence bundles with pinned headers |
| Independent review of the probes and results | a reviewer who did not write the probes or the code under test | written conclusion |
| Specification, status tracking, coordination | Team 3 | this document, planning-document updates |
Packages: `WP-INV-09` (sibling probes) and `WP-INV-07` (H5 fixture), each separate from `WP-INV-02` (fulfil-fix review) and from the PA-33 packages.
