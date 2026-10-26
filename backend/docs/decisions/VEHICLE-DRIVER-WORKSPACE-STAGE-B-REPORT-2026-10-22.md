# Vehicle Driver Workspace — Stage B report (mobile UI + read model) — 2026-10-22

Branch `feature/vehicle-driver-workspace` (worktree `.claude/worktrees/vehicle-workspace`, from `release/1.1.11` c85479e; Stage A design `f32a57d`). Approved decisions D-1…D-6 applied. **Stage B only**: nothing in Stage C was started. Nothing merged, pushed, deployed or released; no production, `daii_dev` or original company database touched.

## 1. What was built (frontend only)
| File | Role |
|---|---|
| `frontend/src/pages/vehicle-workspace/VehicleWorkspace.tsx` | The workspace page: header, four sections (Shipments / Custody / Expenses / Trip summary), shipment details sheet, existing actions |
| `…/VehiclePicker.tsx` | Entry points `/my-vehicle` (a driver with exactly one active vehicle goes straight in) and `/vehicle-workspace` (list) |
| `…/workspaceModel.ts` | **Pure read model**: state→tab mapping, counts, action availability, custody row status, trip summary, current trip, vehicle availability. No React, no network, no money arithmetic |
| `…/vehicle-workspace.css` | Mobile-first styles (logical properties → RTL/LTR), 44 px+ touch targets, sticky filters, fixed bottom nav, wide-screen two-column layout |
| `frontend/tests/workspaceModel.test.ts` + `scripts/test-model.mjs` (+ `npm run test:model`) | 8 DB-free tests of the model |
| `frontend/src/App.tsx` (+6 lines) | Three standalone routes outside `<Layout>` (full-screen on phones): `my-vehicle`, `vehicle-workspace`, `vehicle-workspace/:vehicleId` |
| `frontend/src/pages/CustodianDetail.tsx` (+7 lines) | One added link "Vehicle & driver workspace" next to Print. **The existing custody-closing workflow is unchanged** |
**Backend, schema, migrations, accounting, permissions, collection invariants: no change** (`git diff release/1.1.11` touches no `backend/src`, `backend/tools` or migration file). No new endpoint, no new write path, no new permission node, no terminology migration (labels are inline AR/EN like the Treasury workspace).

## 2. Existing APIs reused (all already in the product)
`GET /shipments/vehicles` · `GET /shipments/vehicles/:id/overview` (stock + Treasury custody balance + active count) · `GET /shipments` (driver sees own, board viewers all) · `GET /shipments/:id/detail` · `GET /shipments/:id/tracking` · `GET /delivery/collections?shipmentId=` · `GET /products/all` · `GET /admin/users` (driver name, when allowed).
Writes are **only** the existing driver actions, validated again by the server: `POST /shipments/:id/transition` (`pickup`, `depart`, `arrive_for_delivery`) and `POST /delivery/outcomes` (`delivered`, `failed` + reason).

## 3. Supported versus unavailable (shown honestly, never as zero)
| Requirement | Stage B result |
|---|---|
| Mobile header: code, plate, driver, **free-text branch**, status | Done. Driver name resolves for the driver themself and for users allowed to list users, otherwise "Name not available" (the only user-list endpoint is platform-only) |
| Shipments tabs with counts from canonical states | Done: New / Ready for pickup / Picked up / On the way (in_transit + out_for_delivery) / Delivered / Failed / Returned. **"Partial delivery" is a disabled chip "n/a"** — no data source (D-1) |
| Shipment details: lines, quantities, history, actions | Done: customer/address/phone/governorate (when returned by the existing API), item names + SKU, **shipped quantity** and **quantity currently available in the vehicle** (from the vehicle stock row; "no stock recorded" when absent), tracking history, existing actions with confirmation for deliver/fail |
| Delivered / remaining quantity per line | **Not available** (not recorded in the system) — stated on screen, not faked |
| Custody view | Treasury custody-account balance exactly as the ledger reports it + per cash-on-delivery shipment the **existing collection record** (amount, method, date, remittance state). No balance arithmetic, no "outstanding" figure |
| Expenses | Honest "not available yet" panel; no form, no fake records |
| Trip summary with drill-down | Done from verifiable data; each tile drills into the underlying list. Collections awaiting confirmation, expenses awaiting review, cash handed over, partial deliveries: **"Not supported yet"** tiles |
| Cash-on-delivery shipments | "Record delivery" is **disabled with an explanation** and a link to the existing shipping screen: that screen records the collection together with the delivery, and the workspace has no collection write in Stage B (avoids a delivered shipment without its collection) |
| Large touch targets, bottom nav, RTL, contrast, loading/empty/error/retry, duplicate-action protection | Done (details §5) |
| Current trip | Derived: the vehicle's open shipments (oldest first) — no trip entity |

