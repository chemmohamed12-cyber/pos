# Daii — Excel Business Mapping Package

**Status: ANALYSIS ONLY. No code, migration, or UI was touched to produce this
document** (per CTO instruction — another session is the active
implementer; this document is meant to be consumed by that session, not
executed by this one).

**Contains real company data** (customer names/phones, employee names,
salary figures, supplier balances, cash positions). Treat as internal —
do not publish externally.

Source: 12 `.xlsx` files at `Daii/احمد/احمد/`, provided by the CTO as
the company's actual live operating spreadsheets. A 13th file in that
folder, `XNEXUS_Pricing_Strategy.xlsx`, is **excluded** from this
analysis — it is a Daii-side pricing-feature planning artifact created
by the other active session, not a legacy company record.

---

## 0. Company & Business Model — the single most important finding

Every ledger file is headed **"الشركة الغربية لتجميع وتصنيع مستلزمات
الاضاءة"** / **"الشركه الغربيه لتجميع وتصنيع لمبات الليد"** — *Al-Gharbia
Company for Assembly & Manufacturing of Lighting Supplies / LED Lamps*.
Customers sampled are cafés/restaurants in Tanta/Gharbia (`Aylin
Restaurant & cafe`, `Hi Risk café`, `cove café`…) — this is a
**manufacturer-distributor**, not a pure reseller:

- `مخزن مفككات.xlsx` ("Knocked-down/component parts warehouse") holds
  **raw components** — item codes like `BTN-WL-CT02`, `RCVD-WL-CR23`.
- `مخزن منتج تام.xlsx` ("Finished goods warehouse") holds **assembled
  products** whose names literally spell out their bill of materials:
  `Eco indoor (cR23+15ct02)`, `Lite (cR23A+15ct08)` — a finished lamp
  named after the component codes it's built from.
