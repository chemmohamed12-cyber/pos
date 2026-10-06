# FRONTEND-NAVIGATION-AND-OPERATIONAL-FLOW-AUDIT (2026-10-06)

**Type: ANALYSIS ONLY.** No code, UI, route, sidebar, contract or backend change was made. Evidence tags: **VERIFIED** (read in source or observed in the running app), **INFERRED** (reasoned from verified facts), **UNVERIFIED** (not checked).

**Sources used (all VERIFIED unless stated):** the server-side navigation registry `backend/src/foundation/navigation/navigation-registry.ts` (the actual source of `GET /me/navigation`); the SPA route table `frontend/src/App.tsx` (131 routes); the 16 cover pages `frontend/src/pages/covers/*`; each screen's API calls; the backend process definitions and `registerRequestType` calls; the financial-event handler registry; the permission/approval code; and the live app run during Browser Verification #1 (sidebar groups and Arabic labels read from the rendered DOM). **Not done:** per-role sidebar enumeration (UNVERIFIED), opening every screen (only ~25 screens were exercised in the browser), visual/RTL review.

---

## A. Current Navigation Map

The sidebar is server-driven: 16 named groups + 2 standalone entries (Home, Reports) = 18 groups, **75 item entries (74 distinct routes — `/customers` appears twice)**, 16 cover pages (a group header links to its cover), plus a separate **Control Plane** section for platform administrators (`/control-plane`, `/control-plane/plans`, company create/detail — rendered by `Layout.tsx`, not by the registry). Group order and Arabic labels (VERIFIED from the rendered sidebar):