## 4. Tests run (all actual)
| Check | Result |
|---|---|
| `tsc -b` (frontend) | clean |
| `oxlint` on the touched files | 0 errors (1 `set-state-in-effect` warning of the same kind the repo already carries) |
| `npm run build` | OK |
| Read-model tests (`npm run test:model`) | **8/8 pass**: tab↔state mapping and counts add up, no partial-delivery tab, failed is open/terminal rules, unknown state stays visible, action table incl. COD and permission reasons, custody status only from the collection record, trip summary exact and `null` (not 0) when collections are unreadable, current trip order / availability `null` |
| Server-side checks behind the screen (driver token, real backend `dist`, isolated DBs) `vw-api-checks.js` | **10/10 pass**: a driver sees only his own shipments (9 of 12); another driver's detail, tracking, collection record, transition and outcome → 403; invalid transition (pickup on out_for_delivery) → 409; unknown action → 403; non-driver action (`return_to_sender`) → 403; **all refused attempts changed no shipment state** |
| Regression: existing shipment / delivery / returns / collection / shipment-transition real-PG specs (8 specs, namespace `biz_t99_`, cluster 5546) | **8/8 pass** (delivery, shipment, returns, shipment-returns, returns-accounting, sales-returns, T-06 collection idempotency, T-25 shipment transitions) — as expected, since no backend code changed |
| Backend unit/regression for unchanged code | not re-run beyond the above (no backend change) |

## 5. Browser verification (isolated environment)
Environment: clones of the upgraded 1.1.11 rehearsal DBs (`daii_test_biz_t96_vw_main/_co1`), the 1.1.11 backend slot on :3696 (unchanged code), this worktree's Vite on :5696. Data: 2 drivers (company role `driver`), 2 vehicles created through the real API (custody warehouse + custody Treasury account provisioned by the product), 12 shipments in every canonical state, vehicle stock, 2 COD collections recorded through the real API (one remitted by finance). Screenshots in `evidence-2026-10-22-vehicle-workspace-stage-b/screenshots/`.
- **Driver, phone 375×812, Arabic/RTL**: `/my-vehicle` goes straight to the driver's vehicle; header, status chips with counts (9 shipments: the unassigned one and the other driver's are not visible), cards, COD collection state ("remitted", "recorded — awaiting remittance", "no collection recorded"); details sheet (items with SKU, shipped qty, vehicle availability 12 / 6, honest note, history); **delivery of a non-COD shipment through the real endpoint** (confirmation → shipment became *Delivered*, counts updated); **pickup** (became *Picked up*, next action "Start trip" offered); COD shipment: "Record delivery" disabled with the explanation, "Record failed delivery" available; Custody (700.00 = the Treasury custody balance after 900.00 of 1,600.00 collected was remitted; 2 collections recorded, 1 remitted), Expenses (unsupported panel), Trip summary (counts consistent with the list; unsupported tiles marked).
- **English/LTR, phone**: no horizontal overflow in any of the four sections or the sheet; **no interactive element under 44 px** (measured); language switch available in the header.
- **Admin, desktop**: vehicle list → workspace; all 10 shipments of the vehicle (incl. the unassigned); sticky header/nav, two-column layout with the details panel.
- **Network failure**: with the backend stopped, "Refresh" keeps the last data and shows "The last refresh failed — showing data from the last successful load. Retry".
- **Foreign vehicle**: a driver opening another vehicle's URL gets "not assigned to you and no permission to view vehicles" (see finding F-1).
- `CustodianDetail` still shows the closing-custody panel and its "cannot close while active shipments" rule; the new link is the only change.

## 6. Findings (for Stage C / the owner)
- **F-1 (pre-existing, security): `GET /shipments/vehicles` and `GET /shipments/vehicles/:id/overview` have no permission or scope check** — any authenticated user of the Company can read every vehicle's stock and custody balance (verified with the driver token: HTTP 200). The workspace hides a foreign vehicle in the UI, but that is a hint, not security. Stage C must add a server-side guard (assigned driver or `logistics.vehicle.view`) before any custody figure becomes sensitive. Not changed in Stage B (no backend change allowed).
- **F-2:** `POST /delivery/outcomes` accepts `delivered` for a cash-on-delivery shipment with no collection (existing behaviour); the workspace prevents it in the UI only. A server-side rule belongs to Stage C with the collection model.
- **F-3:** driver display name is not resolvable for users without access to the platform-only `GET /admin/users`; a Company-scoped name lookup is a small Stage C/backend item.
- **F-4:** `GET /shipments` has no vehicle filter, so the workspace filters client-side (a board viewer receives all shipments); a `vehicleId` filter + paging is a Stage C optimisation.
- **F-5:** a collection lookup is one request per cash-on-delivery shipment (capped at the latest 60, with a visible notice); an aggregate read endpoint is the Stage C remedy.
- Test data note: shipments/orders/fulfilment rows are SQL fixtures (the sales→fulfilment chain that creates them is covered by the regression suite); collections and vehicles were created through the real API.

## 7. Remaining dependencies for Stage C (not started)
Custody record per shipment (number, lifecycle), multi-collection rule (Σ confirmed ≤ expected, D-2) and confirmation step (D-3), per-line delivered/returned events (D-1), expense model with approved category→account mappings, fail-closed (D-4) and separate approver (D-5), driver handover + cashier confirmation, reconciliation endpoint (backend-computed), the server-side guards of F-1/F-2, new permission nodes, then the Stage D test matrix.