- The component warehouse's own operation-type reference sheet
  (`مخزن مفككات.xlsx` → `دليل`) lists exactly four movement reasons:
  **اول المده** (opening balance), **مبيعات** (sale — components sold
  directly), **مرتجعات** (returns), **تجميع صاله الانتاج** ("assembly —
  production floor"). That last one is the real event: components leave
  the component warehouse, finished goods appear in the finished-goods
  warehouse. **This is a live BOM/assembly process, tracked manually
  today by keeping two mirrored warehouse workbooks in sync by hand.**
- A cost-center dimension exists on the same sheet: **التجاره والتوزيع**
  (Trade & Distribution), **المصنع** (Factory), **مركز الصيانه**
  (Maintenance Center), **عميل خارجى** (External Customer/toll
  processing). Stock movements are attributed to one of these four —
  Daii's `StockMovement` entity has no equivalent field today.
- `المصروفات.xlsx`'s own expense chart of accounts confirms the same
  four cost centers, and `مبيعات.xlsx`'s main ledger has a line item
  **ايرادات التصنيع** ("manufacturing revenue") separate from
  **مبيعات** ("sales") — i.e., they may also do paid assembly/toll work
  for external parties, not only sell their own finished products.

**Daii's current domain model (Commerce/Inventory as built) has no
concept of Bill of Materials, component consumption, or an assembly
event — it only has flat Product + single-warehouse-ledger movements.**
This is the largest genuine gap between Daii and the real business, and
it sits in the Inventory/Commerce domain, not Finance — see §21, P1.

---

## 1. Excel Inventory

| # | File | Real subject | Sheets | Rows (largest) |
|---|---|---|---|---|
| 1 | `مبيعات.xlsx` | Sales / invoices / customer AR ledger | 9 (incl. 2 pivot-only) | `بيانات الفواتير` 14,634 |
| 2 | `شيت تحليل العملاء الرئيسي الجديد.xlsx` | Customer CRM/analysis master | 1 | 6,069 |
| 3 | `مخزن مفككات.xlsx` | Component/raw-material warehouse ledger | 13 | `الحركه` 18,862 |
| 4 | `مخزن منتج تام.xlsx` | Finished-goods warehouse ledger | 13 (identical structure to #3) | `الحركه` 18,862 |
| 5 | `شيت  المورديين.xlsx` | Supplier accounts ledger | 3 | `الحركه` 17,805 |
| 6 | `شيت  سلف.xlsx` | Employee cash-advance ledger | 3 | `الحركه` 18,346 |
| 7 | `العهد.xlsx` | Employee custody/float ledger | 3 | `الحركه` 17,971 |
| 8 | `المصروفات.xlsx` | Expense ledger + cost-center reports | 7 | `الحركه` 19,120 |
| 9 | `الاستثمارات.xlsx` | Investor capital + monthly returns | 1 | 34 |
| 10 | `الاصول الثابته.xlsx` | Fixed-asset register + depreciation | 1 | 111 |
| 11 | `خزينه شهر.xlsx` | Daily cash/bank/USD treasury log | 1 (+2 empty) | 163 |
| 12 | `برنامج شئون العامليين.xlsx` | HR/payroll/attendance/deductions | 7 | `شيت مؤثرات بصمه` 2,922 |

Files #1–4 are directly relevant to Daii's approved V1 scope (Sales,
CRM, Inventory/Warehouse). Files #5–12 are Finance/HR ledgers —
out of V1 scope per the CTO's own standing instruction (§11: "Do not
implement accounting/financial modules beyond the currently approved V1
scope"). They are analyzed below only to the extent they reveal fields
V1 domains must be able to carry so a *future* Finance/HR module can
consume the resulting events without re-touching Orders, Customers,
Inventory, or Identity.

---

## 2. Sheet Purpose Map (per file)

### `مبيعات.xlsx` (Sales)
| Sheet | Purpose | Created/updated by |
|---|---|---|
| `الحركه` | Master sales transaction ledger — every invoice line, return, cash collection, and adjustment against a customer, one row per movement | Sales/accounts clerk, per transaction |
| `بيانات الفواتير` | Invoice line detail — per product per invoice: qty, list price, actual price, discount, net | Sales clerk at time of invoicing |
| `ارصده العملاء` | Monthly customer balance rollup — opening balance, debit/credit, closing balance, checks-on-hand, per month per customer, grouped by sales rep/region | Finance, monthly close |
| `ارصده عملاء الجديد` | A cleaner rebuild of the same rollup — evidence of an in-progress migration to a better report, not a separate business process | Finance |
| `بيانات` | Product master (code, name, brand, units-per-carton) | Whoever maintains the price/product list |
| `كشف حساب عميل` | Single-customer statement-of-account template (fill in customer code, get date-ranged debit/credit/balance) — a print/lookup tool, not stored data | Finance/sales rep, on customer request |
| `حركه يوليو/اغسطس/سبتمبر` | Empty pivot-table shells for monthly totals — reporting scaffolding | Auto (Excel PivotTable), not manually entered |

### `شيت تحليل العملاء الرئيسي الجديد.xlsx` (Customer Analysis)
One sheet, `بيانات العملاء`: the CRM master — richer than the AR ledger
above. Owned/maintained by sales management, likely updated during
sales-rep visit reporting or CRM review meetings, not per-transaction.

### `مخزن مفككات.xlsx` / `مخزن منتج تام.xlsx` (Component / Finished-Goods Warehouses)
Identical structure (same template reused for both warehouses):
| Sheet | Purpose |
|---|---|
| `دليل` | Reference lists: operation types, cost centers, movement direction (وارد=in / منصرف=out) |
| `ارصده الاصناف` | Item master (code + name) — this IS the product/component catalog |
| `اول المده` | Opening balance per item, snapshotted monthly |
| `حركه [شهر]` | One sheet per month, pivot of that month's in/out per item |
| `الحركه` | The real ledger — every receipt/consumption/assembly/sale/return row, with running average cost |
| `تقرير ارصده الاصناف` | Multi-month balance trend report per item (a rolling snapshot report, several dated columns) |
| `تقرير مجمع اداره` / `تقرير الاداره` | Management summary — component codes grouped by finished-product family (وش/ضهر/المونيا = "front/back/base" — actual physical lamp sub-assembly parts) |

### `شيت  المورديين.xlsx` (Suppliers)
`الدليل` (supplier master + running balance) → `الحركه` (per-transaction
debit/credit ledger) → `كشف حساب` (statement-of-account print template).
Same three-sheet pattern reused across every ledger file in this
package — this is a **single, consistent internal accounting template**
the company applies to Suppliers, Employee Advances, Custody, and
Expenses alike.

### `شيت  سلف.xlsx` (Employee Advances) / `العهد.xlsx` (Employee Custody/Float)
Same three-sheet pattern (`الدليل`/`الحركه`/statement), keyed by
employee instead of supplier/customer. `شيت سلف`'s `Sheet1` is a
pre-built pivot: outstanding advance balance per employee (a
maintenance-center-specific "settled advances" report).

### `المصروفات.xlsx` (Expenses)
`الدليل` (chart-of-expense-accounts with a **cost center column**) →
`الحركه` (per-expense ledger) → `تحليلى مركز التكلفة` / `تقرير الادارة` /
`التقارير` (multiple cost-center-by-month pivot reports) → `الزيت` ("Oil"
— a one-off fuel/vehicle-expense allocation sheet by department:
تسويق/marketing, مناديب/sales reps, الشركه/company, الايجار/rent).

### `الاستثمارات.xlsx` (Investments) / `الاصول الثابته.xlsx` (Fixed Assets)
Single-sheet registers: investor name, capital contributed, monthly
return owed vs. paid (Investments); asset name, location, cost,
additions/disposals, accumulated depreciation, net book value (Fixed
Assets). Finance/ownership-level records, updated monthly/as-needed.

### `خزينه شهر.xlsx` (Monthly Treasury)
One real sheet (`1`): a daily cash-book — date, beneficiary/payer name,
description, receipt voucher # + cash/bank/USD amount, payment voucher
# + cash/bank/USD amount. This is where **`تحصيل نقدى` (cash
collections)** seen in the Sales ledger actually gets physically
recorded and reconciled.

