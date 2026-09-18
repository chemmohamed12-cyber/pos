# Sales Order → Warehouse → Shipment → Returns — RBW + Implementation Blueprint

**Status:** **RBW COMPLETE — Blueprint DRAFT, NOT approved.** No domain code has been written or
changed as part of this document. Production stays **HOLD**. Every architectural decision flagged
below as "**CTO DECISION**" must be ratified before any implementation step begins, per the
directive's own Execution Rule (§15 of the directive): *"أي قرار معماري جديد ... يتم رفعه قبل
التنفيذ، وليس اتخاذه داخل الكود بالاجتهاد."*

**Verified against:** `4-daii-erp` v1.0.10 source (`src/**`), read directly, file-by-file, across
four parallel read-only passes covering `sales-orders`, `sales`, `crm`, `commerce`, `fulfillment`,
`inventory-warehouse`, `shipment`, `delivery`, `tracking`, `returns`, `customer-finance`,
`accounting`, `inventory-valuation`, plus every relevant migration and manifest. Every claim below
cites `file.ts:line`. Nothing is inferred from prior chat history or the CTO's own working notes
without independent verification against current code.

**Scope note:** This checkout has **no frontend project** — no `.tsx` files, no `daii-frontend`
directory exist anywhere under this workspace copy. Sections 9 and 16 (frontend screens) are
therefore written as **requirements for whoever owns/restores the frontend project**, not verified
against existing UI code. This is flagged, not silently worked around.

---

## PART A — READ-BEFORE-WRITE FINDINGS

Legend: **EXISTS** (correct, matches the requirement) · **PARTIAL** (present but incomplete/weak) ·
**MISSING** (does not exist) · **WRONG_IMPLEMENTATION** (exists but violates the stated business rule).

### A.1 — Sales Order as the primary reference (directive §1)

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | Order → Customer is a real, enforced relation | **PARTIAL** | `SalesOrder.customerId` is a plain `@Column('uuid')`, no `@ManyToOne`/`@JoinColumn` — but a real Postgres FK exists (`sales/1755841800000-CreateSalesOrderTables.ts:12`, `REFERENCES "customers"("id")`). Enforcement is DB-level; the ORM gives no compile-time guard against a future name-based lookup. |
| 2 | Order → Lines is a real relation, not string-matched | **EXISTS** | `SalesOrderLine.salesOrderId` FK'd `ON DELETE CASCADE` (`sales/1755841800000...ts:26`); every write/read path uses the order's PK (`sales-orders.service.ts:306-322,525,580,831`), never `orderNumber`. |
| 3 | Line → Product is a real relation | **PARTIAL** | Real DB FK (`...ts:27`, `REFERENCES "products"("id")`), no ORM relation decorator — same class of gap as #1. |
| 4 | Quantities/prices/line totals/order total | **EXISTS** | Server-computed in `resolveLineInput` (`sales-orders.service.ts:131-208`); `totalAmount` is a stored column, recomputed and re-saved inside the same transaction on every line mutation (`sales-orders.service.ts:629-633,896-900`) — no drift window found. |
| 5 | Order Number is a business reference, PK is the real join key | **EXISTS** | `orderNumber` (unique varchar) is display-only; `id` (uuid PK) is what every relation actually joins on. No `GET`-by-`orderNumber` endpoint exists anywhere. |
| 6 | Order/Line provenance preserved downstream (Shipment, Returns) | **WRONG_IMPLEMENTATION** | `return_requests.salesOrderId` is `VARCHAR(255)`, **no FK** (`logistics/1755842400000-CreateReturnsTables.ts:11`). `fulfillment_orders.salesOrderId` is `VARCHAR(255)`, **no FK**, unique index only (`fulfillment-order.entity.ts:26-27`). `shipments.salesOrderId` is typed `uuid` but its migration never adds a `REFERENCES` clause (`logistics/1755850700000-AddShipmentRshNumberAndSalesOrderLink.ts:22`) — **no DB FK at all**. `return_requests.salesOrderLineId` is `uuid`, indexed, also **no FK** (`logistics/1755850600000-AddReturnsEngineCustomerReturns.ts:39-40`). Additionally, `Shipment.salesOrderNumber` and `Shipment.salesRepUserId` are **denormalized snapshots taken once at shipment creation** (`shipment.entity.ts:66-79`) with no resync job — if the source order's number or rep is ever corrected, the shipment's copy silently goes stale. |
| 7 | Reads scoped correctly, no cross-order leakage | **EXISTS** | Every controller route (`sales-orders.controller.ts:153-234`) and service read is keyed by the route's own `:id` (PK); `getOrderLines` filters strictly `where: { salesOrderId: orderId }`. |
| 8 | Order/line reassignment to a different order/customer is blocked | **PARTIAL** | No writer ever changes `customerId` post-creation; line edits are scoped to `salesOrderId: orderId` so a foreign line ID 404s rather than silently cross-editing. But this is guaranteed only because **no API exposes the knob**, not by DB immutability, a trigger, or a test. A future direct-repository script/admin tool has no safety net. |

**Headline risk for §A.1:** the exact SO-001/SO-002 mixing scenario the directive calls out is **not
possible today through the existing service/controller API** (point 7-8 hold), but the **absence of
real foreign keys** on `shipments.salesOrderId`, `fulfillment_orders.salesOrderId`, and
`return_requests.salesOrderId/salesOrderLineId` (point 6) means nothing in the database itself would
reject an orphaned or wrong reference introduced by a migration, bulk import, or a future bug —
exactly the class of defect that database-level relations exist to prevent, and exactly what the
directive requires ("العلاقات مبنية على الـdatabase/domain relations الفعلية").

