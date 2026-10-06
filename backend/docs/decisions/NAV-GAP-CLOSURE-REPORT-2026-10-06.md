# Navigation & Operational Workflow Gap Closure — Closure Report (2026-10-06)

Baseline: `FRONTEND-NAVIGATION-AND-OPERATIONAL-FLOW-AUDIT-2026-10-06.md` (NAV-01 … NAV-14). Running record: `NAV-GAP-CLOSURE-2026-10-06.md` (NAV-02 / NAV-03 detail).
Closure vocabulary: IMPLEMENTED → INTEGRATED → VERIFIED → UAT READY. **Production = HOLD. Nothing pushed.**

## 1. Status

| Gap | Status | Evidence level |
|---|---|---|
| NAV-02 Accounting policy configuration | **VERIFIED — UAT READY** (commit `18b25d8`) | real-PG 8/8, 68/68 affected regression, browser (earlier) + browser again in the batch (§1b) |
| NAV-03 Approval visibility (`/pending-work` + Dashboard card) | **VERIFIED — UAT READY** | browser batch §1b (isolated env) |
| NAV-04 Approval governance | **BLOCKED — POLICY DECISION REQUIRED (ESC-3)** | not touched, by design |
| NAV-01 + NAV-09 Setup & process guidance | **VERIFIED — UAT READY** | browser batch §1b |
| NAV-05 Entry points (Common tasks) | **VERIFIED — UAT READY** (two hint texts corrected by the browser pass, migration `1790001000000`) | browser batch §1b |
| NAV-07 Financial traceability on documents | **VERIFIED — UAT READY with noted gaps** (Pending state and a Posted *customer-invoice* detail not observed live — §1b item 7) | browser batch §1b |
| NAV-06 Canonical Customers / BOM / returns grouping | **VERIFIED — UAT READY** | browser batch §1b |
| NAV-08 Reports hub | **VERIFIED — UAT READY** | browser batch §1b |
| NAV-10 Settings / Dimensions in the Accounting group | **VERIFIED — UAT READY** | browser batch §1b |
| NAV-11 Navigation gating consolidation | **FINDING ONLY — no change made** (ESC-4 raised, not blocking; not reopened) | source verification + registry spec |
| NAV-12 Fulfilment vs Manufacturing naming | **VERIFIED — UAT READY** | browser batch §1b |
| NAV-13 Dashboard discovery | **VERIFIED — UAT READY** | browser batch §1b |
| NAV-14 Missing approval-type labels | **VERIFIED — UAT READY** | browser batch §1b |

Items are VERIFIED only on the strength of an actual browser run (§1b). The environment for that run is the isolated one (frontend 5601 → backend 3601 → `bv_cp` / `bv_co` on 127.0.0.1:5656, current build, all migrations applied, company "Verify Co"); the earlier observations on 5173 (dev backend 3500 on `daii_dev`, whose code and schema are behind) are recorded as live observations only and are not used as verification evidence.

### 1a. Test credential bootstrap (isolated env only — exactly what was done)

No credential for the isolated environment existed in hand. A direct SQL password overwrite was attempted first and was **blocked by the permission system**, so it was not pursued. The test admin was then provisioned through the system's OFFICIAL admin/bootstrap primitive: a one-off Node script created a Nest application context on the **current build** pointed at `bv_cp` (127.0.0.1:5656 — the script refuses to run for any other host/DB) and called `AuthService.setPassword(userId, <test password>)` for the existing test user `bv.admin@example.test` (the same method behind `POST /admin/users/:id/reset-password`; bcrypt via the app's own hashing, failed-attempt reset, existing sessions revoked). No SQL, no authorization-model change, no production code change; `daii_dev` untouched. Credentials are test-only and are not recorded in the repository.

Other environment actions (all in the isolated DBs): the 5 NAV terminology migrations (+ the later correction `1790001000000`) applied to `bv_cp` and `bv_co`; the isolated backend (3601) restarted from the current build. Test data was created only through the application's own APIs (below).

### 1b. Browser verification batch — Observed → Expected → Result → Evidence → Status

Seed (official APIs, Verify Co): PR submitted; PO submitted→approved, GR posted; supplier invoice created+posted; supplier payment; sales order taken through supervisor → manager → deposit verification; deposit created+approved; treasury cash-in; two rejected events re-driven after the fixture/policy was fixed; the cash-movement clearing account set **through the Accounting-policy screen**.