### `برنامج شئون العامليين.xlsx` (HR/Payroll)
A small in-house HR system: `قاعده البيانات` (employee master — code,
department, job, ID#, insurance #, start date, base salary, hourly/daily
rate, shift), `استقطاعات موظفين` (deductions — absence, lateness,
permission-hours, advance-repayment), `استحقاقات موظفين` (entitlements —
incentive days, transport allowance, bonus, overtime), `سلف موظفين`
(advance balance, cross-referencing the standalone advances workbook),
`شيت مؤثرات بصمه` (raw fingerprint-clock import: clock in/out, late,
early, absent, OT), `مرتبات موظفين` (final payroll computation — pulls
from all the above into gross/net salary).

---

## 3. Business Workflow Map — Excel operation → Daii equivalent

### 3A. Sales / Order-to-Cash (the workflow most relevant to Daii V1)

```
Sales Rep visits customer (or customer calls in)
        ↓
Invoice written up (بيانات الفواتير row created)
  - product, qty, list price (قائمه الاسعار), actual price, discount
  - "انحراف السعر" (price deviation) tracked as its own column —
    reps CAN sell off-list, and the deviation is recorded, not blocked
        ↓
Invoice posted to customer's running account (الحركه row: مدين/دائن)
        ↓
Goods leave the finished-goods warehouse (مخزن منتج تام "منصرف")
        ↓
[No formal shipment/waybill/driver record found anywhere in the files]
        ↓
Customer pays over time against their open balance
  ("رصيد مفتوح [شهر]" tracked monthly, not "paid before shipped")
        ↓
Cash physically recorded in خزينه شهر (تحصيل نقدى) and reconciled
  back into the customer ledger
        ↓
(Occasionally) مرتجعات — a return posted as a reversing ledger entry,
  no separate authorize→receive→inspect→disposition workflow evident
```

**This is a running-account (open-terms trade credit) wholesale model,
not a per-order gated workflow.** Zero occurrences of any Arabic term
for "approval," "review," "supervisor," or "manager sign-off" appear
anywhere across all 12 files (checked directly). There is also no
"عربون" (deposit) concept anywhere in the sales data — customers are
invoiced and carry a balance; nothing in the evidence shows a
deposit-before-reservation gate.

**→ See §21 Gap G-1: this directly contradicts Daii's already-built V1
Sales Order workflow** (submit → supervisor_review → manager_approval →
**deposit_verification (mandatory)** → released), which has no
precedent in the actual business practice as evidenced by these files.
Flagged as the single highest-priority item for CTO review — not
silently reconciled either direction.

### 3B. Warehouse — Assembly (the second major real workflow)

```
Component received into مخزن مفككات (وارد / receipt)
        ↓
Components consumed via "تجميع صاله الانتاج" (assembly/production
  floor) movement — components OUT of مخزن مفككات
        ↓
Finished product appears in مخزن منتج تام (اول المده / وارد entry,
  same period) — no visible formal "production order" document, just
  two ledger entries a human keeps in sync by hand
        ↓
Finished product sold (منصرف) against a sales invoice
```

**→ Daii has no BOM/assembly concept at all today** (§21 Gap G-2, P1).

