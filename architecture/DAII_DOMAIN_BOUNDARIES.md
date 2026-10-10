# Daii Domain Boundaries

Status: **DRAFT — Stage 1 Planning.**
Defines the 12 Business Domains sitting above the Platform Foundation (`DAII_PLATFORM_FOUNDATION_CONTRACT.md`). Enforces blueprint §41 principle 5: **no domain leakage.**

---

## Cross-Domain Rule

Every domain interacts with every other domain **only** through published commands/queries/events — never by importing another domain's persistence layer or calling its internal functions directly. This mirrors RMS's ADR-006 boundary (Business Modules may not import Kernel internals directly) generalized to domain-to-domain, mechanically enforceable the same way (lint rule / module-boundary check) once the stack is chosen (ADR-002).

Concrete prohibitions called out by the CTO directive, adopted as binding rules:
- **Inventory must not contain Sales UI logic.**
- **Sales must not directly manipulate Warehouse persistence** — it issues a Reservation *command* consumed by Inventory.
- **Shipment must not directly modify Customer records** — it reads Customer via a query contract, never writes.

---

## 1. Commerce

- **Responsibility:** Product/catalog definition — the sellable-item master data, independent of any single sales channel.
- **Owned entities:** `products`, `product_variants`, `price_lists`.
- **Commands:** `CreateProduct`, `UpdateProduct`, `SetPrice`.
- **Queries:** `GetProduct`, `ListCatalog`.
- **State machines:** Product `draft → active → discontinued`.
- **Events:** `commerce.product.created`, `commerce.price.changed`.
- **Dependencies:** Foundation (Configuration, Media).
- **APIs:** `/commerce/products/*`.
- **Security boundary:** Catalog writes admin-gated; reads broadly available (needed by Sales Order creation across all channels).
- **Must NOT know about:** Warehouse stock levels (Inventory owns that), Sales Order state, delivery mechanics.

## 2. CRM / Customer Management

- **Responsibility:** Customer master data — the single source of truth for who the business sells to.
- **Owned entities:** `customers`, `customer_addresses`, `customer_contacts`, `customer_assignments` (history-tracked, not a single `sales_rep_id` field per blueprint §10).
- **Commands:** `CreateCustomer`, `AssignSalesRep`, `UpdateCustomerAddress`.
- **Queries:** `GetCustomer`, `ListCustomersByScope` (delegates filtering to Scope Engine).
- **State machines:** Customer `pending → active → suspended`.
- **Events:** `crm.customer.created`, `crm.customer.assigned`.
- **Dependencies:** Foundation (Scope, Organization).
- **APIs:** `/crm/customers/*`.
- **Security boundary:** Every list/read is Scope-filtered server-side — a Sales Rep must be technically unable to retrieve an unassigned customer.
- **Must NOT know about:** Order history detail (Orders owns that; CRM may hold a denormalized summary via event projection, not a live join), Warehouse/Shipment internals.

## 3. Sales

- **Responsibility:** Sales Representative/Team/Territory structure and hierarchy — the *who sells*, distinct from *what is sold* (Commerce) and *to whom* (CRM).
- **Owned entities:** `sales_reps`, `sales_teams`, `territories`, `sales_hierarchy` (Director→Supervisor→Rep).
- **Commands:** `AssignRepToTeam`, `DefineTerritory`.
- **Queries:** `GetSalesHierarchy`, `GetRepTeam`.
- **State machines:** none significant at this layer (state lives in Orders).
- **Events:** `sales.rep.assigned`, `sales.territory.changed`.
- **Dependencies:** Foundation (Identity, Organization, Scope).
- **APIs:** `/sales/reps/*`, `/sales/teams/*`.
- **Security boundary:** A Supervisor's queries are Scope-bounded to their own team, never the whole org.
- **Must NOT know about:** Order line-item detail, Inventory levels.

## 4. Sales Orders