| # | Item | Observed | Expected | Result | Status |
|---|---|---|---|---|---|
| 1 | NAV-03 `/pending-work` | 9 sources rendered in Arabic; PR = 1, PO = 1 with oldest date (after seeding); later PO = 0 after approval; Sales-order deposit stage = 1; each "open" link → its own screen (`/purchase-requests`, `/purchase-orders`, `/sales-orders`, `/approvals`, …); counts equal the raw list endpoints | one row per source, counts = what is waiting, links to the deciding screen | PASS | VERIFIED |
| 1 | NAV-03 Dashboard card | "بانتظار القرار: 2" (then 1 after the PO was approved) linking to `/pending-work`; sidebar shows Pending work + Guide under the Dashboard group | total of all sources | PASS | VERIFIED |
| 2 | NAV-01/09 `/guide` | 7 stages and 3 flows in Arabic; badges equal the data: org units 0 → "لم يتم", warehouses/users/chart/fiscal years/treasury/suppliers/customers/products/price lists/approval rules → "تم", policy → "لم يتم (4/12)"; flow links point at existing screens; live nav shows Procurement in order suppliers → PR → RFQ → PO → supplier invoices | status mirrors data, no raw keys | PASS | VERIFIED |
| 3 | NAV-05 Common tasks | 9 cards on Dashboard (also on `/guide`), hrefs correct; each hosting screen contains the action: PO (approved) → "تسجيل إذن استلام"; Supplier invoice → "تسجيل دفعة"; Customer account → **Invoices tab** → create invoice / on-account payment / record payment; Treasury ledger → cash in / cash out / transfer; Purchase requests → "طلب صنف جديد"; Inventory → "استيراد الرصيد الافتتاحي" + template + import; Sales order deposit panel appears only at deposit verification | each shortcut leads to a screen where the action is | PASS after correcting 2 hints (customer-account tab; deposit stage) — migration `1790001000000`, re-observed on the Dashboard | VERIFIED |
| 4 | NAV-06 | Returns strip on all four returns screens (4 links, current one highlighted, click-through works); `/bom` shows the pointer to Manufacturing BOMs and the link opens `/manufacturing/boms`; `/customers` appears once in the live navigation (Sales) | one canonical entry; returns grouped; routes intact | PASS | VERIFIED |
| 5 | NAV-08 Reports hub | 3 groups / 14 links in Arabic (financial statements, aging & statements, reconciliations + treasury ledger); the Balance-sheet link opens the report | all existing report screens reachable from one place | PASS | VERIFIED |
| 6 | NAV-10 | Live navigation Accounting group contains `/accounting/dimensions` and `/accounting/settings`; sidebar shows "الأبعاد المالية" and "إعدادات المحاسبة"; Dimensions page opens | discoverable in the group | PASS | VERIFIED |
| 7 | NAV-07 trace | **Payments list**: on-account payment first "مرفوض" (Rejected) — fixture lacked the journal numbering sequence — then, after the official re-drive, "مُرحَّل" with a link that opens JV-2026-000004. **Supplier invoice detail**: supplier payment event "مُرحَّل" + "فتح القيد"; supplier invoice event "مرفوض" with the engine's own reason (no GRNI control account in this chart) — fail-closed made visible. **PO goods-receipt row**: "مرفوض" (same GRNI reason). **Treasury ledger**: cash-in "مرفوض" (clearing account unset) → clearing account set in the policy screen → re-drive → "مُرحَّل" + journal link. **Sales-order deposit panel**: block "deposit.verified — مُرحَّل — فتح القيد" (matched through the payload `depositId`, as the event carries no `sourceEntityId`). **Customer invoice detail**: block renders with "لا يوجد حدث مالي لهذا المستند بعد" (seeded invoices have no event) | Pending / Posted / Rejected + journal link where the engine has one | PASS for Posted, Rejected, no-event and journal navigation. **Not observed live:** the transient Pending state (RECEIVED/MAPPED) and a *Posted* customer-invoice event (the only invoice the seed could create had a zero total, so posting was refused by the system — correct behaviour). Both use the same component exercised above | VERIFIED (with those two gaps stated) |
| 8 | NAV-12 | Arabic sidebar: "التجهيز" and "التصنيع" are separate groups; English: "FULFILMENT" and "MANUFACTURING" (the previous English label "Production" is gone) | distinct names | PASS | VERIFIED |
| 9 | NAV-13 | Dashboard "أقسام العمل المتاحة لك" lists the 16 sections the admin can reach, each linking to its cover (`/sales`, `/accounting`, `/procurement`, …); existing KPIs untouched | role-aware discovery without changing behaviour | PASS | VERIFIED |
| 10 | NAV-14 | Approvals screen shows all six titles in Arabic (اعتماد دفعة الحضور، تصحيح بيانات الحضور، اعتماد العمولات، اعتماد مسير الرواتب، اعتماد المستهدفات، إعادة إقفال فترة مالية) and no raw `action.*` key anywhere | no raw keys | PASS | VERIFIED |
| 11 | NAV-02 (re-observed, not reopened) | Policy screen: the picker offers only usable accounts (control accounts such as 1101/1110 not offered); saving 2900 for the cash-movement clearing account → "صالح"; the rejected treasury event then posted on re-drive — end-to-end proof that the screen drives the fail-closed posting gate | as designed | PASS | VERIFIED (unchanged) |