### 3C. Purchasing / Suppliers
`شيت المورديين`: supplier balance ledger only — no PO/goods-receipt
workflow evidenced (goods just appear as a component-warehouse receipt,
paid against the supplier's running account). Out of V1 scope; Daii has
no Purchasing domain and this evidence doesn't argue for building one
now — component receipts already map to Daii's existing `receipt`
movement type.

### 3D. Employee Advances / Custody / Payroll
Independent HR/Finance sub-processes, fully out of V1 scope. No
interaction with Sales, Customers, or Inventory domains — safe to leave
entirely for a future Finance/HR phase.

---

## 4. Data Field Mapping — Excel → Daii

Only fields relevant to Daii's approved V1 domains (Commerce, CRM,
Sales Orders, Inventory/Warehouse, Deposit Control, Fulfillment,
Shipment, Delivery, Returns). Finance/HR-only fields are omitted here
and covered by §11's "preserve for future Finance" note instead.

| Excel field (sheet) | Meaning | Daii domain | Daii entity | Current Daii field? | UI screen |
|---|---|---|---|---|---|
| `الكود_المحاسبي` (customer ledgers) | Customer accounting code | CRM | `Customer` | Partial — Daii auto-generates `CUST-######` via Numbering; Excel codes are pre-existing numeric codes with no visible structure | Customers |
| `اسم العميل` | Customer name | CRM | `Customer.name` | ✅ exists | Customers |
| `اسم المدير` (تحليل العملاء) | Owner/manager contact name | CRM | — | ❌ missing | Customers |
| `رقم التليفون للتواصل` / `رقم التليفون الواتس` | Phone / WhatsApp | CRM | `Customer.phone` | Partial — only one phone field exists, no WhatsApp-specific field | Customers |
| `تصنيف العملاء` (A/B/C) | Customer classification | CRM | `Customer.classification` | ✅ **already exists, matches exactly** | Customers |
| `اسم المندوب` | Assigned sales rep | CRM/Sales | `CustomerSalesRepAssignment` | ✅ exists (assignment table) | Customers → Assign Sales Rep |
| `المنطقه` / `المحافظه` | Region / Governorate | CRM | — | ❌ missing (only free-text `address` implied, no structured region field) | Customers |
| `طريقه التواصل` | Preferred contact method | CRM | — | ❌ missing | Customers |
| `مدى استجابه العميل` / `مدى رضا العميل` | Responsiveness / satisfaction rating | CRM | — | ❌ missing — future CRM enrichment, not a workflow blocker | Customers (future) |
| `البراند اكثر/متوسط/اقل طلبا` | Brand demand preference | CRM/Commerce | — | ❌ missing — needs a `Brand`/product-family concept Daii's flat `Product` doesn't have | Customers, Products (future) |
| `طريقه الشحن` | Preferred shipping method | CRM/Shipment | — | ❌ missing as a customer preference (Shipment itself exists as a domain) | Customers |
| `اللوكيشن` | Map link/location | CRM | — | ❌ missing | Customers (future) |
| `كود الصنف` | Product code | Commerce | `Product.sku` | ✅ exists, but Excel codes are short numeric (`200001`) vs Daii's free-text SKU | Products |
| `اسم الصنف` | Product name | Commerce | `Product.name` | ✅ exists | Products |
| `قائمه الاسعار` | Price list | Commerce | — | ❌ **missing** — Daii's `Product` has one flat `unitPrice`, no concept of multiple price lists (matches what the peer session's `XNEXUS_Pricing_Strategy.xlsx` is independently working on) | Products / Price Lists (in progress, other session) |
| `انحراف السعر` | Price deviation from list | Sales Orders | — | ❌ missing — Sales Order lines store only the snapshot price, no variance tracking against list | Sales Order create/detail |
| `قيمه الخصم` | Line/invoice discount | Sales Orders | — | ❌ missing — `SalesOrderLine` has no discount field at all today | Sales Order create/detail |
| `الكميه المعياريه` | Standard/case quantity | Commerce | — | ❌ missing (`units-per-carton` in `بيانات` sheet too) | Products |
| `رقم الفاتوره` / `رقم الفاتوره التجميعى` | Invoice # / consolidated invoice # | Sales Orders | `SalesOrder.orderNumber` | ✅ Numbering Engine already issues `SO-YYYY-######`; "consolidated invoice" (multiple orders rolled into one printed invoice) has no Daii equivalent | Sales Orders (consolidated print — future) |
| `تصنيف البيع` | Sale classification (cash/credit/channel) | Sales Orders | — | ❌ missing | Sales Order create (future) |
| `تحصيل نقدى` (Sales ledger) | Cash collection against an invoice | Delivery/Collection | `Collection` | ✅ **exists** — Daii's `recordCollection` already captures this exact event | Shipments (delivery outcome) |
| `مرتجعات` / `مرتجع نقدى` | Returns / cash-refund on return | Returns | `ReturnRequest` | ✅ exists structurally, but Excel's return is a same-day reversing ledger entry with no authorize→receive→inspect chain — Daii's richer workflow is a deliberate, justified improvement here (§21, not a gap to fix, a documented enhancement) | Returns |
| `كود الصنف` + `م.تكلفه` (warehouse دليل) | Item + cost center on a movement | Inventory | `StockMovement` | Partial — item code exists, **cost center does not** | Inventory (future) |
| `نوع العمليه` = `تجميع صاله الانتاج` | Assembly/production consumption | Inventory | — | ❌ **missing entirely** — no BOM, no assembly movement type (§21 G-2) | Inventory (future — new capability) |
| `وارد` / `منصرف` | Receipt / Issue | Inventory | `StockMovement.movementType` | ✅ exists (`receipt`/`dispatch`) | Inventory |
| `اول المده` | Opening balance | Inventory | — | Partial — Daii's ledger model can represent this as an initial `adjustment` movement; no dedicated "opening balance" concept, which is fine (ledger-sum design already used, ADR-007) | — |
| `متوسط سعر` | Running average unit cost | Inventory | — | ❌ missing — Daii tracks quantity, not cost, per movement | Inventory (future, Finance-adjacent) |
| `رصيد شيكات` | Post-dated checks on hand | CRM/Finance | — | ❌ out of V1 scope (Finance) |  |

