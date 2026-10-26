# Vehicle Operations & Driver Mobile Workspace — Stage A (inspection, mapping, design) — 2026-10-22

Branch `feature/vehicle-driver-workspace` (worktree `.claude/worktrees/vehicle-workspace`), cut from `release/1.1.11` (c85479e). Read-only inspection so far; no code, schema or data changed. Nothing merged, deployed or released.

## 1. What exists today (authoritative entities, reused — not duplicated)
| Concept in the directive | Existing authoritative entity / service | Notes (verified in code) |
|---|---|---|
| Vehicle | `vehicles` (`Vehicle`, shipment domain): `code`, `plateNumber`, **one** `driverUserId`, `shippingCompanyId`, `branch` (**free text**, no Branch entity), `warehouseId` (auto-created custody warehouse), `custodyAccountId` (auto-created **Treasury custody account**), `settlementAccountId`, `status active/retired` | Screen today = `CustodianDetail.tsx` (route `custodian/:type/:id`): stock report, custody balance, active-shipments count, shipment search, vehicle-custody closing (count + transfer back). |
| Driver assignment | `Vehicle.driverUserId` and `Shipment.driverUserId` (assigned via `assign-driver`) | No trip/assignment entity. "Current trip" must be derived (open shipments of the vehicle/driver). |
| Shipment / waybill | `shipments` (`waybillNumber`, `rshNumber`, `salesOrderId/Number`, `vehicleId`, `driverUserId`, `codAmount`, `carrierWaybillNumber`, …); state in the **Process Engine** (`SHIPMENT_PROCESS`), not a column | |
| Shipment items | `shipment_lines` (frozen snapshot: `productId`, `quantity`, `unitPrice`, `lineTotal`) | **Only the shipped quantity exists.** No loaded / delivered / remaining-per-line tracking. |
| Delivery result | `delivery_outcomes` (`delivered | failed | refused | returned`, `failureReason`, actor); `DeliveryService.recordOutcome` drives the shipment transition | |
| Returns | Returns Engine (`shipment_returns`, custody returns, `ShipmentReturnLine` capped at shipped qty) | Partial returns exist as returns, not as a shipment state. |
| Collection | `collections` (`amount`, `method`, `collectorUserId`, `remittanceStatus pending|remitted`, `custodyAccountId`, `custodyTransactionId`, `treasuryTransactionId`) via `DeliveryService.recordCollection` / `remitCollection` | **At most one collection per shipment is enforced** (`recordCollection` refuses a second; `returns.service` and `customer-accounts.service` also read "the" collection of a shipment). Recording posts a Treasury `cash_in` into the vehicle custody account **immediately**; remittance (finance, `logistics.collection.post`) transfers custody → settlement account, credits the Customer Ledger (`cod_collection`) and publishes `collection.remitted` — **the only GL trigger** (ADR-042). |
| Custody (money) | the vehicle's **custody Treasury account** balance (`getCustodianOverview.custodyBalance`) | A *balance of an account*, not a per-shipment record. There is no custody number, no custody lifecycle, no per-shipment custody record. |
| Expenses | — | **Does not exist** (no driver/custody expense entity, category, approval, or posting). |
| Cash handover | `remitCollection` (finance posts it) | There is no driver-initiated handover record and no cashier confirmation step. |
| Approval workflow | FA-01 `ApprovalEngineService` (maker≠checker, live permission check); Treasury Documents (`draft→submitted→approved→executed`, reason→account profiles in Accounting Policy, execution separate) built in this program | Directly reusable for expense approval and posting. |
| Accounting events | `collection.recorded` (operational, never GL), `collection.remitted` (Dr settlement / Cr AR), `treasury.cash.recorded`, `finance.payment.*` | Posting always through the Financial Event engine. |
| Authorization | `logistics.shipment.*`, `logistics.vehicle.*`, `logistics.collection.{view,post}`, `wf.logistics.shipment.{act_any,assign_driver,read_any,…}`; `assertDriverOrAdmin` (assigned driver or `act_any`) guards driver actions; `assertCanReadShipment` (driver or `read_any`); scope derived from the parent sales order | Server-side already; cross-driver access is refused. Branch isolation = Company isolation + scope derivation (no Branch entity). |