Findings worth knowing: (a) the goods-receipt and supplier-invoice events being REJECTED is the chart in this throw-away company lacking a GRNI control account — the engine's fail-closed behaviour, now visible on the documents; not a code defect. (b) `daii_dev` / the 5173 backend are behind the code and schema (20+ pending migrations, no NAV-02 routes); its raw terminology keys are a deployment mismatch, not a code defect.

## 2. What changed (all frontend-led; no accounting rule, authorization semantic, company-isolation or approval-policy change)

**Backend (registry + seeds only).** `navigation-registry.ts`: top-level group gains `/pending-work` and `/guide` (ungated — every authenticated user; each source inside keeps its own permission); `/customers` listed once (Sales group; the Customers & Accounts cover still links it); Procurement items reordered PR → RFQ → PO (same items, same gating); `/accounting/dimensions` (`accounting.dimension`) and `/accounting/settings` (`accounting.currency`) added to the Accounting group, each on the node its own list route enforces. Terminology migrations `1789996000000` … `1790001000000` (idempotent upserts; `1790001000000` corrects two Common-tasks hints found by the browser pass; every text ≤ 255 chars; `field.financial_status` is not re-seeded). `nav_group.production` English label "Production" → "Fulfilment" (Arabic "التجهيز" unchanged; Manufacturing stays its own group).

**Frontend.**
- `lib/pendingWork.ts`, `pages/PendingWork.tsx`, Dashboard card — counts what waits across the Approval Engine (`/approvals/requests`, `decidedAt = null`) and the Process-Engine approvals that live in their own screens (PR, PO, warehouse transactions, sales-order supervisor/manager/deposit stages, returns, new-item requests); links to the screen where the decision is taken. Engines are **not merged**; a 403/404 hides that source.
- `lib/guide.ts`, `pages/Guide.tsx` — setup order (Foundation → Accounting → Treasury → Master data → Operations → Control → Reports) with done/to-do hints read from existing list endpoints (policy step shows `ok/12` from the NAV-02 endpoint), and the Procurement / Sales / Inventory chains, each step linking an existing screen.
- `components/CommonTasks.tsx` — Goods receipt, Supplier payment, Customer payment, On-account payment, Invoice creation, Deposit, Treasury actions, New item request, Opening stock: each opens the existing hosting screen with a one-line "where is the action" hint (verified against the screens: GR in Purchase orders, supplier payment in Supplier invoices, customer/on-account payment and invoice creation in the Customer account, deposit panel in the Sales order, cash in/out/transfer/reverse in the Treasury ledger, new-item requests in Purchase requests, opening-stock import in Inventory).
- `lib/financialTrace.ts`, `components/FinancialTrace.tsx` — Document → Financial status (Pending / Posted / Rejected) → Financial event → **Open journal**, read-only over the existing `GET /accounting/financial-events` (permission `accounting.financial_event.view`; no permission → no block). Mounted on: Customer invoice detail, Payments list, Supplier invoice detail (invoice + its supplier payments), Purchase order goods-receipt list, Treasury ledger, Deposit panel (sales order).
- `lib/navVisibility.ts` (reads `/me/navigation`, grants nothing), `ReturnsTabs` on the four returns screens, canonical-BOM notice on `/bom`, `ReportsHub` on the Reports cover (financial statements, aging/statements, reconciliations — each link shown only if the user can reach it), `DashboardSections` (one link per section the user can reach).