---

## 5. Role / User Mapping

| Excel evidence | Real-world role | Daii role (existing) |
|---|---|---|
| `اسم المندوب` on every customer/sale row | Sales representative, owns a customer book | `sales_rep` ✅ |
| `الاداره الماليه` header on every statement template | Finance/accounts department — posts ledger entries, reconciles cash | No direct Daii equivalent (Finance is out of V1 scope by design) |
| Nobody signs off on a sale in the data | — | Daii's `sales_supervisor` / `sales_manager` roles have **no evidenced real-world counterpart** in this data (see Gap G-1) |
| `كود الموظف` + department on every HR/payroll/advance sheet | Any employee, department-scoped | Out of V1 scope (HR) |
| No warehouse-worker-specific role visible (movements aren't attributed to a person, only a cost center) | Whoever runs the warehouse | `warehouse_worker` ✅ (Daii's attribution to an individual worker is an improvement over the Excel process, not a contradiction) |
| No driver/delivery-person field anywhere | — | `driver` role exists in Daii with **no Excel precedent at all** (ties to Gap G-1 — the whole Shipment/waybill/driver domain is a Daii-only addition, not extracted from current practice) |

---

## 6. Status & Approval Mapping

**Excel has no status field and no approval field on any sales
transaction.** A sale is a single, immediate ledger posting — there is
no draft/pending/approved state machine anywhere in the 12 files. The
closest thing to a "status" concept in the entire package is
`العهد.xlsx`'s custody ledger and `شيت سلف.xlsx`'s advance ledger, both
of which just track a running balance (owed vs. settled), not a
workflow state.

This is the clearest possible evidence for Gap G-1 (§21): Daii's
multi-stage Sales Order approval chain and mandatory deposit gate are
**not extracted from an existing practice** — they were designed from
the blueprint, independent of how the business actually currently
operates.

---

## 7. Report / KPI Mapping