## 2. State mapping (labels → canonical states; nothing invented in the UI)
| Requested tab | Canonical shipment state(s) | Remark |
|---|---|---|
| جديدة | `created` (no driver) | |
| جاهزة للاستلام | `assigned` | driver assigned, goods not yet picked up |
| تم الاستلام | `picked_up` | custody stock transferred to the vehicle at pickup |
| في الطريق | `in_transit`, `out_for_delivery` | actions `depart`, `arrive_for_delivery` |
| تم التسليم | `delivered` | |
| تعذر التسليم | `failed` (retry → `assigned`) | needs a reason via the outcome |
| مرتجعات | `returned` + Returns-Engine records | |
| **تم التسليم جزئيًا** | **no canonical state exists** | Shown only if/when a real partial-delivery model exists: today a partial delivery = `delivered` + a Returns-Engine return of the remainder. **Decision D-1 below.** |
Custody statuses (لم تُفتح / نشطة / بها تحصيلات جزئية / مكتملة التحصيل / بها مصروفات / قيد التسوية / تمت التسوية / بها فرق) are **computed by the backend from verified records** of the new custody model (§3); none exists today.

## 3. Capability matrix (directive → exists / missing)
| Function | Status |
|---|---|
| Shipment list by vehicle/driver with status tabs + counts | partial — `GET /shipments` board + `custody-search` exist; per-vehicle/driver tabs with counts, "my shipments", and a mobile card list **missing** |
| Shipment details + status history | exists (`/shipments/:id/detail`, `/:id/tracking`) |
| Item-level view (ordered/loaded/delivered/returned/remaining) | **partial**: only shipped qty (+ returns). Delivered/remaining per line needs new tracking **(D-1)** |
| Status actions with server validation | exists (`/shipments/:id/transition`, DRIVER_ACTIONS, process engine); confirmations/duplicate-submit guards = UI work |
| Delivery proof (receiver, notes, attachment/signature) | partial — outcome has reason only; media assets exist (waybill image) |
| First-class custody record with number, linked to shipment | **missing** |
| Multiple (partial) collections per custody | **missing** (one-per-shipment invariant) **(D-2)** |
| Collection confirmation separate from recording | **missing** (record = custody `cash_in` immediately; "pending verification" state absent) |
| Emergency expense with category/reason/evidence/approval/posting | **missing** |
| Driver cash handover + cashier confirmation | **missing** (finance-side `remit` only) |
| Reconciliation view (collected / approved expenses / handed over / settled / outstanding / difference) | **missing** (only account balance) |
| Trip summary with drill-down | **missing** |
| Mobile-first layout, bottom nav, RTL | **missing** for this area (current screens are desktop tables) |
| Offline mode | out of scope unless requested (directive: define separately) |

## 4. Proposed design (principles: reuse engines, immutable events, fail-closed, no UI arithmetic)
### 4.1 New records (only where no equivalent exists)
1. `shipment_custodies` — **one per shipment that actually involves cash** (`codAmount > 0`; never auto-created for every shipment): `custodyNumber` (numbering engine), `shipmentId` UNIQUE, `vehicleId`, `driverUserId`, `branch` (copied from the vehicle), `expectedAmount` (= shipment `codAmount`), `openedAt/By`, `closedAt/By`. Status is **derived**, never stored as a free field (a stored `closed` marker only for the explicit settlement close).
2. Collection events — **evolve `collections`** instead of a parallel table: allow several rows per shipment, each immutable, each with its own idempotency key, plus a `verificationStatus (recorded | confirmed | rejected)` and `confirmedBy/At`; invariant `Σ(recorded+confirmed) ≤ expectedAmount` unless policy allows over-collection. Remittance/GL path (`remitCollection`, `collection.remitted`, AR ledger) stays **unchanged per collection** (each partial collection posts its own `collection.remitted` event keyed by its id) — this is the key reason not to build a second collection model. Readers that assume one collection per shipment (`returns.service`, `customer-accounts.service`, `getCollectionForShipmentUnscoped`) get an explicit, tested aggregate.
3. `custody_expenses`: `custodyId`, `category` (code from **Accounting-Policy configuration**, same pattern as the Treasury reason→account profiles — never free text, never a hard-coded account), `amount`, `reason` (mandatory), `incurredAt`, `evidenceMediaAssetId?`, `status (recorded → submitted → approved | rejected → posted)`, actor/timestamps, `treasuryDocumentId` once approved. Approval = the existing FA-01 maker≠checker; **posting = a Treasury disbursement document** executed from the vehicle's custody account with the category's configured GL account (fail-closed if the category has no account — the finance owner must map it; nothing guessed). An unapproved expense never reduces the settled balance.
4. `custody_handovers`: driver declares `amount` handed over (immutable event, idempotency key); a cashier/finance user **confirms** (separate permission, maker≠checker) and the confirmation executes the existing `remitCollection` / custody→settlement transfer for the covered collections, so cash handover, confirmation and settlement are three separate recorded events.
All four are append-only/auditable; corrections are reversals (existing reversal patterns), never deletions.