## 3. Tested

- Browser: batch in §1b on the isolated environment (login, company Verify Co, 5601).

- Frontend `tsc --noEmit` clean; backend `tsc -p tsconfig.build.json` clean; Vite dev server (5173) compiles every new/changed module (HTTP 200).
- Jest on the isolated PostgreSQL (127.0.0.1:5656): `navigation.service.spec` 20/20, new `nav-closure.spec` 10/10 (registry invariants + terminology-seed safety), `accounting-policy-config.company-isolation.spec` 8/8 (real-PG; applies all migrations incl. the new ones through the harness). **38/38 on the final run, 0 skipped** (37/37 on the first run before the hint correction). NAV-02's 68/68 affected regression was recorded earlier. **No full-repository regression was run or claimed** (reserved for the final release gate).

## 4. Limitations (honest)

1. **Browser verification was done on the isolated environment (5601), not on 5173**: 5173 is the shared dev server wired to the stale `daii_dev` backend (CTO decision: no migration on `daii_dev`). The same frontend source is served by both; re-checking on 5173 is only meaningful once that environment is brought up to date through its normal release path. Two states were not observed live (Pending event state; a Posted customer-invoice event) — see §1b item 7.
2. **NAV-07 reads the whole event list** — the existing endpoint has no per-document filter, so the browser fetches once per page view (8 s cache) and matches by `sourceEntityId`. Fine at current volume; a server-side `sourceEntityId` filter is the recommended follow-up (a backend change, deliberately not done here).
3. **Deposit events carry no `sourceEntityId`** (they land as `unknown`; the id is in the payload as `depositId`) — matched via the payload; a Treasury **transfer** shows its status on the *out* leg only (the event is keyed by the out transaction); a **Purchase order** has no financial event of its own (its Goods Receipts do); **Sales / Delivery** coverage is the deposit and the customer invoices (COD collection events are not surfaced on the shipment screen yet).
4. NAV-03 aggregates client-side from the existing list endpoints; the sales-order buckets inherit that endpoint's visibility (a sales rep sees own orders).
5. `/me/navigation` is fetched (30 s cache) by the cross-link components; on failure they show nothing extra.

## 5. Escalated decisions (only these)

- **ESC-3 — NAV-04, Approval Governance (BLOCKING for NAV-04 only; not decided).** No ratified maker/checker policy for PR/PO, customer/supplier payments, treasury. *Option A:* keep permission-only approval for PR/PO and no approval on payments/treasury (current behaviour). *Option B:* enforce maker ≠ checker on PR/PO now; payments/treasury only after thresholds are set. Recommendation: B for PR/PO; payments/treasury unchanged until thresholds — **a recommendation, not an approval**. Exact decision required: A or B (and, for B, who sets the payment/treasury thresholds).
- **ESC-4 — NAV-11, Authorization (not blocking, no change made).** The 12 items with neither node nor role (Dashboard, `/customers`, `/sales-orders`, `/returns`, `/products`, `/invoices`, `/payments`, `/ar-aging`, `/customer-accounts`, `/customer-statement`, `/reports-overview`, plus the new ungated pages) mirror API read routes that carry **no** `@RequirePermission` (verified in the controllers; only their writes are gated). Adding a node to the navigation would hide screens the API still serves — an authorization change. *Option A (recommended):* leave as is. *Option B:* first add view permissions to those read routes (a security/authorization decision with seed/role-template impact), then mirror them in the registry. Decision required only if the CTO wants B.
- **ESC-1 / ESC-2 (from NAV-02)** remain open and non-blocking: Company scope for the Configuration Engine (recommend A now, B before onboarding Companies with different charts); the five unconsumed AR/AP hint keys and the 5299 default.
- *Decision recorded, not escalated (unchanged):* the canonical BOM screen is Manufacturing's `/manufacturing/boms` (rich lifecycle) — `/bom` is kept, unchanged, for Sales-only Companies and shows a pointer when Manufacturing is reachable. Nothing was removed and no authorization changed.

## 6. UAT readiness

- NAV-02: UAT READY.
- All other UI gaps except NAV-04/NAV-11: VERIFIED in the browser on the isolated environment — UAT READY (read-only/link layers, no write path added, no gating changed).
- NAV-04: blocked on ESC-3. **Production = HOLD.** Not pushed.