| Excel report | What management actually monitors | Daii equivalent today | Target Daii report |
|---|---|---|---|
| `ارصده العملاء` (monthly, per customer, per sales rep, per region) | Customer AR aging, by rep, by region, month over month | None | Customer Balance / AR Aging report (future, Finance-adjacent but the *data* — order totals, collections — is already in Daii's domains) |
| `تقرير الادارة` / `التقارير` (المصروفات) | Expense by cost center by month | None (Finance out of scope) | Out of V1 |
| `تقرير ارصده الاصناف` (both warehouses) | Item balance trend, month over month | None | Inventory Balance History report (future) |
| `تحليلى مركز التكلفة` | Cost-center rollup | None | Out of V1 (Finance) |
| Sales ledger's monthly pivots (`حركه يوليو/اغسطس/...`) | Total debit/credit per month, drilling by customer | None | Sales Summary Dashboard (future) — the underlying `SalesOrder`/`Deposit`/`Collection` data already exists in Daii; only the aggregation view is missing |
| `تقرير بسلف العاملين بمركز الصيانة` | Outstanding employee advances by person | Out of V1 (HR) | — |

**Pattern**: every real report in this package is a **rollup of ledger
data the domain already produces** (sales, collections, stock
movements) — none require new source-of-truth data Daii doesn't
already capture in its V1 domains, except the AR-aging/customer-balance
view, which needs Finance-adjacent aggregation Daii deliberately defers.

---

## 8. Codes & Numbering Practices

- Customer/supplier/employee/expense-account codes are all short
  **numeric** codes (`200001`, `1210372`, `12210129`) with no visible
  structured prefix pattern — inconsistent length even within one
  column (6-digit vs 8-digit customer codes in the same sheet).
  **Daii's Numbering Engine already produces a cleaner, structured,
  consistent code** (`CUST-000001`, `SO-2026-000001`) — this is a
  deliberate, justified improvement, not a gap to match backward.
- Product codes in the two warehouse files are consistently 6-digit
  numeric (`200001`…), while the *raw component* SKUs referenced inside
  finished-product names use an alphanumeric scheme (`BTN-WL-CT02`,
  `RCVD-WL-CR23`) — two different coding conventions coexisting for
  the same conceptual "item," which the eventual BOM feature (Gap G-2)
  will need to reconcile, not the numbering scheme itself.
- Invoice numbers (`رقم الفاتوره`) and a separate "consolidated invoice
  number" (`رقم الفاتوره التجميعى`) coexist — evidence multiple
  invoices are sometimes rolled into one printed/settled document. No
  Daii equivalent; flagged as P2 (§21).

---

## 9. Existing Business Terminology (for the Terminology Registry)

Real, in-use Arabic business terms found in the files, for comparison
against Daii's Terminology Registry — use these over generic ERP
translations wherever a Daii screen covers the same concept:

| Concept | Company's real term | Daii's current term |
|---|---|---|
| Sales rep | المندوب | مندوب المبيعات (already close/consistent) |
| Customer classification | تصنيف العملاء | نفس المصطلح (already consistent) |
| Warehouse | مخزن | نفس المصطلح |
| Receipt (stock in) | وارد | Daii's terminology migration already uses this exact term for `receipt` — consistent |
| Issue (stock out) | منصرف | Daii uses `dispatch`'s Arabic gloss — confirm it matches `منصرف`, not a literal translation |
| Return | مرتجع / مرتجعات | Daii's Returns domain — confirm registry uses `مرتجع`, not `إرجاع` (a more literal/less natural term) |
| Cash collection | تحصيل نقدى | Daii's Collection — confirm registry says `تحصيل`, not `جمع` |
| Opening balance | اول المده | No current Daii equivalent needed (ledger-sum model) |
| Cost center | مركز التكلفة | Not in Daii yet |
| Statement of account | كشف حساب | Not in Daii yet (future Finance/CRM report) |

**No conflicting terminology was found** between the Excel evidence and
Daii's existing registry for the terms both sides already use — the gap
is entirely in missing terms for concepts Daii hasn't built yet, not in
disagreement over concepts both have.

---

## 10. Manual Calculations That Should Become System Logic

| Excel manual calc | Where | Should become |
|---|---|---|
| Running customer balance (`رصيد مفتوح [شهر]` = prior balance + debit − credit) | `ارصده العملاء`, updated by hand monthly | Already exists conceptually via Sales Order totals + Deposit + Collection records — needs only an aggregation query, not new source data |
| Price deviation (`انحراف السعر` = actual price − list price) | `بيانات الفواتير`, implicitly manual | Requires a Price List feature to exist first (other session's in-progress work) |
| Average unit cost (`متوسط سعر`) on warehouse ledgers | Both warehouse `الحركه` sheets | Requires a cost field on `StockMovement` — currently absent, Finance-adjacent |
| Payroll net calculation (entitlements − deductions) | `مرتبات موظفين` | Out of V1 (HR) |
| Depreciation (`اهلاك`, `مجمع الإهلاك`) | `الاصول الثابته.xlsx` | Out of V1 (Finance) |

---

## 11. Repeated / Duplicated Data — correct future source of truth

- **Customer name, phone, sales rep** appear independently in
  `مبيعات.xlsx` (`ارصده العملاء`), `شيت تحليل العملاء الرئيسي الجديد.xlsx`,
  and implicitly on every invoice row — three places a human keeps in
  sync by hand today. **Daii's `Customer` entity is already the single
  source of truth for this** — no change needed, just confirmation this
  consolidation is a deliberate, correct improvement.
- **Product code + name** appear independently in `بيانات` (Sales file),
  and in both warehouse files' `ارصده الاصناف` — three copies of what
  should be one catalog. **Daii's `Product` entity already fixes this.**
- **Component warehouse and finished-goods warehouse are kept in sync
  by a human performing the "تجميع صاله الانتاج" mental translation** —
  this is the one duplication Daii does **not** yet fix (Gap G-2).

---

## 12. Excel → Daii Gap Analysis

| # | Excel capability | Current Daii capability | Gap | Required change | Priority | Target |
|---|---|---|---|---|---|---|
| G-1 | Immediate invoice-and-running-balance sale, no approval chain, no deposit gate | ~~Multi-stage approval (submit→supervisor→manager) + **mandatory** deposit-before-release on every order~~ **RESOLVED** — see below | **RESOLVED.** CTO handover directive §6 answered this directly (no further escalation needed): the gate must stay available, but per-customer/configurable, never hardcoded platform-wide. Implemented as `Customer.orderWorkflowPolicy` (`standard` = existing chain unchanged; `open_account` = submit→released, matching this document's own evidence of the real business's open-account practice), snapshotted onto `SalesOrder.workflowPolicy` at creation so a later policy change never alters an in-flight order. Selects between two Process Definitions (`process-definition.ts`): `SALES_ORDER_APPROVAL_PROCESS` (unchanged) and the new `SALES_ORDER_OPEN_ACCOUNT_PROCESS`. Role-gated to admin/sales_manager (`POST /customers/:id/workflow-policy`). Verified live against a running PostgreSQL instance. | ~~Escalate~~ **Done** | Sales Orders domain, CRM |
| G-2 | Component warehouse → assembly → finished-goods warehouse (BOM) | ~~Flat `Product`, single-warehouse ledger movements, no BOM concept~~ **RESOLVED** | **RESOLVED.** Commerce owns the recipe (`BillOfMaterial` + `BomComponent`, one BOM per finished product, replace-on-redefine, admin-gated writes, broad reads). Inventory/Warehouse owns the physical event: `InventoryService.assembleProduct` resolves the recipe via the cross-domain `BomService.getBomForAssembly` read, checks EVERY component's availability first, then writes all movements (`assembly_consumption` on each component, `assembly_output` on the finished good) in one transaction under sorted per-product advisory locks (same pattern as `reserveStock`) — full atomicity: a shortfall on any one component blocks the whole run and leaves every component's stock untouched, verified live. A Numbering-issued `ASM-YYYY-######` reference ties every movement of one run together. A real bug was found and fixed via this same live verification: `stock_movements.movementType` was `VARCHAR(16)`, too narrow for `'assembly_consumption'` (21 chars) — widened to `VARCHAR(32)` (`WidenStockMovementType` migration). Deliberately NOT implemented (over-engineering guard, CTO handover directive §15/§20): cost-center attribution on `StockMovement`, multi-level/nested BOM resolution, BOM versioning/effective-dating, alternate/optional components — flat V1 only, not a full MRP/manufacturing ERP. | ~~P1~~ **Done** | Inventory/Warehouse, Commerce |
| G-3 | Multiple price lists, price deviation tracking | ~~Single flat `Product.unitPrice`~~ **RESOLVED** | **RESOLVED.** New Commerce entities `PriceList` (header, Numbering-issued `PL-######` code, `active`/`inactive`) and `PriceListItem` (per-product override price, unique per list). `Customer.priceListId` (nullable — null = no override, unchanged pricing) assigns a list per customer, admin/sales_manager-gated (`POST /customers/:id/price-list`). `SalesOrdersService.createOrder` resolves the EFFECTIVE price per line at order time: the customer's assigned list's override if one exists and the list is active, else the product's own base price — never re-resolved after creation. `SalesOrderLine.listPrice` (base) + `unitPrice` (effective, existing field) give price variance as a plain subtraction (`field.price_variance` in `SalesOrdersDetail.tsx`), no stored variance column. Excel import/export for price list items reuses the existing Excel capability. Printing reuses `PrintDocument`/`BusinessDocument` unchanged (`PriceListPrint.tsx`). Note: `document.price_list_title` — previously misapplied to the plain product-catalog print — was freed and correctly repointed to this feature; the catalog print now uses its own `document.product_catalog_title`. Verified live against a running PostgreSQL instance, including discount(G-4)+price-list composition and deactivation fallback. | ~~P1~~ **Done** | Commerce, CRM, Sales Orders |
| G-4 | Per-line/invoice discount | ~~No discount field on `SalesOrderLine`~~ **RESOLVED** | **RESOLVED.** `SalesOrderLine.discountAmount` (flat amount, matching the Excel evidence's `قيمه الخصم` form) — server-validated per line (never negative, never more than that line's own gross total) in `SalesOrdersService.createOrder`, flows into both `lineTotal` and `SalesOrder.totalAmount`. Wired through `SalesOrdersCreate.tsx`, `SalesOrdersDetail.tsx`, and the create/detail API contract. Verified live. Note: this is the discount half of G-3/G-4 only — list-price vs. actual-price *variance tracking* (`انحراف السعر`) still needs G-3's Price List entity first. | ~~P1~~ **Done** | Sales Orders |
| G-5 | Customer manager/owner name, WhatsApp, region/governorate, contact-method preference, responsiveness/satisfaction rating, brand preference, location link | ~~`Customer` has name/phone/classification only~~ **RESOLVED** | **RESOLVED (per CTO explicit instruction — the real sheet IS the import/export format now, not an approximation of it).** `Customer` gained all 12 fields (`managerName`, `address`, `governorate`, `whatsappPhone`, `contactMethod`, `responsivenessLevel`, `disinterestNotes`, `priceSatisfactionLevel`, `topBrand`/`midBrand`/`lowBrand`, `shippingMethodPreference`, `locationUrl`), all nullable. `customers.controller.ts`'s import/export `ColumnSpec` headers are the exact Arabic column headers from row 2 of `شيت تحليل العملاء الرئيسي الجديد.xlsx`'s `بيانات العملاء` sheet (`كود` itself excluded — Numbering Engine issues it, same precedent as every other import). Sales rep is matched by NAME (`UsersService.findByFullName`, ambiguous/unmatched = whole row rejected, never silently unassigned) since the real sheet has no email column — a deliberate departure from the previous email-based `salesRepEmail` column. Verified live with real Arabic UTF-8 data end-to-end (create + template download). Frontend: `Customers.tsx` shows `governorate` inline and the rest in an expandable detail row (`action.view_details`) to keep the main table usable. | ~~P2~~ **Done** | CRM |
| G-6 | Structured region/governorate on customer | Free-text address only | Reports can't group by region like `ارصده العملاء` does | Add structured `region`/`governorate` fields | **P2** | CRM |
| G-7 | Customer AR aging / monthly balance report | No such report | Management loses monthly visibility they currently get from Excel | AR/Balance dashboard, aggregating existing Sales Order + Deposit + Collection data | **P2** | Reports/Dashboard |
| G-8 | Consolidated/batch invoice number | Only one order → one order number | Cannot represent "several orders settled under one printed invoice" | Evaluate need with CTO — may be a Finance-phase concern, not Sales Orders | **P3** | Future/Not V1 |
| G-9 | Post-dated checks tracked per customer | Not modeled | Out of scope | None for V1 | **Future / Not V1** | Finance |
| G-10 | Average/running unit cost per item | Not modeled (Daii tracks qty only) | Out of scope until Finance | None for V1 | **Future / Not V1** | Finance |
| G-11 | Full Finance ledgers (Investments, Fixed Assets, Custody, Expenses, Suppliers, Payroll) | Not modeled — by design | None — confirmed correctly out of scope | Preserve event/data hooks already present (Deposit, Collection, Sales Order totals) so a future Finance module can consume them | **Future / Not V1** | Finance/HR (Phase 2, per existing ADR) |

---

## 13. Distinguishing the Four Buckets (per the CTO's explicit requirement)

**EXISTING DAII** (already correctly matches or improves on Excel):
Customer classification (A/B/C), Product catalog consolidation,
Customer/Product single-source-of-truth, structured numbering (vs.
Excel's inconsistent numeric codes), Returns workflow (richer than
Excel's single reversing entry — a deliberate, justified improvement),
Collection recording (`تحصيل نقدى` already modeled).

**EXCEL CURRENT PRACTICE, not yet in Daii** (G-2 through G-10 above):
BOM/assembly, price lists + deviation tracking, line-level discounts,
richer CRM fields, structured region, AR-aging report, consolidated
invoices.

**GAP requiring a CTO-level decision, not a normal build item** (G-1):
the entire approval-chain + mandatory-deposit gate has no basis in
current practice — confirm intent before more workflow screens are
built assuming every order needs 2 approvals + a deposit.

**FUTURE / NOT V1** (confirmed correctly deferred): all Finance ledgers
(Investments, Fixed Assets, Custody, Expenses, Suppliers, Payroll/HR),
average costing, post-dated checks, consolidated invoicing.

---

## 14. What This Document Does Not Do

Per the CTO's explicit scope for this task: no code was written, no
migration created, no UI screen built, no Excel-import feature added,
and Stage 0/1/1.1 architecture was not reopened. This is a
read-only analysis for the active implementation session (and the CTO)
to consume. The one item that genuinely needs a CTO decision before
implementation continues is **G-1** — everything else (G-2 through
G-10) is normal, additive V1/near-V1 backlog the implementing session
can pick up by priority without further architecture debate.