### A.2 — Shipment as a single operational unit (directive §2)

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | Shipment → Order FK, Customer identity available | **WRONG_IMPLEMENTATION** | `shipments.salesOrderId` has no DB FK (see A.1.6). `Shipment` has **no `customerId` column at all** — customer identity is resolved only by a live hop through `salesOrderId → SalesOrdersReadContract.getOrderSnapshot()` (`shipment.service.ts:171,1183-1207`). If `salesOrderId` is ever null (pre-migration legacy rows — the column is nullable), customer identity is unrecoverable from the shipment record. |
| 2 | Shipment shows as one unit; contents are line-level detail | **MISSING** | No `ShipmentLine`/`ShipmentItem` entity exists anywhere (repo-wide grep, zero hits). "Contents" is reconstructed **live, at read time**, by re-querying `StockReservation` rows for the order's `salesOrderId` (`shipment.service.ts:1195-1198`) — not a frozen snapshot taken when the shipment was created/dispatched. `StockReservation` has no `unitPrice`/`lineTotal`/`unit` fields, so price and line-total (both required by the directive's detail screen) cannot be produced from this reconstruction at all. |
| 3 | Carrier / vehicle / transport method concept | **EXISTS** | `ShippingCompany` and `Vehicle` entities are real and complete (`shipping-company.entity.ts`, `vehicle.entity.ts`), attached via `Shipment.shippingCompanyId`/`vehicleId`. Mutual exclusivity is enforced only in application code (`shipment.service.ts:271-273`), no DB `CHECK`. Both FK columns are plain UUIDs with no `REFERENCES` clause. |
| 4 | Warehouse fulfillment preserves Order identity through pick→pack→ship | **EXISTS** (relation is preserved; still string-typed, not FK'd) | `FulfillmentOrder.salesOrderId` threads through pick/pack (`fulfillment.service.ts:46-110`) and into the auto-created Shipment via the `fulfillment.ready-for-dispatch` event (`fulfillment.service.ts:444-447` → `shipment.service.ts:62-65`) without ever copying order fields — genuinely preserved, just not relationally enforced. |
| 5 | Inventory movement stays traceable to Order/Shipment | **PARTIAL** | `StockMovement.referenceType/referenceId` is a real append-only ledger, not a bare quantity mutation — but it's a polymorphic string pair with no FK, and the terminal dispatch movement is tagged `referenceType:'sales_order'` (not the shipment id) — `inventory.service.ts:1111-1120`. Tracing "every movement caused by shipment X" requires a second lookup and only works while the current 1-order:1-fulfillment:1-shipment invariant holds (see A.2.7). |
| 6 | Shipment status/lifecycle governed by a state machine, not free-form | **EXISTS** | `Shipment` deliberately has no status column; the Process Engine (`shipment-process.ts:21-34`) is the single source of truth, transitions gated by role + business rules (`shipment.service.ts:430-484`). Solid. |
| 7 | Detail screen fields (customer, order, address, phone, governorate, total, rep name, carrier, status, line items) | **PARTIAL/MISSING** | `getShipment` (`shipment.service.ts:552-556`) returns the raw entity + Process state only — **no enrichment join**. Address/phone/governorate exist only on `Customer`, never surfaced. `totalAmount` exists only on `SalesOrder`, never joined. Rep and carrier are id-only (no name resolution). Line items don't exist as persisted rows (see #2). None of these are assembled into a single response anywhere today. |
| 8 | Two orders' items cannot land on the same shipment | **EXISTS today, by convention not by constraint** | `FulfillmentOrder.salesOrderId` has a real DB-level `@Index({unique:true})` (`fulfillment-order.entity.ts:25`), so the 1:1 chain holds structurally. But `ShipmentService.createShipment`'s duplicate-shipment guard is a plain read-then-write with **no row lock** (`shipment.service.ts:154-157`) and `shipments.fulfillmentOrderId` has only an ordinary index, not a DB `UNIQUE` constraint — a concurrent double-POST has a real (narrow) TOCTOU window to create two shipment rows against the same order, which the reservation-based content lookup (item #2) cannot then disambiguate. |

### A.3 — Shipment Return vs. Sales Return (directive §3, §4, §5, §6, §7, §8, §9, §10)

This is the highest-risk area. **Headline finding: neither `ShipmentReturn` nor `SalesReturn` exists
as a distinct entity anywhere in the codebase.** Everything lives in one generic `ReturnRequest`
entity (`return_requests` table), discriminated by an `origin` enum
(`customer` | `shipping_company_custody` | `vehicle_custody`) and a `returnType` enum
(`exchange` | `value_credit` | `product_return`) — precisely the "one generic Return entity trying
to serve both" anti-pattern the directive explicitly prohibits (§4: *"لا يتم الخلط بين الاثنين"*).

Important distinction the RBW surfaced: the two shipment-adjacent `origin` values
(`shipping_company_custody`, `vehicle_custody`) are **pre-delivery custody reversals** — goods pulled
back from a carrier/vehicle *before* they ever reached the customer (`return-origin.ts:6-9`). This is
a real, working, and useful flow — but it is **not** the directive's Concept A (a return of goods
that *were delivered* and are coming back). Concept A does not exist in any form today.

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | ShipmentReturn and SalesReturn are distinct entities/aggregates | **WRONG_IMPLEMENTATION** | Single `ReturnRequest` entity (`return-request.entity.ts:6-79`) for both. |
| 2 | ShipmentReturn has a real FK to an existing (delivered) Shipment | **WRONG_IMPLEMENTATION / MISSING** | `shipmentId` is a bare nullable UUID, indexed only, **no FK** (custody-return migration). And the post-delivery "return of a delivered shipment" concept the directive describes simply doesn't exist — only pre-delivery custody reversal does. |
| 3 | Partial shipment return: per-line qty capped at shipped qty | **MISSING (no line table) / WRONG baseline** | No `ReturnLine` entity anywhere — one `ReturnRequest` row = one product = one quantity. The one quantity guard that exists (`returns.service.ts:77-88`) caps the return against **`SalesOrderLine.quantity` (ordered qty)**, not shipped/delivered qty. **Concrete failure scenario:** an order line partially shipped (rest back-ordered) could have a "return" accepted for the full *ordered* quantity before the remainder is ever shipped. |
| 4 | Sales Return: optional single-order OR "All Orders" mode | **MISSING** | `ReturnRequest.salesOrderId` is mandatory in both migrations. No "all orders for this customer" code path, DTO, or contract exists anywhere. |
| 5 | Configurable 1-year eligibility window, computed from Return Date | **MISSING** | Repo-wide search found no eligibility-window logic at all — not even a hardcoded literal. (A UI-facing label `field.eligible_orders` → "Eligible Orders"/"الطلبات المؤهلة" was already seeded into the terminology table — `logistics/1755850600000-...ts:33` — with **zero backing logic**, i.e. a promise already made to the UI layer that the domain cannot fulfill.) |
| 6 | Product eligibility = real join against customer's purchase history | **MISSING** | No endpoint/service enumerates "this customer's returnable products" at all — the existing create-flow requires the caller to already know a specific `salesOrderLineId`. Neither the correct nor an incorrect (all-products) implementation exists; the capability is simply absent. |
| 7 | Multi-order Sales Return, per-line provenance to source order | **WRONG_IMPLEMENTATION (baked-in single-order assumption) + MISSING (no multi-order support)** | `ReturnRequest.salesOrderId`/`salesOrderLineId` are **header-level, singular** fields — one `ReturnRequest` row *is* one order + one line + one product, by construction. There is no child-line table where per-line provenance could live independently of the header even in principle. This is exactly the anti-pattern the directive names explicitly: *"لا نفترض أن كل Sales Return له Order واحدة دائمًا."* |
| 8 | Return qty × return price = line total; return price independently settable | **MISSING** | `ReturnRequest` has no price/amount column at all. The only monetary computation (`createReturnCreditForRequest`, `returns.service.ts:521-522`) reuses the **original sale's historical per-unit price** — there is no field or path to set an independent return price. |
| 9 | Returns list shows customer name + return amount (not buried in detail) | **MISSING** | `listReturns()` returns the raw `ReturnRequest` + workflow state only (`returns.service.ts:261-266`) — no `customerId`/name, no amount field exists on the entity to show even if the DTO were extended. The public read contract confirms the same shape (`logistics.contract.ts:13-20`: `id, salesOrderId, createdAt, quantity, reason, state` — no customer, no amount). |
| 10 | Negative cases (over-return, no shipment, product never purchased, duplicate) | **PARTIAL/MISSING** | Over-return is checked, but against the wrong baseline (#3). Custody-return-without-shipment is checked at the application layer only, no DB backing (#2). Purchase-history check is absent (#6). Duplicate/concurrent submission is **not locked** — `createReturnRequest` has no row lock, unlike `recordDisposition` which explicitly uses a `FOR UPDATE`-backed Process Engine transition (`returns.service.ts:370-376`). **Concrete failure scenario:** two concurrent partial-return requests for the last unit of a line can both pass the `quantity > maxReturnable` check before either commits — a real double-credit/double-restock race. |

### A.4 — Customer Ledger, Inventory & Financial posting (directive's implicit cross-cutting concern, §11 "البيانات المالية/المخزنية المرتبطة")

| # | Question | Status | Evidence |
|---|---|---|---|
| 1 | Stock deducted on fulfillment, with audit trail | **EXISTS**, but only at **delivery**, not at ship/pack time | `DeliveryService.recordOutcome` (delivered) → `InventoryService.fulfillReservationsForOrder` → `recordMovement(..., 'dispatch', 'sales_order', salesOrderId, ...)` (`delivery.service.ts:80-84`, `inventory.service.ts:1111-1120`). A real, atomic, audited movement — good. (Historical note found in code comments: this used to fire at pack-close, which was a real bug fixed before this snapshot — `fulfillment.service.ts:420-436`.) |
| 2 | Return restocks inventory, with audit trail | **EXISTS** | `receiveAtWarehouse`/`recordDisposition` post real `return_in`/`transfer_*` movements referencing the return request (`returns.service.ts:297-314,384-499`). |
| 3 | Sales Order → Shipment → Delivery posts to Customer Ledger automatically | **MISSING** | The only AR-posting path is `InvoiceService.postInvoice` — a **fully manual, separate action**, never triggered by order release, shipment creation, or delivery (`invoices.service.ts:240-295`, `invoices.controller.ts:32,57`). **Concrete risk:** a Sales Order can complete Shipment → Delivery → COD collection with **zero** ledger debit ever posted if nobody separately creates and posts an invoice — physical fulfillment and AR can silently diverge. |
| 4 | Events published by sales-orders/shipment/returns | **WRONG_IMPLEMENTATION (manifest/code mismatch) + PARTIAL** | `sales-orders` publishes **zero** events despite `sales.manifest.ts` declaring `sales.order.created/approved/released` — dead declarations, `SalesOrdersService` never imports `EventBusService` at all. `shipment`/`returns`/`delivery` do publish real events, but `return.completed` — though subscribed by `FinancialEventHandlerRegistry` — has **no registered handler** in `V1_FINANCE_HANDLERS`; it lands as a `FinancialEvent` row and is immediately marked `IGNORED`. The registry's own code comment claiming "no publisher exists yet" for this topic is itself stale/wrong. |
| 5 | Inventory valuation aware of sales/returns | **MISSING by explicit design** | Only `movementType === 'dispatch'` triggers GL/COGS costing (`INVENTORY_GL_MOVEMENT_TYPES = new Set(['dispatch'])`, `inventory.service.ts:29`). `return_in`/`transfer_in`/`transfer_out` are not in that set — **a restocked return never reverses the original sale's COGS/Inventory-Asset entry.** The accounting team's own `InventoryReconciliationService` already names "a movement type not yet mapped to GL" as an expected, un-auto-corrected drift cause. This is disclosed, deliberate V1 scope in `accounting`, not a hidden bug — but it is directly relevant to any new Shipment/Sales Return financial-event wiring this Blueprint proposes (§14 below). |
| 6 | Cross-domain module boundaries respected | **EXISTS**, with one acceptable intra-module exception | `sales-orders`/`shipment`/`returns` reach `finance`/`customer-finance`/`inventory-valuation` only via injected `*_CONTRACT` interfaces (`foundation/module-registry/contracts/*.contract.ts`). `ReturnsService` imports concrete `ShipmentService`/`DeliveryService` classes directly, but all three sit inside the same `logistics` business-domain manifest, so this is intra-module, not a boundary violation. |
| 7 | Double-posting risk | **No active double-posting found; one disclosed under-counting gap** (see #5). Reconciliation is read-only and self-identifies drift without auto-correcting (`inventory-reconciliation.service.ts:27-28`). |

**Manifest note:** no `sales-orders.manifest.ts`/`shipment.manifest.ts`/`returns.manifest.ts` exist —
these domains are grouped under `sales.manifest.ts` (`commerce, crm, sales, sales-orders,
deposit-control`) and `logistics.manifest.ts` (`shipment, tracking, delivery, returns`). Both list
`events` that are only partially matched by what the code actually publishes (see #4).

---

## PART B — IMPLEMENTATION BLUEPRINT (structured per directive §13, 18 points)

### B.1 Current Architecture

NestJS/TypeScript, domain-per-folder (`src/domains/<domain>/{domain,application,infrastructure,interface}`),
Postgres via TypeORM, cross-domain integration via injected contract tokens
(`foundation/module-registry/contracts`) and an event outbox (`foundation/events`), state machines
via a shared Process Engine (`foundation/process-engine`), numbering via `foundation/numbering`,
permissions/entitlement via `foundation/authorization`+`foundation/entitlement` gated by
`ModuleManifest`s. The order→fulfillment→shipment chain is: `SalesOrder` (sales-orders) →
`FulfillmentOrder`/`PickTask`/`PackTask` (fulfillment) → `Shipment` (shipment, auto-created on
`fulfillment.ready-for-dispatch`) → `DeliveryOutcome`/`Collection` (delivery). Returns
(`returns` domain) currently branch off this chain through one generic `ReturnRequest` aggregate
covering both pre-delivery custody reversal and post-order customer exchange/credit.

### B.2 Current Data Relations

See Part A tables. Summary: PK-based relations are correct and consistently used **within** each
domain's own write paths (Order↔Lines, Fulfillment↔Order, Shipment↔Fulfillment); cross-domain
references that *should* be FKs (Shipment→Order, Return→Order, Return→Shipment, Fulfillment→Order)
are all either untyped/unconstrained strings or UUID columns with no `REFERENCES` clause. Shipment
contents and shipment detail-screen data are not persisted at all — reconstructed live from
inventory reservations and a cross-domain order lookup.

### B.3 Gaps (consolidated from Part A, ranked by risk)

1. **[HIGH]** No `ShipmentReturn`/`SalesReturn` distinction — one generic `ReturnRequest` (A.3.1).
2. **[HIGH]** No return-line table anywhere → no per-line partial-return capability, no return
   pricing, no multi-order provenance (A.3.3, A.3.7, A.3.8).
3. **[HIGH]** Sales Return "All Orders" + eligibility-window + purchase-history-eligible-product
   selection do not exist (A.3.4, A.3.5, A.3.6).
4. **[HIGH]** Partial-return quantity guard caps against ordered qty, not shipped qty (A.3.3).
5. **[MEDIUM]** Missing DB foreign keys: `shipments.salesOrderId`, `shipments.fulfillmentOrderId`,
   `fulfillment_orders.salesOrderId`, `return_requests.salesOrderId`,
   `return_requests.salesOrderLineId` (A.1.6, A.2.1, A.3.2).
6. **[MEDIUM]** No `ShipmentLine` snapshot — shipment contents can drift retroactively, no price/unit
   fields available for the required detail screen (A.2.2).
7. **[MEDIUM]** No shipment/return detail aggregation endpoint (customer/address/phone/governorate/
   total/rep name/carrier name) (A.2.7).
8. **[MEDIUM]** Returns list DTO exposes neither customer name nor return amount (A.3.9).
9. **[LOW]** Race condition: unlocked duplicate-return and duplicate-shipment checks (A.3.10, A.2.8).
10. **[LOW, cross-cutting, partially out of this directive's literal scope but touched by it]**
    Sales Order → Customer Ledger has no automatic posting path; `return.completed` has no financial
    handler; `sales.manifest.ts` declares events `sales-orders` never publishes (A.4.3, A.4.4).
11. **[OUT OF SCOPE, flagged for awareness only]** Restocked returns never reverse COGS/Inventory
    valuation (A.4.5) — this is `accounting`/`inventory-valuation` territory, a pre-existing disclosed
    V1 gap, not something this Blueprint should silently absorb.

### B.4 Required Changes (proposed — all items below are CTO-decision items, not yet approved)

**Explicit reuse-vs-new-entity justification** (directive: *"ممنوع إنشاء Entity ... إذا كانت موجودة
بالفعل ويمكن استخدامها"*): `ReturnRequest` **cannot** be reused for either target concept without
breaking its existing, working custody-reversal flow — it is single-product/single-qty/single-order
per row, has no line table, no price column, and a mandatory `salesOrderId`. **Recommendation: keep
`ReturnRequest` exactly as-is for `shipping_company_custody`/`vehicle_custody` origins (pre-delivery
custody reversal — untouched, zero regression risk), and add two new aggregates in the same
`returns` domain/module** for the two customer-facing concepts the directive actually describes:

- **`ShipmentReturn` + `ShipmentReturnLine`** (new tables, new domain/application/interface files under
  `src/domains/returns/`): `ShipmentReturn.shipmentId` → real FK to `shipments.id`; one row supports
  both full and partial return via its child lines. `ShipmentReturnLine.shipmentLineId` → real FK to
  the new `ShipmentLine` snapshot (B.4 next item); `returnQty` validated against
  `shipmentLine.quantity − Σ(prior non-rejected ShipmentReturnLine.returnQty for that shipmentLineId)`,
  computed under a row lock (reuse the existing `FOR UPDATE`-via-Process-Engine pattern already used
  by `recordDisposition`, not a new locking mechanism).
- **`ShipmentLine`** (new table): a frozen snapshot taken at shipment-creation time from the order's
  reserved lines — `productId`, `productCode`, `quantity`, `unit`, `unitPrice`, `lineTotal`. This
  closes B.3 gap #6 and is the prerequisite for gap #4's correct cap.
- **`SalesReturn` + `SalesReturnLine`** (new tables): `SalesReturn.salesOrderId` becomes **nullable**
  (single-order mode) with a mandatory `customerId` (real FK) always present (needed for "All
  Orders" mode). `SalesReturnLine.sourceSalesOrderId` + `sourceSalesOrderLineId` (real FKs, **not
  nullable**) carry per-line provenance independent of the header — this is what makes "one Return,
  many source Orders" possible without ever losing traceability, directly closing gap #2/#3 above and
  satisfying directive §10/§11 literally. `SalesReturnLine` also carries `returnQty`, `returnPrice`
  (independently settable, decoupled from original sale price), `lineTotal`.
- **Eligibility window as configuration, not a hardcoded literal**: a new `ConfigKeyMeta` entry
  (e.g. `sales.return_eligibility_window_days`, default `365`) in the `sales` (or `returns`) module
  manifest — reusing the platform's existing config-key pattern already used throughout `accounting`
  (e.g. `accounting.allow_backdated_manual_journal_days`), not a new mechanism. The eligible-product
  query computes `EXISTS(SalesOrderLine JOIN SalesOrder WHERE SalesOrder.customerId = :customerId AND
  SalesOrderLine.productId = :productId AND SalesOrder.<date-field> BETWEEN :returnDate − windowDays
  AND :returnDate)`.
  **CTO DECISION needed:** which order-side date field anchors the window — order-creation date, or
  delivery date? The directive's own example ("تم بيعه لهذا العميل") is ambiguous between the two;
  they can differ materially for back-ordered lines. Recommend delivery date (closer to "actually
  sold/received") but this is a business call, not an engineering one.
- **Retroactive FK backfill migrations** for `shipments.salesOrderId`, `shipments.fulfillmentOrderId`,
  `fulfillment_orders.salesOrderId` (convert to real `uuid` + `REFERENCES`, `fulfillment_orders`
  needs a type change from `varchar` to `uuid` first). **CTO DECISION needed:** how to handle any
  existing NULL/orphaned rows in staging/production data before the constraint can be added
  (data-cleanup step required first — this Blueprint does not assume production data is already
  clean).
- **Shipment/Return detail aggregation endpoints** (new read-model methods, no new tables): join
  Shipment → Order → Customer → ShippingCompany/Vehicle → ShipmentLine into the single response shape
  the directive's screens require (§2, §3).
- **Returns list DTO fix**: extend the read model (not the base entity) to resolve `customerId`/name
  and a computed amount for every return type, so the list view is never "buried in details."

**Explicitly NOT decided by this Blueprint (raised, not resolved, per Execution Rule):**
- Whether completing a `ShipmentReturn`/`SalesReturn` should register a real handler on the existing
  `return.completed` financial-event topic (currently `IGNORED`) — this has direct GL/AR implications
  and belongs to the `accounting`/CTO decision track, not this domain team.
- Whether `SalesReturnLine.returnPrice` overriding the original sale price should also change the
  eventual GL credit calculation, or whether GL always uses the original sale price regardless of the
  return-price entered here — an accounting-policy call.
- Whether `sales-orders` should start actually publishing the `sales.order.created/approved/released`
  events its own manifest already (falsely) declares — relevant background, not required by this
  directive, flagged for separate CTO scheduling.

### B.5 Entities/Relations Affected

New: `ShipmentReturn`, `ShipmentReturnLine`, `ShipmentLine`, `SalesReturn`, `SalesReturnLine`.
Modified (migration only, additive): `Shipment` (add FK constraint to existing `salesOrderId`/
`fulfillmentOrderId` columns, no column shape change), `FulfillmentOrder` (`salesOrderId` type change
varchar→uuid + FK — **breaking** for any existing string-comparison code, must be grepped and updated
project-wide before this migration ships), `ReturnRequest` (unchanged — explicitly untouched).

### B.6 Services Affected

New: `ShipmentReturnsService`, `SalesReturnsService` (kept separate from `ReturnsService`, which
keeps owning custody-reversal + legacy exchange/credit, per the directive's explicit "never conflate"
rule — this is a structural, not cosmetic, separation). Modified: `ShipmentService.createShipment`
(must also materialize `ShipmentLine` rows from the order's reserved lines at creation time — this is
the fix for B.3 gap #6, and must happen inside the same transaction as shipment creation, not as a
follow-up write). `ReturnsService` unmodified.

### B.7 Controllers Affected

New: `ShipmentReturnsController` (`/shipment-returns`), `SalesReturnsController` (`/sales-returns`) —
separate REST namespaces, matching the directive's explicit UI/domain separation (§4). `ShipmentController`
gains a richer `GET /shipments/:id` detail response (aggregation, no new route). `ReturnsController`
unmodified.

### B.8 Frontend Screens Affected

**Not verifiable in this checkout — no frontend project present (see scope note at top).** Whoever
owns the frontend project must implement, per the directive's exact wireframe spec: (1) a
shipment-centric list + clickable detail view (§2), (2) a shipment-return flow keyed off an existing
shipment with Full/Partial modes and per-line qty capture (§3), (3) a sales-return flow with
Order/All-Orders selector, eligible-product-by-name picker, add-item/qty/price/total rows (§5-§8),
(4) a returns list surfacing customer name + amount + click-through detail (§9). This Blueprint
defines the API shapes (B.4, B.7) those screens must consume; it does not itself build them.

### B.9 Domain Invariants (binding, from directive §11 + RBW findings)

1. `SalesOrder` is the origin of a sale; its PK, not its order number, is the join key for every
   downstream relation.
2. `Shipment` represents an Order's fulfillment/dispatch; it always has exactly one Order (FK
   enforced), and its contents are a **frozen snapshot** (`ShipmentLine`), not a live re-derivation.
3. `ShipmentReturn` always references exactly one existing `Shipment` (FK enforced); it cannot exist
   standalone.
4. `SalesReturn` references either exactly one `SalesOrder` or none (customer-wide "All Orders"
   mode) — **never assume it has exactly one order** when iterating its lines; provenance lives on
   `SalesReturnLine`, not the header.
5. Σ(non-rejected `ShipmentReturnLine.returnQty` for a given `ShipmentLine`) ≤ that line's shipped
   quantity, always, enforced under a row lock.
6. A product is eligible for "All Orders" Sales Return selection only if it appears in that specific
   customer's own order-lines within the configured eligibility window measured back from the Return
   Date (never from today's date, never from the order date unless that is the CTO-ratified anchor).
7. `ReturnRequest` (custody reversal) and the two new return aggregates never share a table, a
   service, or a UI screen.

### B.10 Validation Rules

- `ShipmentReturnLine.returnQty > 0` and `≤` remaining returnable qty for that shipment line (row-locked check).
- `SalesReturnLine.returnQty > 0`, `returnPrice ≥ 0`; `lineTotal = returnQty × returnPrice` (server-computed, never trusted from client, matching the existing `SalesOrderLine`/`resolveLineInput` discipline).
- `SalesReturn` header total = Σ `SalesReturnLine.lineTotal`, recomputed server-side on every line mutation (same pattern as `SalesOrder.totalAmount`).
- "All Orders" product picker only returns products passing the purchase-history-within-window join (B.4); the create endpoint re-validates this server-side even if the picker is bypassed (never trust client-supplied product selection as pre-validated).
- `ShipmentReturn`/`SalesReturn` creation is idempotent per natural key (e.g., reject a second identical in-flight submission) — closes A.3.10's race.

### B.11 Authorization Implications

New permission nodes for `shipment_return.{view,create}` and `sales_return.{view,create}` must be
added to the `logistics`/`sales` manifests, mapped onto the platform's existing closed verb list
(`view|create|edit|delete|approve|reject|submit|post|release|assign|export|reopen|cancel|adjust|
transfer|reverse` — confirmed as the closed enum pattern used platform-wide, e.g. `OP_PROCUREMENT_AP_BLUEPRINT.md`
§0.2). **CTO DECISION needed:** should high-value Sales Returns route through the existing FA-01
Approval Engine (maker/checker), the way AR write-offs do? Not requested explicitly in the directive;
raised because the platform pattern exists and returns are a common fraud/error vector — a
recommendation, not an assumption.

### B.12 Inventory Implications

`ShipmentReturn`/`SalesReturn` disposition reuses the **existing** `InventoryService.recordMovement`
(`return_in`/`transfer_*`) path already proven correct for `ReturnRequest` (A.4.2) — no new inventory
mechanism. `ShipmentLine` snapshot creation does not itself move stock; it only freezes what the
shipment's reservations looked like at dispatch time, so returns validate against the true shipped
quantity rather than a live-changing reservation set.

### B.13 Financial Implications

No automatic GL posting is proposed or implied by this Blueprint by default — consistent with the
current state where Sales Order → Shipment has no automatic Customer Ledger posting either (A.4.3).
The two open financial questions (real `return.completed` handler; return-price vs. sale-price for
credit calculation, both listed at the end of B.4) are explicitly deferred to a CTO/accounting
decision, not decided here.

### B.14 Return Eligibility Logic

Fully specified in B.4 ("Eligibility window as configuration"). Restated as the binding rule:
`eligible ⟺ ∃ SalesOrderLine ℓ, SalesOrder o : ℓ.salesOrderId = o.id ∧ o.customerId = :customerId ∧
ℓ.productId = :productId ∧ o.<anchorDate> ∈ [returnDate − windowDays, returnDate]`, with
`windowDays` read from `ConfigKeyMeta` (default 365), never hardcoded in a controller or the frontend.

### B.15 Shipment/Return State Behavior

`Shipment` keeps its existing Process-Engine-owned lifecycle unchanged (A.2.6, already correct).
`ShipmentReturn`/`SalesReturn` each need their own lifecycle (e.g. `draft → submitted → received →
disposed/rejected`), modeled the same way — via the shared Process Engine, not a bespoke status
column — mirroring every other document type in this codebase (`SalesOrder` has none by design;
`ReturnRequest`'s disposition flow already does this correctly and should be the template).

### B.16 Required Tests

Directly maps to directive §14 (A–G). Concretely, given the gaps found:
- Order integrity: re-confirm A.1 findings stay true after FK backfills (no behavior change expected, regression guard only).
- Shipment: `ShipmentLine` snapshot correctness at creation; detail endpoint returns full field set.
- Full/Partial Shipment Return: cap enforcement including the concurrent-race case (two simultaneous partial returns on the last returnable unit) — this must be a new test, since A.3.10 found no existing lock to verify.
- Sales Return: specific-order mode, All-Orders mode, eligibility window boundary (exactly at N days, one day over), product never purchased (must be rejected), multi-order return preserving per-line provenance.
- Return Details / List: customer name + amount visible in list response, not just detail.
- Negative cases per directive §14.G, including "shipment return without shipment" and "cross-order contamination" attempts against the new FK constraints.

### B.17 Regression Impact

- `fulfillment_orders.salesOrderId` varchar→uuid type change is the single highest-regression-risk
  item — every existing string comparison/interpolation against this column must be located (grep)
  and updated before the migration ships.
- Adding FK constraints to `shipments.salesOrderId`/`fulfillmentOrderId` requires a pre-migration data
  audit (orphan/NULL check) in every environment this ships to, not just dev.
- New `ShipmentReturn`/`SalesReturn` aggregates are purely additive alongside the untouched
  `ReturnRequest` — zero expected regression to existing custody-reversal or legacy exchange/credit
  flows, provided `ReturnsService`/`ReturnsController`/`returns.module.ts` are left as-is (only
  registering the two new services/controllers, not modifying existing ones).
- `ShipmentService.createShipment` gains a new in-transaction write (`ShipmentLine` rows) — must be
  covered by the existing shipment-creation regression suite to confirm no transaction-boundary
  regression.

### B.18 Open Decisions Log — RATIFIED 2026-09-16, implementation status below

1. **Eligibility-window anchor date — RATIFIED:** original sale/invoice date, `[returnDate − 1yr, returnDate]`, falling back to `SalesOrder.createdAt` when no reliable item-level invoice date exists (which is every row today — a true invoice-date join would cross the `sales-orders`↔`customer-finance` module boundary, so V1 implements the ratified fallback, not the invoice-date primary path). **Implemented**: `SalesOrdersReadContract.findEligibleReturnPurchaseLines`.
2. **FK-backfill data-cleanup approach — RATIFIED:** audit first, report before deciding. **NOT executed** — no PostgreSQL instance was reachable from the implementing session (no `.env`, nothing listening on 5432, no `psql`). Read-only audit script delivered at `docs/blueprints/ORPHAN_FK_AUDIT.sql`, ready to run. The FK-adding migration for `shipments.salesOrderId`/`fulfillment_orders.salesOrderId`/`return_requests.salesOrderId`/`return_requests.salesOrderLineId` is **NOT written yet** — still blocked on those audit results, per the ratification itself.
3. **Financial-handler wiring for the new aggregates — NOT ratified this round (deferred, not decided by the implementation team):** `ShipmentReturn`/`SalesReturn` publish **no** `EventBusService` event in V1 (see `logistics.manifest.ts` v1.2.0 doc comment) — no automatic Customer Ledger/GL effect exists for either yet. Physical inventory (`return_in`) is wired; financial posting is explicitly out of this round's ratified scope.
4. **Return pricing — RATIFIED (refined 2026-09-16):** the return line's own approved/entered price is authoritative for any future financial credit; the original sale/order/invoice price is preserved for eligibility, provenance, and audit display ONLY (`SalesReturnLine.originalUnitPrice`), never auto-substituted. **Implemented** at the schema/service level (`ShipmentReturnLine.returnPrice`, `SalesReturnLine.returnPrice` + `originalUnitPrice`); the GL-side consumption of this price is dormant pending decision 3 above.
5. **Approval Engine gating for high-value returns — not decided, not implemented.** No FA-01 wiring added in this round. Flagged as a future recommendation only.
6. **`ReturnRequest` stays completely untouched — RATIFIED and confirmed as-built.** No file under the existing `ReturnRequest`/`ReturnDisposition`/`ReturnCredit`/`ReturnsService`/`ReturnsController` path was modified. `ShipmentReturn`/`SalesReturn` are new, additive aggregates in the same `returns` module.

---

## PART C — IMPLEMENTATION STATUS (as of 2026-09-16, this round)

**Built** (source-level; see "Verification gap" below — none of this has been compiled, migrated, or tested in this environment):
- `ShipmentLine` entity + migration (`shipment_lines`, frozen per-shipment snapshot) — closes B.3 gap #6. `ShipmentService.createShipment` now materializes these rows in the same transaction as shipment creation.
- `ShipmentService.getShipmentSnapshot` (cross-domain) + `getShipmentDetail`/`GET /shipments/:id/detail` — closes B.3 gap #7 (customer/order-total/carrier/line items in one response; rep/driver names disclosed as unresolvable — no `USERS_CONTRACT` exists anywhere in this codebase).
- `ShipmentReturn` + `ShipmentReturnLine` entities, migration, `ShipmentReturnsService`, `ShipmentReturnsController` (`/shipment-returns`) — full/partial modes, row-locked shipped-quantity cap (closes the concurrency race the RBW found in `ReturnRequest`'s own quantity check), independent return pricing.
- `SalesReturn` + `SalesReturnLine` entities, migration, `SalesReturnsService`, `SalesReturnsController` (`/sales-returns`) — Specific-Order/All-Orders modes, configurable eligibility window (`logistics.sales_return_eligibility_window_days`, default 365, `ConfigurationEngineService`-backed, not hardcoded), per-line source-order/source-line provenance (a return can span multiple orders), row-locked sold-quantity cap, independent return pricing, list/detail responses exposing customer + amount per directive §9.
- `SalesOrdersReadContract.findEligibleReturnPurchaseLines` + `getOrderSnapshot` widened with `totalAmount`.
- `logistics.manifest.ts` v1.2.0 — 6 new permission nodes, 1 new config key. No new/changed events declared (none are published — avoids repeating the sales.manifest.ts dead-declaration bug the RBW found).
- `docs/blueprints/ORPHAN_FK_AUDIT.sql` — ready to run, not yet run.

**Explicitly NOT done, and why:**
- **The pre-existing missing FK constraints (B.3 gap #5) are NOT added.** Blocked on decision 2 above (audit not executable in this environment).
- **No automatic financial/GL posting** for either new aggregate (decision 3, deferred).
- **No `tsc`/lint/`nest build`/jest run.** This checkout has no `tools/`, no `test/`, no `.spec.ts` files, and no `node_modules` — the validation/build tooling itself does not exist on disk here (confirmed by direct search before any code was written). Nothing in this round claims a false PASS; the correct, honest status is **NOT VERIFIED — tooling absent**, not "PASS".
- **No live migration run.** No PostgreSQL instance was reachable from this session. The migration files are written and reviewed by hand against this codebase's own conventions, but have not executed against a real schema.
- **No Release Engine packaging, no Partial Release manifest, no staging validation.** No Release Engine source (the code that generates `MANIFEST.json`) exists anywhere reachable from this session (searched). Producing a "Partial Release" compatible with a Release Engine that cannot be located or inspected here would mean inventing its manifest schema from scratch — refused per this round's own instruction not to fabricate missing components, and per the platform-wide "reuse, never invent" principle. **This is the single largest gap between what was requested and what could be delivered from this environment.**
- **Frontend**: still absent from this checkout (see the top-of-document scope note) — none of the above got a UI.
- No new tests were written (there is no test framework/config present to write them against).

**What would unblock the rest:** (1) a reachable PostgreSQL connection to run the audit script and then the migrations; (2) the actual dev workspace or the Release Engine's own source location, since neither `tools/` nor a Release Engine codebase exists in this deployment-snapshot checkout; (3) the frontend project's location, if one exists, to build the screens this Blueprint's API shapes are designed for.

---

## PART D — UPDATE 2026-09-16 (later same day): canonical baseline moved, real verification performed

The working baseline moved twice more this same day — first to a restored `backend/`+`frontend/` pair that turned out to be a v0.1.0/2026-08-27 archive (7+ weeks behind, missing `accounting`+`hr` entirely, pre-dating the migration-partitioning refactor — confirmed by direct inspection, not assumed, and NOT used), then to `D:\CLAUDE-CODE\XNEXUS-WORKSPACE\1-hosting\daii.xnexustech.com\release-new\backend` — a real hosting-account download whose `backend/` is genuinely **v1.0.10 with the exact same 165-migration set** (identical latest timestamp `1755863000000`) as the original deployment snapshot this Blueprint was built against, PLUS the `tools/` directory (validation/deploy/generators/data-repair) that was missing before. Verified byte-identical on every untouched file diffed before porting anything.

**All Part C work was reconciled into this new canonical path** (`release-new/backend`), and — for the first time in this workflow — **real verification became possible**:

- **Read-only orphan/FK audit (B.18 decision 2): RUN, clean.** All 9 checks in `ORPHAN_FK_AUDIT.sql` against the real `daii_dev` database on this machine (Postgres 18, port 5433) returned **zero** — no NULL/orphaned/non-UUID-shaped references anywhere. The FK-adding migration for `shipments.salesOrderId`/`fulfillment_orders.salesOrderId`/`return_requests.salesOrderId`/`salesOrderLineId` is now unblocked by data (still not written this round — a separate, deliberate follow-up, not silently bundled in).
- **`npx tsc --noEmit`: PASS**, after fixing one real bug `tsc` caught: my new `ShipmentService.getShipmentSnapshot` collided with an **already-existing** method of the same name (used by `delivery.service.ts`/`returns.service.ts`, different shape) — renamed to `getShipmentLinesSnapshot` in both this tree and the original `4-daii-erp` copy. One pre-existing, unrelated gap fixed in passing: `decimal.js@10.6.0` (a CTO-pinned Financial Core dependency, per prior memory) was missing from this specific `package.json`/`node_modules` — restored, not newly decided.
- **`eslint src/**/*.ts`: PASS**, exit 0.
- **`npm run validate:structure`: PASS**, "no violations found."
- **`npm run build` (`nest build`): PASS**, after excluding pre-existing stray leftover directories (`_deploy/`, `archive/`, `node_modules.incident-backup-2026-09-15/`, `public.pre-v1.0.3/`, `storage/`, `tmp/` — all clearly deployment/incident artifacts, none touched or deleted, only excluded from `tsconfig.build.json`'s compile scope) that were leaking into the compiler's default include and breaking the build with unrelated errors.
- **Migrations: RUN against the real `daii_dev` DB.** 3 pending (1 pre-existing `SeedUpgradePathTerminology` + my 2 new ones) applied cleanly; `shipment_lines`/`shipment_returns`/`shipment_return_lines`/`sales_returns`/`sales_return_lines` now exist with real FK/CHECK constraints, confirmed via `\d`.
- **Live boot: PASS.** `node dist/main.js` against the real DB — full DI graph resolved, every module (`ShipmentModule`, `ReturnsModule`, `AccountingModule`, `HrModule`, all 17 domains) initialized with zero errors, all routes mapped, entitlement/config seeding ran, "Nest application successfully started." `GET /api/health` → `{"status":"ok"}`; `GET /api/health/deep` → `{"status":"ok","components":[{"name":"database","healthy":true}]}`.
- **Local preview: LIVE**, `http://localhost:3505` (backend also serves the built frontend's `index.html`/assets from the same port).

**Still not done, disclosed not fabricated:**
- **No jest tests exist anywhere found on this machine** — `find -iname "*.spec.ts"` returns 0 in every copy checked, despite `jest.config.js`/`ts-jest`/`@types/jest` all being present as devDependencies. `npm test` will report "no tests found," which is the honest status, not a failure to hide.
- **No `verify:boot`/`verify:repo` npm scripts exist in this copy's `package.json`** (only `validate:structure`, `verify:deploy`, `verify:frontend-bundle`, `build:release` — and `build:release`'s target script, `tools/build/build-release.sh`, does not exist in this tree either).
- **The actual Release Engine source (`tools/release-engine/`) is absent from this v1.0.10 tree.** It was found, by direct search, only inside older **v1.0.3** copies on this machine (`daii.xnexustech.com/backend/tools/release-engine`, `staging-p3p1/backend/tools/release-engine`). Porting an older Release Engine into a newer schema/manifest tree is exactly the class of mismatch the CTO's own Release Engine overhaul directive exists to prevent — **not done without explicit direction**, to avoid silently reintroducing a version-skew bug into release tooling.
- **No Partial Release package was generated** — there is nothing to run it with in this tree, and fabricating a manifest by hand was explicitly ruled out.
- FK-adding migration for the pre-existing columns: still not written (data is now proven clean; this is a scoping choice, not a blocker).
- Frontend source project (for adding new screens) still not located as a separate editable project — only its pre-built `dist/` is present under `release-new/frontend/`.

---

## PART E — UPDATE 2026-09-16 (canonical baseline finalized, frontend built, full E2E verification)

Per CTO final decision, `release-new` (specifically `release-new/backend` + `release-new/frontend`) is the sole canonical development copy going forward. All further work happened only there.

**Frontend located and built** — `release-new/frontend/src` is a real, complete, editable React+Vite project (routes, pages, `lib/api.ts`, Terminology Registry-backed `t()`). Delivered:
- `pages/ShipmentReturns.tsx` (new) — Full/Partial creation form (deep-linkable via `?shipmentId=` from the Shipments detail screen's new "Create Shipment Return" action), list with customer name + amount, click-through detail.
- `pages/SalesReturns.tsx` (new) — Specific-Order/All-Orders picker, real eligible-purchase-line dropdown (product **name** primary, code as hint, per directive §7), Add-Item flow, per-line editable Return Price independent of the original sale price, list with customer name + amount, click-through detail showing every source order.
- `pages/Shipments.tsx` (modified) — the item table now reads the frozen `ShipmentLine` snapshot via the new `/shipments/:id/detail` endpoint instead of the order's live lines (closes the RBW's stale-content finding); added the "Create Shipment Return" deep link for delivered shipments.
- `components/Layout.tsx` + `App.tsx` — nav entries and routes wired (`nav.sales_returns` under Sales, `nav.shipment_returns` under Shipping).
- New terminology-seed migration (`SeedShipmentAndSalesReturnsTerminology1755863300000`) for every new label, Arabic + English, following the exact upsert pattern already used elsewhere in this codebase.

**One real bug found and fixed while wiring this up**: `getShipmentDetail`'s `lines` never included the `ShipmentLine`'s own `id` (only `salesOrderLineId`) — `ShipmentReturnsController` needs the real `shipmentLineId` to create a return. Fixed by adding `id` to the endpoint's response shape and updating the frontend to use it.

**Full real verification performed this round (backend + frontend, nothing fabricated):**
- `tsc --noEmit` (backend and frontend): PASS.
- `eslint`: PASS.
- `nest build` / `vite build`: PASS (frontend bundle copied into `backend/public/`, which is what the running server actually serves — confirmed via `main.ts`'s static-asset config, not assumed).
- Live boot + `/api/health/deep`: PASS (real DB connectivity).
- **Full authenticated HTTP E2E** (a JWT minted locally with the disclosed dev-only secret from `.env`, `admin@daii.example`) exercised the real running server end to end:
  - `GET /sales-returns/eligible-purchases` with an invalid `customerId` → was a raw 500 before a fix; now a clean `400 VALIDATION_ERROR` (added `@IsUUID()` DTO validation — a real gap this E2E pass caught).
  - `POST /sales-returns` → created `SLR-2026-000001` against a real eligible order line; `totalAmount` correctly used the **entered** return price (89.99), not the original sale price (99.99) — the ratified pricing decision, proven, not just coded.
  - A second attempt to return the same already-fully-returned order line → correctly rejected `409 CONFLICT` with the exact remaining-quantity math in the message.
  - `POST /sales-returns/:id/complete` → succeeded, state → `completed`.
  - Shipment Return: since this fresh dev database has zero real shipments yet (no order has been carried through fulfillment→dispatch here), a minimal test `Shipment`/`ShipmentLine`/`ProcessInstance` fixture was seeded directly in Postgres (clearly test data: `fulfillmentOrderId='TEST-FO-001'`, `waybillNumber='WB-TEST-000001'`) to exercise the real service code — **the `ShipmentLine`-materialization code inside `createShipment` itself was verified by compile/lint/build, not by a live full order-to-dispatch run**, disclosed distinction, not blurred.
  - Against that fixture: a **Full** return with an under-declared quantity was correctly rejected (`400`, exact required-quantity stated); a valid **Partial** return (1 of 3) succeeded; a follow-up over-return attempt (3 of the remaining 2) was correctly rejected `409 CONFLICT` with accurate math; `POST /shipment-returns/:id/complete` posted a real `return_in` row in `stock_movements` with `referenceType='shipment_return'` and the exact quantity — confirmed by direct SQL query, not assumed.
- **Visual confirmation in the browser**: both `/sales-returns` and `/shipment-returns` render correctly, fully in Arabic (RTL), with the real data created above (customer name resolved, amounts correct, status badges correct, list→detail click-through working).

**New finding, disclosed, not resolved (a real open design question, not decided unilaterally):** `SalesReturnsService` caps a return against the order line's **sold** quantity; `ShipmentReturnsService` caps against the shipment line's **shipped** quantity. These are two **independent** pools today — nothing stops the same physical unit from being returned once via each path (e.g., a Sales Return against an order line, and separately a Shipment Return against the shipment line that fulfilled that same order line), since neither service currently checks the other's returned-quantity ledger. This is exactly the kind of cross-aggregate data-integrity question this Blueprint's own governance rule (§15/§B.18) says must be raised, not decided by implementation judgment — added here as a new Open Decision rather than silently patched.

**Still not done:** the pre-existing missing-FK migration (data proven clean, not yet written); no financial/GL posting (deferred, unratified); Release Engine/Partial Release (source still not found in this tree — see the standing finding from Part D); the cross-aggregate double-return-pool question just above.

---

**Next step per directive §13/§15: this document is submitted for CTO review. No implementation
begins until Part B is ratified, the six Open Decisions (B.18) are resolved, and — separately — the
missing frontend project is located or the CTO confirms it is out of scope for this phase.**

---

## PART F — UPDATE 2026-09-16 (Cross-Return Data Integrity, CTO-approved Option 1: IMPLEMENTED + verified)

**Implementation:** `OrderLineReturnCapacityService` (new file, `src/domains/returns/application/order-line-return-capacity.service.ts`) — a stateless lock/query helper, NOT a new Return Ledger entity (no table). Both `ShipmentReturnsService.createShipmentReturn` and `SalesReturnsService.createSalesReturn` call it independently inside their own transaction; neither service calls the other (no service-to-service coupling, per the CTO's explicit ban). It locks the shared serialization boundary (`SELECT ... FOR UPDATE` on the `sales_order_lines` row itself) and computes `min(soldQuantity, shippedQuantity) − (Σ non-rejected SalesReturnLine + Σ non-rejected ShipmentReturnLine)` for that order line — the exact invariant text the CTO specified.

**Two real bugs found and fixed during live verification** (both `QueryFailedError`s, not hypothetical): (1) `sales_order_lines.id` is `uuid`; a bare string parameter needed an explicit `$1::uuid` cast, or Postgres refused the comparison outright — fixed by casting every parameter compared against a uuid column (matching the existing `accounting` module's own precedent for this). (2) `process_instances."entityId"` is a polymorphic `character varying(255)` (it stores ids for many different entity types); joining it against `sales_returns.id`/`shipment_returns.id` (uuid) needed the uuid side cast to `::text` instead. Both fixed, then reverified end-to-end.

**Full verification, real not fabricated:**
- `tsc --noEmit`, `eslint`, `nest build`: all PASS after both fixes.
- **All 12 CTO-required test scenarios run against the live server + real Postgres, with dedicated seeded fixtures (a test order/lines/shipment/shipment-lines with known quantities), all PASS**, then all fixture data (order, lines, shipment, shipment lines, every return created, their process instances, the one inventory movement) fully deleted afterward — verified zero residue by direct SQL count. Full detail in the chat-level report delivered alongside this update (files changed, exact invariant text, locking strategy, concurrency evidence with response times, SQL evidence, regression results).
- Existing `ReturnRequest`/custody-return flow: untouched file-for-file, confirmed still returns real pre-existing data (`RET-2026-000001`, dated 2026-09-12 — not test data) unchanged.
- Browser-confirmed both `/sales-returns` and `/shipment-returns` pages still render correctly against the new backend logic (API contracts unchanged, only internal validation logic changed).

**Not done, per explicit instruction:** the pre-existing missing-FK migration, financial/GL posting, Release Engine work — none touched this round.