| # | Group (Arabic label) | Registry key / cover | Items (route) — gating |
|---|---|---|---|
| 1 | الرئيسية Home | `/` | Dashboard — ungated |
| 2 | المبيعات Sales | `nav_group.sales` → `/sales` | Customers `/customers` · Sales Orders `/sales-orders` · Returns `/returns` (module `logistics`) — ungated; Sales Returns `/sales-returns` — node `logistics.sales_return` |
| 3 | المخازن Warehouses | `/warehouse-overview` | Warehouse Overview · Warehouses `/warehouses` · Movement Center `/movement-center` · Inventory `/inventory` · Stock Count `/stock-count` — all legacy roles (warehouse_worker/supervisor/inventory_controller/admin) |
| 4 | التجهيز "Production" Fulfilment | `nav_group.production` → `/fulfillment-overview` | Fulfilment `/fulfillment` — roles warehouse_worker, admin |
| 5 | الشحن Shipping | `/shipping` | Shipments (driver, admin) · Shipping Methods (admin) · Custody Returns (admin, warehouse_worker, sales_supervisor) · Collection Settlements (admin, finance) · Shipment Returns — node `logistics.shipment_return` |
| 6 | العملاء والحسابات Customers & Accounts | `/customers-accounts` | Customers (duplicate of #2) · Customer Accounts · Customer Statement · Invoices · Payments · AR Aging — all ungated (module `finance`) |
| 7 | الخزينة Treasury | `/treasury` | Treasury Accounts · Treasury Ledger — node `finance` |
| 8 | الأصناف والأسعار Catalog | `/catalog` | Products (ungated) · Price Lists (admin, sales_manager) · BOM `/bom` (admin) |
| 9 | التقارير Reports | standalone `/reports-overview` | Reports cover (sales/operations reports) — ungated |
| 10 | الموارد البشرية HR | `/hr` | Employees · Departments · Leave Requests — nodes `hr.*` |
| 11 | المحاسبة Accounting | `/accounting` | Chart of Accounts · Journals · Trial Balance · General Ledger · Financial Events · AR Reconciliation · AP Reconciliation · Cash/Bank Reconciliation · Fixed Assets · Inventory Accounting · GRNI Reconciliation · Fiscal Periods · Balance Sheet · Profit & Loss · Cash Flow (15) — nodes `accounting.*` (+ features) |
| 12 | المشتريات Procurement | `/procurement` | Suppliers · Purchase Orders · Purchase Requests · RFQs · Supplier Invoices · Supplier Statement · AP Aging — nodes `procurement.*` |
| 13 | الحضور والانصراف Attendance | `/attendance` | Connectors · Import · Biometric Import · Facts · Days |
| 14 | الرواتب Payroll | `/payroll` | Periods · Compensation · Runs |
| 15 | المستهدفات Targets | `/targets` | Targets |
| 16 | العمولات Commission | `/commission` | Policies · Results · Batches |
| 17 | التصنيع Manufacturing | `/manufacturing` | Work Orders · BOMs `/manufacturing/boms` · Routings · Work Centers · Assembly |
| 18 | الإدارة Administration | `/administration` | Organization · Admin (users/roles) · Integrations · Release Center (admin) · **Approvals `/approvals` (node `core.approval`)** |

**Gating style (VERIFIED, computed from the registry):** 47 items gated by a Permission-Engine node, 16 by legacy role lists, **12 ungated** (Home, Customers ×2, Sales Orders, Returns, Customer Accounts, Customer Statement, Invoices, Payments, AR Aging, Products, Reports). The registry's own header documents this mixed model as a deliberate, temporary state. Every module is currently entitled (`ENTITLEMENT_MODE=unlicensed-full`), so the `module` gate is a no-op today.

**Reachability (VERIFIED):** every nav route has a screen. 131 routes exist; screens that are *not* in the sidebar and are reachable only from a cover, another screen, or a deep link: `/accounting/dimensions` and `/accounting/settings` (cover only), `/accounting/fiscal-periods/:id/closing-audit|closing-exceptions|closing-snapshots` (from Fiscal Periods), `/reports` (from the Reports cover/dashboard), detail screens (`/sales-orders/:id`, `/invoices/:id`, `/customers/:id/account`, `/accounting/journals/:id`, `/payroll/runs/:id`, `/manufacturing/work-orders/:id`, `/movement-center/:id`, `/custodian/:type/:id`) and 18 print routes. Transactions that have **no screen of their own** and live inside another screen: Goods Receipt (inside Purchase Orders), Supplier Payment (inside Supplier Invoices), New Item Request (inside Purchase Requests), Customer Invoice creation and Customer Payment / On-account payment (inside Customer Account; the "Payments" menu is list-and-print only), Customer Deposit (inside Sales Order), Opening-stock import (inside Inventory), Treasury cash-in / cash-out / transfer (inside Treasury Ledger).

---

## B. Functional Classification

| Class | Screens (route key) |
|---|---|
| **Master data** | Customers · Suppliers · Products · Price Lists · BOM (×2) · Warehouses · Shipping Methods · Treasury Accounts · Chart of Accounts · Employees · Departments · Work Centers · Routings · Commission Policies · Targets · Organization · Admin (users/roles) · Integrations · Accounting Settings (currencies, tax) · Dimensions · Attendance Connectors · Payroll Compensation |
| **Transactions** | Sales Orders · Returns / Sales Returns / Shipment Returns / Custody Returns · Fulfilment tasks · Shipments · Movement Center (warehouse transactions) · Purchase Requests · RFQs · Purchase Orders (+ Goods Receipt) · Supplier Invoices (+ Supplier Payment) · Invoices · Payments · Treasury Ledger actions · Journals · Fixed Assets (register, disposal) · Leave Requests · Work Orders · Assembly · Attendance Import / Biometric Import |
| **Processing / control** | Approvals · Fiscal Periods (+ closing audit / exceptions / snapshots) · Financial Events · AR / AP / Cash-Bank / GRNI reconciliations · Inventory Accounting (reconciliation + adjustments) · Stock Count · Collection Settlements · Payroll Periods / Runs · Commission Batches · Release Center |
| **Inquiry / statement** | Customer Accounts · Customer Statement · Supplier Statement · AR Aging · AP Aging · Warehouse Overview · Inventory · Attendance Facts / Days · Commission Results |
| **Reporting** | Reports (sales/operations tabs) · Trial Balance · General Ledger · Balance Sheet · Profit & Loss · Cash Flow · Reports cover |

Observation (VERIFIED from the table above): groups mix classes — e.g. "Customers & Accounts" combines master data (Customers), transactions (Invoices, Payments) and inquiries; "Accounting" combines master data, transactions, processing and reporting in one 15-item flat list.

---

## C. Dependency Map (who depends on what)

```
Chart of Accounts + Fiscal Year/Periods + Currency + Tax ──┐ (required before ANY posting)
Configured policy accounts (12 effective keys + 5 unconsumed, section I NAV-02) ─────┤
Treasury Accounts (GL-mapped) ──────────────────────────────┤
                                                            ▼
Customers ─┐                         ┌─► Customer Ledger ─► Financial Events ─► Journals ─► TB/GL/Reports
Products ──┼─► Sales Order ─► Deposit/Approval ─► Fulfilment ─► Shipment ─► Delivery/COD ─┘
Warehouses ┘      │                          │ (stock movement: dispatch ⇒ COGS)
                  └─► Invoice ─► Payment ───┘
Suppliers ─┐
Products ──┼─► PR ─► RFQ ─► Quotation ─► Award(approval) ─► PO ─► Goods Receipt ─► Supplier Invoice ─► Supplier Payment ─► Supplier Ledger/AP ─► Events ─► GL
Warehouses ┘                                   │ (receipt ⇒ stock + GRNI)
Employees ─► Attendance ─► Payroll Run (approval) ─► Disburse (Treasury) ─► Event ─► GL      Targets ─► Commission ─► (INFERRED: payroll)
BOM ─► Routing/Work Center ─► Work Order ─► material issue / FG receipt ─► Events ─► GL (WIP)
Fixed Asset register ─► acquisition journal (manual + link, or helper) ─► depreciation run ─► disposal (approval) ─► GL
```

---

## D. Operational Process Maps (Prerequisites → Input → Processing → Output → Next)

**D1. Sales (order-to-cash) — VERIFIED from routes/APIs/process definitions**
Prerequisites: Customer, Products (+ Price List), Warehouse with stock. Input: Sales Order (lines, price list, optional deposit). Processing: order approval stages (`supervisor_review`, `manager_approval`, `deposit_verification` — Process Engine), fulfilment pick/pack/verify, shipment (waybill, driver, COD), delivery (dispatch movement ⇒ stock out + COGS event). Output: delivered order; dispatch movement; (deposit verified ⇒ Dr bank/Cr AR event). Next: **Invoice created and posted from the Customer Account screen** (`finance.invoice.posted` event) → **customer payment recorded from the same screen** (`finance.payment.recorded`) or on-account payment → Customer Ledger → GL; returns via four return screens (D4 accounting). Reports: AR Aging, Customer Statement, Reports cover.

**D2. Procurement (procure-to-pay) — VERIFIED**
Prerequisites: Supplier, active Products (or a New Item Request approved), Warehouse. Input: Purchase Request (lines) → submit → approve. Processing: RFQ created from an approved PR (suppliers invited) → send → quotations recorded → **Award = Approval-Engine request** (`procurement.rfq_award`) → approval auto-creates the PO → PO approve (Process Engine) → **Goods Receipt posted from the PO screen** (stock + GRNI event) → Supplier Invoice (3-way match; PPV / Input VAT; post ⇒ event) → **Supplier Payment from the Supplier Invoices screen** (treasury cash-out + supplier ledger + event). Output: Supplier Ledger/AP, GRNI, stock. Next: Supplier Statement, AP Aging, AP/GRNI reconciliation (Accounting). Direct PO creation (without PR/RFQ) also exists.

**D3. Inventory — VERIFIED**
Prerequisites: Products, Warehouses, (default-warehouse assignment). Input: Movement Center transactions (receipt, issue, transfer, adjustment), opening-stock Excel import, Stock Count. Processing: transaction lifecycle (submit/approve/post — Process Engine); valuation (moving average); GL per the D3 policy (opening/adjustment/manual receipt/return-in post, transfer does not; dispatch ⇒ COGS). Output: stock ledger, valuation, journals. Next: **Accounting → Inventory Accounting** (reconciliation runs, count-variance adjustments — Approval Engine), GRNI reconciliation.

**D4. Treasury — VERIFIED**
Prerequisites: Treasury Account Types, Treasury Accounts **GL-mapped** (done inside Treasury Accounts). Input: cash-in / cash-out / transfer (from the Treasury Ledger screen); receipts from customer/supplier payments and deposits/COD remittance. Processing: ledger entry + `treasury.cash.recorded` / `treasury.transfer.completed` events (fail-closed when unmapped). Output: balances, journals. Next: Accounting → Cash/Bank Reconciliation.

**D5. Accounting — VERIFIED**
Prerequisites: Chart of Accounts, Fiscal Year (activated) + Periods, base Currency, Tax codes, **policy account configuration**. Input: manual Journals, approvals-driven adjustments (AR/AP/cash/inventory), fixed-asset actions; most postings arrive as Financial Events. Processing: event → handler → journal draft → posting gate. Output: Journals, GL, TB, statements. Controls: sub-ledger reconciliations, Fiscal Period close (approval), closing audit/exceptions/snapshots.

**D6. Fixed Assets — VERIFIED**
Prerequisites: cost/accumulated-depreciation/expense accounts. Input: asset register entry (pending acquisition). Processing: acquisition journal (manual JE + link; helper deferred by CTO), depreciation run, disposal (approval; gain/loss accounts configured). Output: journals; asset lifecycle. Next: reconciliation of fixed-asset control accounts.

**D7. HR / Payroll / Commission — VERIFIED (relationships INFERRED where noted)**
Employees/Departments → Leave Requests (approval) → Attendance (connectors, import, biometric, facts, days) → Payroll Periods + Compensation → Payroll Run (approval) → **Disburse from Payroll Run detail (Treasury account)** → `payroll.run.posted` event → GL. Targets → Commission Policies → Results → Batches (approval). Commission feeding payroll: INFERRED (no verified code path read).

**D8. Manufacturing — VERIFIED**
Products → BOM → Routings/Work Centers → Work Order (release snapshots the BOM) → material issue / return / finished-goods receipt (three events → WIP/inventory GL) → completion. Assembly is a separate lightweight flow.

---

## E. Data Entry Sequence (the natural order) and what the UI does about it

1. **Foundation:** Organization / users & roles (Administration) → Company-level accounting setup: Chart of Accounts → Currency/Tax (Accounting Settings, reachable only from the Accounting cover) → Fiscal Year (activate) → **policy account configuration** (no UI — NAV-02) → Treasury Accounts + GL mapping.
2. **Master data:** Products → Warehouses (+ default assignment) → Customers → Suppliers → Price Lists → (BOM/Routings/Work Centers) → Employees/Departments.
3. **Operations:** purchase path (PR → RFQ → Award → PO → GR → Supplier Invoice → Payment); sales path (Order → Deposit → Fulfilment → Shipment → Invoice → Payment); inventory movements and counts; payroll cycle.
4. **Control & close:** reconciliations → fiscal period close → reports.

**Does the UI support this order? NO (VERIFIED).** There is no onboarding / setup checklist / wizard anywhere in the frontend (a source-wide search found none). The sidebar order is a domain order, not a setup order: Sales and Warehouses come first, **Catalog (Products) sits after Treasury, Accounting after HR, Procurement after Accounting**, and inside Procurement the items run Suppliers → **Purchase Orders** → Purchase Requests → RFQs (PO listed before the PR/RFQ that precede it). Covers list links but not prerequisites or sequence. In this program's own testing, missing prerequisites surfaced as backend failures (events REJECTED for an unmapped treasury account, an unset policy account, no open fiscal year) rather than as guidance in the UI.

---

## F. Cross-Module Relationships (VERIFIED unless noted)

| Relationship | How it works today | Navigation consequence |
|---|---|---|
| Sales ↔ Customers | Orders reference customers; invoices/payments live in Customers & Accounts | Customers listed twice (Sales and Customers & Accounts, same route) |
| Sales ↔ Inventory | reservations, fulfilment tasks, dispatch movement | Fulfilment is under the group labelled "Production" (التجهيز) |
| Sales ↔ Delivery/Shipping | shipments, COD, collection settlements | four return screens split across Sales and Shipping |
| Sales ↔ Treasury | payments and deposits post to a GL-mapped treasury account | treasury mapping is a hidden prerequisite |
| Sales ↔ Accounting | invoice / payment / deposit / COD / sales-return events | operational screens show no accounting status (section H) |
| Procurement ↔ Suppliers/Inventory/AP/Treasury | PR→PO→GR (stock, GRNI)→Supplier Invoice→Payment (treasury) | GR and Supplier Payment have no menu entry |
| Inventory ↔ Products/Warehouses | default assignment, stock ledger | Catalog and Warehouses are separate groups far apart in the menu |
| Inventory ↔ COGS/GL | D3/D4 policy, valuation | count variance approval sits in Accounting, the count itself in Warehouses |
| Fixed Assets ↔ Accounting | acquisition/disposal journals | placed inside Accounting (reasonable) |
| HR ↔ Payroll ↔ Treasury ↔ GL | payroll run → disburse (treasury) → event → GL | Payroll Run detail is the one screen that shows the financial-event status |
| Manufacturing ↔ Inventory/GL | BOM snapshot, 3 movement events | BOM exists in Catalog **and** Manufacturing |
| Targets → Commission → Payroll | INFERRED | — |

---

## G. Approval Relationships

**Two different mechanisms (VERIFIED):**
1. **Approval Engine (maker/checker, central Approvals screen)** — 29 request types with approval-matrix rules shown in the running Approvals screen, plus the RFQ-award type: RFQ award, New Item Request, supplier bank-account change, fixed-asset disposal, fiscal period close / reclose / reopen, fiscal year close, AR / AP / cash / inventory adjustment kinds, payroll run, commission batch, targets, attendance batch/correction, leave request. Decided on `/approvals` (Administration, node `core.approval`); the originating screens show a "pending approval" state only in a few cases (RFQ award, D6).
2. **Process-Engine state transitions inside each screen** — Purchase Request (submit/approve/reject), Purchase Order (submit/approve/reject), warehouse transactions (submit/approve/post), sales-order stages (supervisor review, manager approval, deposit verification), returns (reject). These **do not appear in the Approvals screen**.

**Segregation of duties is not uniform (VERIFIED):** Approval-Engine requests enforce maker ≠ checker; Process-Engine approvals do not (the D7 spec shows the requester submitting *and approving* the same Purchase Request). Customer payments, supplier payments and treasury cash movements have **no approval step** (0 approval references in their services). Whether that is intended policy is a CTO decision, not a finding of defect.

**Visibility:** no "my pending approvals" indicator on the Dashboard (the dashboard loads only sales/fulfilment/shipment data); Approvals is the last item of Administration; six request types render a raw key instead of a title (reported earlier; one fixed).

---

## H. Accounting Flow Relationships

Operational screen → event → handler → sub-ledger → GL (VERIFIED from the handler registry and services):

| Operation (screen) | Event | Sub-ledger / effect | GL |
|---|---|---|---|
| Invoice post (Customer Account) | `finance.invoice.posted` / voided | Customer Ledger debit | Dr AR / Cr Revenue (+tax) |
| Customer payment / on-account (Customer Account) | `finance.payment.recorded` | Customer Ledger credit (unapplied if on-account), Treasury cash-in | Dr mapped bank / Cr AR |
| Deposit verified (Sales Order) | `deposit.verified` | Customer Ledger credit | Dr bank / Cr AR |
| COD remitted (Collection Settlements) | `collection.remitted` | Customer Ledger credit | Dr bank / Cr AR |
| Sales return completed (Sales/Shipment Returns) | `returns.sale_return.credited` | Customer Ledger credit, stock in | Dr Sales Returns / Cr AR, Dr Inventory / Cr COGS |
| Dispatch / delivery | inventory movement event | valuation | Dr COGS / Cr Inventory |
| Goods Receipt (PO screen) | `procurement.goods_receipt.posted` | stock + valuation | Dr Inventory / Cr GRNI |
| Supplier invoice post (Supplier Invoices) | `finance.supplier_invoice.posted` / voided | Supplier Ledger | Dr GRNI (+PPV, Input VAT) / Cr AP |
| Supplier payment (Supplier Invoices) | `finance.supplier_payment.recorded` | Supplier Ledger debit, Treasury cash-out | Dr AP / Cr mapped bank |
| Cash in/out/transfer (Treasury Ledger) | `treasury.cash.recorded`, `treasury.transfer.completed` | Treasury ledger | per mapped accounts |
| Payroll run disburse (Payroll Run detail) | `payroll.run.posted` | Treasury cash-out | Dr payroll / Cr bank |
| Work order (Work Order detail) | material issued / returned / FG received | WIP | WIP ↔ Inventory |
| Fixed asset (Fixed Assets) | acquisition (manual JE or deferred helper), depreciation, disposal | asset register | cost / accumulated / expense / gain-loss |
| Adjustments (Accounting screens) | approved AR/AP/cash/inventory adjustment events | sub-ledger adjustment | per request kind |

**Does the navigation reflect this lifecycle? Only partly (VERIFIED).** Invoice detail, Payments, Supplier Invoices, Purchase Orders / Goods Receipt and Treasury Ledger contain **no reference to a journal or financial event** (searched); the only places showing the chain are Accounting → Financial Events (a global list), the reconciliations, Fixed Assets (journal link) and Payroll Run detail. A user cannot move from an invoice to its journal in one step (INFERRED from the absence of links).

---

## I. Navigation Findings

| ID | Severity | Current state | Expected state | Evidence | Impact | Recommendation |
|---|---|---|---|---|---|---|
| **NAV-01** | High | No setup/onboarding guidance; sidebar order is domain order; prerequisites invisible | A user can learn the order foundation → master data → operations → control | No onboarding/checklist/wizard in `frontend/src`; group order in the registry; Procurement lists PO before PR/RFQ | New users cannot self-start; failures surface as backend REJECTED events | Add a read-only "Setup & process guide" (checklist of prerequisites with status), and reorder Procurement items to follow the process |
| **NAV-02** | **Critical** | The mandatory GL policy-account keys — **corrected 2026-10-06 (NAV-02): 12 are consumed by posting, 5 are declared but unconsumed** (`accounting.inventory_opening_balance_account_code`, `…_adjustment_gain/loss…`, `…_manual_receipt_reason_accounts`, `…_cogs…`, `sales_returns…`, `purchase_price_variance…`, `fixed_asset_gain/loss/acquisition_clearing…`, AR/AP/cash opening & write-off, `cash_movement_clearing…`) are fail-closed prerequisites but have **no UI** | An authorised operator can see and set them (with validation against the chart) | `/config` backend API exists (`core.config.edit`); a source-wide search of the frontend finds no use of `/config/values` or `/config/keys`; Accounting Settings holds only currencies/tax | Postings are rejected until an engineer calls the raw API; the system cannot be configured by an accountant | Provide a configuration screen (at minimum the accounting policy keys) — needs a CTO decision; until then document the procedure |
| **NAV-03** | High | Two approval mechanisms; the central Approvals screen covers only the Approval Engine | One place where a user sees everything waiting for them | 29 Approval-Engine request types (+ RFQ award) vs Process-Engine transitions (PR, PO, warehouse transaction, sales-order stages, returns) inside their own screens; Approvals is last in Administration; Dashboard has no approvals widget | Approvals are easy to miss; two models confuse users | Add a pending-items indicator and surface Process-Engine approvals in (or linked from) Approvals; keep the engines separate |
| **NAV-04** | Medium | Segregation of duties differs by engine; payments have no approval | A documented policy per transaction | D7 spec: same user submits and approves a PR; 0 approval references in payment/treasury services | Control gap or intentional policy — unknown | CTO policy decision (not a UI change) |
| **NAV-05** | Medium | Core transactions have no menu entry and live inside other screens: Goods Receipt, Supplier Payment, Invoice creation, Customer Payment, On-account payment, Deposit, Treasury cash movements, New Item Request, Opening-stock import | Each key transaction discoverable from its module | Section A "no screen of their own" list; `Payments.tsx` only GETs and prints; recording happens in `CustomerAccount.tsx` | Users hunt for where to record a payment/receipt | Add entry points/links from the owning menu (no new backend), or cover-page shortcuts |
| **NAV-06** | Medium | Duplicated or overlapping surfaces | One canonical place per function | `/customers` registered twice; BOM at `/bom` (Catalog, admin role) **and** `/manufacturing/boms` (Manufacturing, node `manufacturing.bom`) both through `SalesBomContract`; four return screens (`/returns`, `/sales-returns`, `/shipment-returns`, `/custody-returns`) in two groups | Inconsistent permissions and duplicated learning | Decide the canonical BOM screen; group the return screens under one heading |
| **NAV-07** | Medium | Operational accounting consequences invisible on operational screens | Show "posted / pending / rejected" and a journal link | 0 journal/event references in `InvoiceDetail`, `Payments`, `SupplierInvoices`, `PurchaseOrders`, `TreasuryLedger`; only `PayrollRunDetail` shows event status | Cannot trace a document to its GL entry without leaving to Financial Events | Add event-status + journal link on documents (pattern exists in Payroll Run detail) |
| **NAV-08** | Medium | No unified report center; reports scattered | One reports entry with all categories | Reports cover lists only sales/operations tabs; financial statements under Accounting; aging under Customers/Procurement | Reports hard to find | Cover or Reports hub linking all report screens |
| **NAV-09** | Medium | Master data fragmented across 8 groups | A recognisable "where do I set up" | Customers (Sales), Suppliers (Procurement), Products/Price lists/BOM (Catalog), Warehouses, Employees, Chart of Accounts, Treasury Accounts | Acceptable for a domain-oriented design (INFERRED) but undiscoverable for beginners | Solved by NAV-01's guide rather than restructuring |
| **NAV-10** | Low–Medium | Functional screens not in the sidebar | Reachable consistently | Dimensions and Accounting Settings only from the Accounting cover; closing audit/exceptions/snapshots only from Fiscal Periods | Settings are easy to miss (ties to NAV-02) | Surface Settings/Dimensions in the Accounting group |
| **NAV-11** | Low–Medium | Mixed visibility model | One model | 47 node-gated, 16 role-gated, 12 ungated items (including Invoices, Payments, AR Aging); registry header calls it temporary | Nav can show screens the API later refuses (or the reverse) | Complete the guard swap per module (existing plan) |
| **NAV-12** | Low | Naming collision "Production/التجهيز" (fulfilment pick/pack) vs "Manufacturing/التصنيع" | Distinct names | registry key `nav_group.production` holds only Fulfilment; Manufacturing is a separate group | Mild confusion | Rename the Fulfilment group label |
| **NAV-13** | Low | Dashboard is sales/fulfilment only | Role-relevant KPIs (finance, procurement, approvals) | `Dashboard.tsx` loads 7 sales/fulfilment/shipping endpoints | Finance/procurement users land on irrelevant data (covers have their own KPIs) | Role-based dashboard widgets |
| **NAV-14** | Low | Raw terminology keys on Approvals for 6 request types | Titles | `approval_request_types` without terminology rows (attendance ×2, commission, payroll, targets, fiscal reclose); `action.award_rfq` fixed on 2026-10-06 | Cosmetic | Seed the six labels (owners of those modules) |

Critical blocker needing an immediate decision: **none requiring a stop** — but NAV-02 is the one finding that prevents a non-engineer from operating the accounting policy and is raised for the CTO.

---

## J. Final CTO Assessment

**Per-module classification**

| Module / group | Classification |
|---|---|
| Home / Dashboard | ADEQUATE WITH MINOR UX IMPROVEMENTS (NAV-13) |
| Sales | ADEQUATE WITH MINOR UX IMPROVEMENTS (NAV-06) |
| Warehouses / Inventory | ADEQUATE WITH MINOR UX IMPROVEMENTS |
| Fulfilment ("التجهيز") | ADEQUATE WITH MINOR UX IMPROVEMENTS (NAV-12) |
| Shipping / Returns | STRUCTURAL IMPROVEMENT REQUIRED (four overlapping return screens, NAV-06) |
| Customers & Accounts | STRUCTURAL IMPROVEMENT REQUIRED (invoice/payment hidden in Customer Account, NAV-05; ungated, NAV-11) |
| Treasury | ADEQUATE WITH MINOR UX IMPROVEMENTS (actions inside the ledger screen) |
| Catalog | ADEQUATE WITH MINOR UX IMPROVEMENTS (BOM duplicate) |
| Reports | STRUCTURAL IMPROVEMENT REQUIRED (NAV-08) |
| HR | ADEQUATE |
| Attendance | ADEQUATE |
| Payroll | ADEQUATE (best-practice event status shown) |
| Targets / Commission | ADEQUATE (commission→payroll link INFERRED) |
| Accounting | **CRITICAL GAP** (policy account configuration has no UI, NAV-02) — otherwise ADEQUATE WITH MINOR UX IMPROVEMENTS |
| Procurement | ADEQUATE WITH MINOR UX IMPROVEMENTS (menu order, GR / supplier payment entry points) |
| Manufacturing | ADEQUATE WITH MINOR UX IMPROVEMENTS (BOM duplicate) |
| Administration / Approvals | STRUCTURAL IMPROVEMENT REQUIRED (NAV-03) |
| Cross-cutting: first-time guidance | STRUCTURAL IMPROVEMENT REQUIRED (NAV-01) |

**Is the current navigation structure valid for adoption as the present ERP structure? — CONDITIONAL.**

*Why not NO:* the structure is complete and coherent by domain — every route exists, no orphaned menu entry, every process in section D can actually be executed end to end (verified repeatedly in this program's browser and real-PostgreSQL runs), accounting events are wired for all major transactions, and the permission/entitlement model is present.

*Why not YES:* (1) the mandatory accounting policy accounts cannot be configured from the application (NAV-02); (2) approvals are split across two mechanisms with no single place or indicator (NAV-03, NAV-04); (3) there is no setup-order guidance, and key transactions are buried inside other screens (NAV-01, NAV-05); (4) the accounting consequence of a document is not visible where the document lives (NAV-07).

*Conditions for adoption:* resolve NAV-02 (UI or an approved operator procedure), define the approval/segregation policy (NAV-03/04), and accept a setup guide (NAV-01) — none requires restructuring the sidebar. The remaining findings are UX optimisation and may follow the Navigation/Workflow Optimization decision.

*Limits of this audit:* UNVERIFIED — per-role sidebar contents, the behaviour of screens not exercised, visual/RTL quality, and the commission→payroll relationship (INFERRED only).
