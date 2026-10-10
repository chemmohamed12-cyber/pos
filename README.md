# DAII PLATFORM

Daii is a new, independent business operations platform — Arabic-first, covering Commerce, Sales, Order Management, Warehouse, and Shipment operations, finance-ready by design but with Finance itself deferred to Phase 2.

**Daii is NOT a clone of:**
- XNEXUS baseline (`../baseline/`)
- XNEXUS RMS (`../30/`)
- XNEXUS Website / QR Platform (`../xnexus-website/`)

Those three systems are **source references only**, outside this directory. Daii does not fork, clone, or vendor any of them wholesale. **One disclosed, CTO-authorized exception**: `../xnexus-website/` also gained a small, additive integration bridge (new files only — `server/engines/daii-integration-engine.js`, `server/repositories/daii-integration-repository.js`, a handful of new routes in `server/server.js`) so the QR ↔ Daii handshake below could be proven with a real running QR server, not a mock — see `MASTER_HANDOVER.md` §3 for exactly what changed there and why. `../baseline/` and `../30/` remain fully untouched.

Daii selectively extracts validated architectural patterns and reusable domain concepts from those sources — identified and classified in [`_source-audits/`](_source-audits/README.md) — while **rebuilding persistence, security, identity, authorization, scope, and business boundaries according to Daii's own architecture**, defined in [`architecture/`](architecture/).

---

## Workspace Structure

```
Daii/
├── _source-audits/        Stage 0 evidence — completed, archived, not re-run. Cite, don't repeat.
│   ├── baseline/
│   ├── rms-step30/
│   └── xnexus-website/
│
├── architecture/           Stage 1 target architecture — planning only, no code
│   ├── decisions/          ADRs
│   ├── foundations/        (reserved — per-capability deep-dive docs beyond the Foundation Contract)
│   ├── domains/            (reserved — per-domain deep-dive docs beyond Domain Boundaries)
│   ├── api/                (reserved — API contract detail beyond API Architecture)
│   ├── data/                (reserved — schema detail beyond Data Architecture)
│   ├── security/            (reserved — security detail beyond Security Architecture)
│   └── extraction/          Source → Daii extraction matrix
│
├── planning/
│   ├── stage-1/             Stage 1 plan, stack decision, risk register, readiness assessment
│   └── decisions/           (reserved for planning-level decisions distinct from architecture ADRs)
│
├── docs/                    Engineering governance
│
├── backend/                 Stage 2 — NestJS/TypeScript/PostgreSQL implementation
│
├── frontend/                Stage 2 — the real operational UI (React/TypeScript/Vite, Arabic-first)
│
└── README.md                This file
```

## Current Status

**Stage 0 (Discovery): COMPLETE.** Three source repositories audited and archived.
**Stage 1 (Architecture & Extraction Planning): COMPLETE** — see [`planning/stage-1/STAGE_1_ARCHITECTURE_EXTRACTION_PLAN.md`](planning/stage-1/STAGE_1_ARCHITECTURE_EXTRACTION_PLAN.md) for the plan and [`planning/stage-1/STAGE_1_IMPLEMENTATION_READINESS.md`](planning/stage-1/STAGE_1_IMPLEMENTATION_READINESS.md) for the current READY/NOT READY assessment (unchanged by Stage 1.1 below).
**Stage 1.1 (Platform Maturity, Reusability, Deployment & Future-Readiness Extension): COMPLETE** — see [`planning/stage-1.1/STAGE_1_1_MATURITY_EXTENSION_PLAN.md`](planning/stage-1.1/STAGE_1_1_MATURITY_EXTENSION_PLAN.md). Extends Stage 1 with a Platform-Grade Capability Standard, a Reusable Platform Capability Contract, and a Cloud/On-Premise/LAN deployment-independence requirement (ADR-015) — does not revise any Stage 1 decision.
**Stage 2 (Implementation): Phase A + Phase B both COMPLETE, verified live.** Platform Foundation (20/20 items) and all 12 Business Domains are built at [`backend/`](backend/) — AND verified end-to-end against a real running PostgreSQL instance (not just mocks): the full flow (Customer → Sales Rep → Sales Order → Review → Approval → Deposit → Stock Reservation → Pick → Pack → Shipment → Waybill → Tracking → Delivery → Collection/Return) has been driven through the real operational UI at [`frontend/`](frontend/), including a genuine multi-line order. A real concurrency bug (connection-pool exhaustion in the Audit Engine under concurrent Inventory reservations) was found and fixed this way — see `architecture/DAII_DATA_ARCHITECTURE.md` §4's verification note. A real operational UI now exists — see Quickstart below — covering Dashboard, Customers (+ Sales Rep assignment, + per-customer workflow policy), Sales Orders (create/approve/reject/resubmit, line discounts), Deposit Control (incl. reject/resubmit), Stock Reservation, Products, Warehouses, Inventory, Fulfillment (pick/pack), Shipments (dispatch + driver), Returns, Organization (hierarchy), and Admin (role assignment) — Arabic-first (RTL, Terminology Registry-driven, no hardcoded per-screen translation), with an English/LTR toggle. Excel Import/Export is live for Customers, Products, and Inventory. See ADR-021 / `architecture/DAII_SYNC_READINESS_NOTE.md` for the (documentation-only, no code yet) future Local↔Cloud sync-readiness posture. Not yet built: real infrastructure adapters beyond local-filesystem media storage, and the simplified driver-assignment model in Shipment (a disclosed V1 scope reduction from QR Platform's fuller Offer/Accept dispatch pattern). Price Lists (G-3) and BOM/Assembly (G-2) — see `planning/excel-mapping/EXCEL_BUSINESS_MAPPING_PACKAGE.md` — are resolved; see Phase C below.