- **Responsibility:** The central commercial transaction (blueprint §13) — creation, approval workflow, deposit gating, release-for-fulfillment.
- **Owned entities:** `sales_orders`, `sales_order_lines`, `order_status_history`.
- **Commands:** `CreateOrder`, `SubmitOrder`, `ApproveOrder` (via Process Engine), `RejectOrder`, `ReleaseForFulfillment`.
- **Queries:** `GetOrder`, `ListOrdersByScope`.
- **State machines:** Draft→Submitted→Supervisor Review→Manager Approval→Deposit Verification→Released (Process Engine-driven, see `DAII_EVENT_ARCHITECTURE.md` and ADR-008).
- **Events:** `sales.order.created`, `sales.order.approved`, `sales.order.released`.
- **Dependencies:** Commerce (product/price lookup), CRM (customer), Sales (rep/scope), Foundation (Process Engine, Numbering, Notification).
- **APIs:** `/orders/*`.
- **Security boundary:** Every state transition re-checks Permission + Scope server-side at the transition, not just at creation (closes the gap `baseline`'s `computePermissions` pattern demonstrated is needed).
- **Must NOT know about:** How Inventory reserves stock internally, how Shipment assigns a driver — it issues commands/reads projections, never reaches into those domains' tables.

## 5. Deposit Control

- **Responsibility:** Operational deposit tracking gating order release (blueprint §15) — explicitly not full Finance.
- **Owned entities:** `deposits` (amount, method, reference, evidence, status).
- **Commands:** `SubmitDeposit`, `ReviewDeposit`, `ApproveDeposit`.
- **Queries:** `GetDepositStatus`.
- **State machines:** Required→Submitted→Evidence Attached→Review→Approved.
- **Events:** `deposit.submitted`, `deposit.verified` (a blueprint §31 Finance-ready business event).
- **Dependencies:** Sales Orders (the order it gates), Foundation (Media for evidence, Notification).
- **APIs:** `/orders/:id/deposits/*`.
- **Security boundary:** Reviewer role distinct from submitter role, enforced via Permission Engine.
- **Must NOT know about:** Real accounting entries (Phase 2) — emits business events for Finance to consume later, never creates ledger entries itself.

## 6. Inventory & Warehouse

- **Responsibility:** Transaction-based stock ledger (blueprint §17–18), warehouse/location model, reservation.
- **Owned entities:** `warehouses`, `locations`, `stock_movements` (append-only ledger — never a mutable quantity field), `stock_reservations`.
- **Commands:** `RecordMovement`, `ReserveStock`, `ReleaseReservation`, `TransferStock`.
- **Queries:** `GetStockLevel`, `GetStockSummaryByWarehouse`.
- **State machines:** Stock state per blueprint §19 (On Hand→Reserved→Allocated→Picked→Packed→In Transit→Delivered→Returned) — a distinct state model, not collapsed into one quantity field.
- **Events:** `inventory.stock.reserved`, `inventory.movement.recorded`, `inventory.transfer.completed`.
- **Dependencies:** Foundation (Scope — warehouse-worker scoping), Sales Orders (reservation trigger, via event, not direct call).
- **APIs:** `/inventory/*`, `/warehouses/*`.
- **Security boundary:** A warehouse worker's writes are Scope-bounded to their assigned warehouse(s).
- **Must NOT know about:** Sales Order approval state — only consumes `sales.order.released` to know a reservation is now needed to convert into an allocation.

## 7. Fulfillment

- **Responsibility:** Pick/Pack task orchestration, converting a released order + reservation into warehouse-floor work (blueprint §23–24).
- **Owned entities:** `fulfillment_orders`, `pick_tasks`, `pack_tasks`.
- **Commands:** `CreateFulfillmentOrder`, `AssignPickTask`, `CompletePick`, `CompletePack`.
- **Queries:** `GetFulfillmentStatus`.
- **State machines:** Assigned→Accepted→In Progress→Pending Verification→Closed (Work Engine pattern, see extraction matrix).
- **Events:** `fulfillment.pick.completed`, `fulfillment.pack.completed`, `fulfillment.ready-for-dispatch`.
- **Dependencies:** Inventory (allocation), Sales Orders (source order reference, read-only).
- **APIs:** `/fulfillment/*`.
- **Security boundary:** Task assignment Scope-bounded to warehouse.
- **Must NOT know about:** Shipment carrier/driver assignment — hands off via `fulfillment.ready-for-dispatch` event.

## 8. Shipment

- **Responsibility:** Dispatch pipeline — Request→Eligibility→Offer→Assignment→Execution (blueprint §23, §25), the highest-confidence extraction target (QR Platform Delivery Dispatch domain).
- **Owned entities:** `shipments`, `delivery_offers`, `delivery_assignments`.
- **Commands:** `CreateShipmentRequest`, `MakeOffer`, `AcceptOffer` (atomic, idempotent), `AssignDriver`.
- **Queries:** `GetEligibleResources`, `GetShipmentStatus`.
- **State machines:** Offer: Pending→Accepted/Rejected/Expired/Cancelled. Assignment: separate entity, separate lifecycle.
- **Events:** `shipment.offer.created`, `shipment.assignment.accepted`, `shipment.dispatched`.
- **Dependencies:** Fulfillment (trigger), Sales (driver/rep availability), Foundation (Geography for eligibility resolution).
- **APIs:** `/shipments/*`, `/shipments/:id/offers/*`.
- **Security boundary:** Offer accept is a DB-transactional atomic operation (real transaction, replacing the source's synchronous-file-I/O-dependent atomicity — see ADR-009); ownership re-verified server-side on every action, never trusted from a client-supplied ID.
- **Must NOT know about:** Customer's full profile — reads only the delivery-relevant projection (address, contact).

## 9. Waybill / Tracking

- **Responsibility:** The first-class tracking reference and event timeline for a shipment (blueprint §26).
- **Owned entities:** `waybills`, `tracking_events`.
- **Commands:** `RecordTrackingEvent`, `UpdateLiveLocation`.
- **Queries:** `GetWaybillHistory`, `GetLiveLocation`.
- **State machines:** Created→Assigned→Picked Up→In Transit→Out for Delivery→Delivered (mirrors Shipment's execution state, append-only `statusHistory`).
- **Events:** `waybill.status.changed`.
- **Dependencies:** Shipment.
- **APIs:** `/waybills/:id`, `/waybills/:id/tracking`.
- **Security boundary:** Live location writes re-verify assignment ownership server-side on every ping (direct pattern match to QR Platform's `driver-location-engine.js`).
- **Must NOT know about:** Order/Customer commercial detail — pure logistics tracking.

## 10. Delivery

- **Responsibility:** Delivery outcome recording — Delivered/Failed/Refused/Returned (blueprint §28), and Cash Collection as a first-class record.
- **Owned entities:** `delivery_outcomes`, `collections`.
- **Commands:** `RecordDeliveryOutcome`, `RecordCollection`.
- **Queries:** `GetDeliveryOutcome`.
- **State machines:** Outcome is terminal per attempt; a failed attempt may trigger a new Shipment cycle (handled by Shipment domain, not by mutating this record).
- **Events:** `delivery.completed`, `delivery.failed`, `collection.recorded` (blueprint §31 Finance-ready events).
- **Dependencies:** Waybill/Tracking (final event), Shipment.
- **APIs:** `/deliveries/*`.
- **Security boundary:** Collection amount recorded by the authenticated deliverer only, re-verified against their own active Assignment.
- **Must NOT know about:** Real accounting entries — emits events for Finance Phase 2.

## 11. Returns

- **Responsibility:** Return Request→Authorization→Return Shipment→Warehouse Receipt→Inspection→Disposition (blueprint §29). **No analog found in any of the three sources** — build fresh.
- **Owned entities:** `return_requests`, `return_inspections`.
- **Commands:** `RequestReturn`, `AuthorizeReturn`, `RecordInspection`, `Disposition` (Restock/Damaged/Repair/Scrap/Replacement).
- **Queries:** `GetReturnStatus`.
- **State machines:** Requested→Authorized→In Transit→Received→Inspected→Dispositioned.
- **Events:** `return.completed` (blueprint §31 event), `return.disposition.recorded`.
- **Dependencies:** Sales Orders (original order reference), Inventory (restock movement), Shipment (return leg reuses the same dispatch domain).
- **APIs:** `/returns/*`.
- **Security boundary:** Disposition decision Permission-gated to warehouse supervisor level.
- **Must NOT know about:** Original payment/deposit mechanics — emits an event for Finance Phase 2 (Customer Refund/Adjustment per blueprint §31) rather than adjusting anything itself.

## 12. Finance (Deferred — Boundary Defined, Not Implemented)

- **Responsibility (Phase 2):** Consume the business events emitted by every domain above (`deposit.verified`, `stock.delivered`, `collection.recorded`, `return.completed`, etc. per blueprint §31–32) to produce real accounting entries.
- **Owned entities:** None yet — explicitly deferred (blueprint §30).
- **Dependencies:** Event Engine only — Finance is a pure *consumer*, never a dependency of any V1 domain. This is the boundary that must be preserved: **no V1 domain may call into Finance**, only emit events Finance may someday subscribe to.
- **Must NOT know about:** Nothing yet — not built. The constraint that matters now is the reverse: nothing else may assume Finance exists.