### 4.2 Reconciliation (single source of truth: the backend)
`GET /custody/:id/reconciliation` returns, each from verified rows only: expected, collections recorded, collections confirmed, approved expenses, cash handed over (declared / confirmed), settled (remitted), outstanding, difference. The UI renders these numbers and never recomputes them. Customer balance due, cash held by the driver, handed-over-unconfirmed, confirmed remittance and unresolved difference stay separate lines (a non-cash payment never inflates driver custody).

### 4.3 API (new module `driver-workspace` over the existing services; every route company-scoped + permission node + server-side driver/branch scope)
`GET /driver-workspace/vehicles/:id` (header), `/shipments?status=&…` (cards + counts), `/shipments/:id` (detail incl. lines/history), `/custodies`, `/custodies/:id` (+reconciliation), `POST /custodies/:id/collections`, `/expenses` (+ submit/decide), `/handovers` (+ confirm); shipment status changes keep using the existing `transition`/`outcomes` endpoints. New nodes (inherit from `logistics`): `logistics.custody.view`, `.collect`, `.expense.create`, `.expense.approve`, `.handover.create`, `.handover.confirm`, `.reconcile` — the driver role gets view/collect/expense.create/handover.create only; no node lets a driver approve their own expense or confirm their own handover.

### 4.4 UI (mobile-first, RTL)
One responsive page `VehicleWorkspace` (route `/vehicle-workspace/:vehicleId`, and `/my-vehicle` for the logged-in driver): header (vehicle, plate, driver, branch, status, current trip), four sections with a fixed bottom nav (الشحنات / العهد / المصروفات / ملخص الرحلة), horizontally scrollable status chips with counts, large tappable shipment cards, bottom-sheet details, short numeric-keypad forms with inline validation, confirmation dialogs for consequential actions, double-submit guard, loading/empty/error/retry states, preserved form data. The existing `CustodianDetail` stays untouched (closing-custody workflow) and links to the new workspace.

## 5. Decisions needed from the owner (recommended defaults in brackets; none changes behaviour until agreed)
- **D-1 Partial delivery:** [Do not add a new shipment state. Add per-line `deliveredQuantity` + `returnedQuantity` on a new `shipment_line_deliveries` event table; "partially delivered" = derived (some lines short) while the shipment stays `delivered`/`returned` per the existing machine and the remainder flows through the Returns Engine.] Until decided, the tab is hidden, not faked.
- **D-2 One-collection invariant:** [Replace with Σ confirmed ≤ expected; over-collection refused unless an owner policy allows it.]
- **D-3 Collection confirmation:** [Driver records → `recorded`; cashier confirms → `confirmed`; only confirmed amounts count toward "completed". The custody Treasury `cash_in` keeps posting at record time (physical cash is with the driver) — confirmation is an operational verification, not a second posting.]
- **D-4 Expense categories & accounts:** the finance owner provides category → GL account mappings (and which categories are payable from collected cash); fail-closed until then.
- **D-5 Approval thresholds:** none invented; default = every expense needs a separate approver.
- **D-6 Branch:** keep the free-text vehicle `branch` and Company-level isolation (there is no Branch entity); a real branch scope is a separate item.

## 6. Delivery plan and tests
Stage B (UI shell + read model over existing data: header, status tabs/counts, cards, detail, trip summary of what exists) → Stage C (migrations + services for custody records, partial collections, expenses, handovers, reconciliation; wire to Treasury documents / FA-01 / remittance) → Stage D (real-PG A/B specs: transitions incl. invalid, partial/complete collections, multiple collection events, expense submit/approve/reject/post, handover confirm, reconciliation arithmetic incl. the 10,000 / 4,000 / 2,500 / 500 / 6,000 example, duplicate + concurrent submissions, cross-driver and cross-company access, rollback and reversal, regression of the existing vehicle/shipping/returns suites; mobile/RTL browser checks on an isolated environment). All DB tests on the dedicated cluster 5546 with the sharing protocol; no `daii_dev`, no main, no production.

## 7. Risks
- Relaxing the one-collection invariant touches Returns and customer statements — mitigated by an explicit aggregate API and the existing returns/custody specs in the regression.
- Expense posting needs finance-owner account mappings — the feature ships fail-closed and unusable for expenses until they are set (by design).
- No Branch entity and no trip entity — "current trip" and "branch" are derived/free text until the owner decides otherwise.