**Phase C (post-Stage-2 hardening, in progress):** Gap G-1 (`planning/excel-mapping/EXCEL_BUSINESS_MAPPING_PACKAGE.md`) resolved — Sales Order workflow is now per-customer policy-driven (`Customer.orderWorkflowPolicy`: `standard` preserves the full supervisor+manager+deposit chain exactly as built; `open_account` is the trusted-customer fast path, submit→released, matching the real business's evidenced open-account trade-credit practice). Snapshotted per order (`SalesOrder.workflowPolicy`) so a later policy change never retroactively alters an in-flight order. Admin/sales_manager-only via `POST /customers/:id/workflow-policy`. Gap G-4 (line-level discounts) also resolved — `SalesOrderLine.discountAmount`, server-validated against each line's own gross total. Gap G-3 (Price Lists / price variance) also resolved — Commerce `PriceList`/`PriceListItem` entities, per-customer assignment (`Customer.priceListId`), effective-price resolution at order creation (`SalesOrderLine.listPrice` vs. `unitPrice` gives variance), Excel import/export for list items, own print page (`price-lists` nav item, admin/sales_manager for writes). All three verified live against a running PostgreSQL instance (not just mocks). Gap G-2 (BOM/Assembly) also resolved — Commerce `BillOfMaterial`/`BomComponent` (one BOM per finished product, admin-gated), Inventory/Warehouse `InventoryService.assembleProduct` (atomic: checks every component's availability, then writes `assembly_consumption`/`assembly_output` movements under sorted advisory locks — a shortfall on any component blocks the whole run, verified live with zero partial writes). `nav.bom` (admin) and an "Assemble" panel on the Inventory screen (warehouse_worker/admin). A real live bug was found and fixed this way: `stock_movements.movementType` was too narrow (`VARCHAR(16)`) for `'assembly_consumption'`, widened to `VARCHAR(32)`. 196 tests, 35 suites, all passing.

**Phase D — External Integrations / QR Store connector (CTO directive "Daii ↔ QR Store Integration & Pairing Architecture"):** QR Store stays fully independent (own DB, own Storefront/CMS, unmodified in `../xnexus-website/`) — Daii built a reusable Control Center foundation (`foundation/integrations/`) rather than a QR-specific hack, so future connectors (shipping, payment, marketplaces) register the same way (`domain/connector-types.ts`). Built: `IntegrationConnector`/`IntegrationCredential` (AES-256-GCM at rest, `INTEGRATION_ENCRYPTION_KEY`, fail-closed-in-production like the JWT secrets), `IntegrationProductMapping` (SKU+UUID, never name — verified live), `IntegrationSyncLog` (doubles as the idempotency ledger — a retried QR order id never creates a second Sales Order, verified live and by test). Outbound: `commerce.product.created`/`commerce.product.status_changed` auto-publish to every connected connector via the existing (previously-dormant) Event Outbox (`EventBusService`); availability/order-status are manual/on-demand for V1 (disclosed scope cut — no real-time push yet). Inbound: `POST /integrations/qr/:connectorId/orders`, machine-authenticated (`IntegrationAuthGuard`, never a user JWT), reuses the Sales Order/CRM domains unchanged (mirrors the Excel-import customer+assignSalesRep pattern). Control Center UI at `/integrations` (admin-only). QR is not running locally, so outbound calls fail gracefully by design (logged `failed`, never crash the triggering request — verified live) per the directive's own "connector architecture testable without blocking the rest of Daii" allowance; the explicit HTTP contract QR's own side must implement is documented in `qr-store.connector.ts`. Not built (disclosed): the general Sync Engine, EXE packaging, and Sales Order cancellation (Daii's Process Engine has no `cancelled` state yet — a Sales Orders domain gap, not smuggled in here). 221 tests, 37 suites, all passing.

**Phase E — Operational Reports (V1 Release Candidate prep):** a new cross-domain `domains/reports/` composition layer (no Reports entry exists in `DAII_DOMAIN_BOUNDARIES.md` — the closest precedent is `Dashboard.tsx`'s client-side composition of existing list endpoints; this is the same idea, server-side only where aggregation/Excel export needs it). Computes zero business rules of its own — every row comes from an existing domain service's own published method (`SalesOrdersService.listOrders`, already Scope-filtered — a plain sales_rep sees only their own orders in every report, inherited for free, never reimplemented), enriched with names via `CustomersService`/`UsersService` and deposit status via `DepositsService`. Sales Orders / Sales by Period / Sales by Customer / Sales by Rep all aggregate over that one base row set — "Deposit / order operational status" is the Sales Orders report itself (status + latest deposit status/amount per order), not a separate screen. Two small, genuine gaps filled in Inventory (no business logic, pure filtered/aggregated reads over the existing ledger): `InventoryService.listMovements` (`GET /inventory/reports/movements`, filterable by warehouse/product/type/date) and `getStockReport` (`GET /inventory/reports/stock`, vectorized on-hand/reserved/available across every product in a warehouse — same formula `getOnHand`/`getReserved`/`getAvailable` already use, just batched instead of N+1). Fulfillment/Shipments/Delivery/Returns report tabs are pure frontend composition of already-existing list endpoints — no backend code needed (Delivery has no "list all outcomes/collections" endpoint by design, so its tab composes `GET /shipments` with a per-shipment outcome/collection fetch, same N-calls-at-V1-scale pattern already used by the Sales Order detail screen's deposit panel). Excel export (reusing `ExcelService` unchanged) on every report that has one: Sales Orders, Sales by Period, Sales by Customer, Sales by Rep, Stock Report, Warehouse Movements. `nav.reports`, broadly available to every authenticated user (Scope enforcement is inherited, not gated at the route). Verified live end-to-end, including the actual UI in both Arabic (RTL) and English (LTR) — all ten tabs, filters, and one export downloaded and confirmed as a valid non-trivial `.xlsx`.

**Phase F — Real QR↔Daii handshake, Customer CRM Excel format, and three-tier Sales Order pricing (CTO instructions):** (1) The Daii-side QR connector foundation (Phase D) was proven against a REAL running QR server (`../xnexus-website/server/server.js`, port 4000), not a mock — pairing, connection test, and bulk product publish (13 products) all verified live end-to-end; steps 4-12 of the handshake (price/availability change propagation, a real customer order QR→Daii, idempotency retry, order-status push-back) are **in progress, not complete** — see `MASTER_HANDOVER.md` §3 for the exact resume point, credentials, and pitfalls already hit and fixed (a real `require()`-ordering crash on the QR side; a `localhost`-vs-`127.0.0.1` IPv6 resolution quirk on this machine). A genuine gap surfaced by the handshake itself was fixed along the way: Daii had no way to change a product's price after creation at all (`ProductsService.updatePrice`, new `POST /products/:id/price`, publishes `commerce.product.price_changed`). (2) Gap G-5 — `Customer` gained the real CRM master sheet's own field set (`احمد/شيت تحليل العملاء الرئيسي الجديد.xlsx`, sheet `بيانات العملاء`) verbatim as Daii's customer import/export format (exact Arabic column headers, sales rep matched by NAME since the real sheet has no email column — `UsersService.findByFullName`), not an invented shape — verified live with real UTF-8 Arabic data end-to-end. (3) Sales Order creation gained a per-rep sequential order number (`SalesOrder.repSequenceNumber`, reuses the Numbering Engine's own row-locked per-key counter, independent of the global `orderNumber`) and three-tier line pricing — list price (existing Gap G-3) → optional rep-entered override → optional manager-entered override, `managerPrice` honored only when the ACTUAL creating user holds sales_manager/admin (never trusted from the client), which required allowing a manager to create an order under a different rep's name (the only way a manager price can ever be set at all — a plain rep still can only ever create their own orders). A real bug found and fixed live: a rejected `managerPrice` attempt was burning a rep's sequence slot before the authorization check was moved ahead of the Numbering Engine calls. (4) The Sales Order detail screen (CTO instruction, with a screenshot of the live order) gained the customer's name/phone, the responsible rep's name, and the actual order creator's name — `SalesOrdersService.getOrderDetailView` (new `SalesOrder.createdByUserId`, distinct from `salesRepUserId` since a manager may now create under a different rep's name) enriches the existing Scope/Role-checked `getOrder` via each domain's own published snapshot contract (`CustomersService.getCustomerSnapshot`, `UsersService.findById`), never a direct cross-domain query; degrades to `null`/`—` rather than throwing for pre-existing orders that predate the `createdByUserId` column — verified live against the exact order from the screenshot (`SO-2026-000016`). 256 tests, 38 suites, all passing.

**Dashboard improvement (same slice):** `Dashboard.tsx` now reuses the Reports endpoints above instead of only its original four counters — this month's sales total, pending-deposit count, shipments in transit, and a top-5 Sales-by-Rep mini table, alongside the original open-orders/released/pick/pack/returns cards. No new backend code and no recomputed totals: every number is the same `/reports/*` data the Reports screen shows, just summarized on the landing page. Verified live (Arabic and English).

## Quickstart — running Daii locally

Everything below targets a developer machine with Node.js 18+ and no Docker requirement (a portable, no-admin-rights PostgreSQL works fine — see below).

1. **PostgreSQL** — any reachable Postgres 14+ works. For a portable, install-free option: download the official EDB Windows "binaries only" zip, then:
   ```bash
   initdb -D ./pgdata -U daii --pwfile=<(echo daii_dev_only)
   pg_ctl -D ./pgdata -l pg.log start
   createdb -U daii daii_dev
   ```
2. **Environment** — set these (a `.env` in `backend/` works, or export them):
   ```
   DB_HOST=127.0.0.1
   DB_PORT=5432
   DB_USER=daii
   DB_PASSWORD=daii_dev_only
   DB_NAME=daii_dev
   PORT=3500
   ```
3. **Migrations** (creates every table — never run manually, no `synchronize: true` anywhere per ADR-003):
   ```bash
   cd backend
   npm install
   npm run migration:run
   ```
4. **Backend**:
   ```bash
   npm run build && node dist/main.js
   ```
   Confirm with `curl http://localhost:3500/api/health/deep` — expect `{"success":true,"data":{"status":"ok", ...}}`.
5. **Frontend** (separate terminal):
   ```bash
   cd frontend
   npm install
   npm run dev
   ```
   Opens on `http://localhost:5173`, proxying `/api` to the backend (see `frontend/vite.config.ts`).
6. **First login** — the very first account ever registered via `POST /api/auth/register` (or the frontend's own register flow, if wired to the login screen) automatically becomes `admin` (a disclosed bootstrap convenience, not a production security model — see `AuthService.register`'s doc comment). Use that admin account to assign roles to every other persona you register (`sales_rep`, `sales_supervisor`, `sales_manager`, `warehouse_worker`, `driver`) via the Admin screen.

A legacy raw-API demo console still lives at `backend/public/` (served at the backend's own root, outside the `/api` prefix) — useful for direct endpoint exploration, but the `frontend/` app above is the real product UI; day-to-day operation should go through it, not the raw console.

## Governing Principles (see `docs/DAII_ENGINEERING_GOVERNANCE.md` for the full set)

1. No blind repository cloning.
2. No silent refactoring or silent copying — every extraction has a written rationale.
3. Source repositories (`baseline/`, `30/`, `xnexus-website/`) remain immutable references; Daii never writes back to them.
4. Every stub, in Daii's own code once written, must be labeled as a stub in-source, not just in a document.
5. Security decisions must be server-side enforceable — no UI-only gates.
6. Every non-trivial architectural decision is recorded as an ADR before implementation depends on it.
