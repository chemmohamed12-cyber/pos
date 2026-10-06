# Navigation & Operational Workflow Gap Closure — Closure Report (2026-10-06)

Baseline: `FRONTEND-NAVIGATION-AND-OPERATIONAL-FLOW-AUDIT-2026-10-06.md` (NAV-01 … NAV-14). Running record: `NAV-GAP-CLOSURE-2026-10-06.md` (NAV-02 / NAV-03 detail).
Closure vocabulary: IMPLEMENTED → INTEGRATED → VERIFIED → UAT READY. **Production = HOLD. Nothing pushed.**

## 1. Status

| Gap | Status | Evidence level |
|---|---|---|
| NAV-02 Accounting policy configuration | **VERIFIED — UAT READY** (commit `18b25d8`) | real-PG 8/8, 68/68 affected regression, live browser (earlier isolated env) |
| NAV-03 Approval visibility (`/pending-work` + Dashboard card) | IMPLEMENTED / INTEGRATED — **BROWSER VERIFICATION PENDING** | typecheck, Vite compile, nav specs, migrations applied on real PG |
| NAV-04 Approval governance | **BLOCKED — POLICY DECISION REQUIRED (ESC-3)** | not implemented by design |
| NAV-01 + NAV-09 Setup & process guidance (`/guide`, Procurement items in process order) | IMPLEMENTED / INTEGRATED — BROWSER VERIFICATION PENDING | same |
| NAV-05 Entry points (Common tasks card on Dashboard + Guide) | IMPLEMENTED / INTEGRATED — BROWSER VERIFICATION PENDING | same |
| NAV-07 Financial traceability on documents | IMPLEMENTED / INTEGRATED — BROWSER VERIFICATION PENDING (see limitations) | same |
| NAV-06 Canonical Customers / BOM / returns grouping | IMPLEMENTED / INTEGRATED — BROWSER VERIFICATION PENDING | same |
| NAV-08 Reports hub | IMPLEMENTED / INTEGRATED — BROWSER VERIFICATION PENDING | same |
| NAV-10 Settings / Dimensions in the Accounting group | IMPLEMENTED / INTEGRATED — BROWSER VERIFICATION PENDING | same + registry spec |
| NAV-11 Navigation gating consolidation | **VERIFIED FINDING — no change made** (ESC-4 raised, not blocking) | source verification + registry spec |
| NAV-12 Fulfilment vs Manufacturing naming | IMPLEMENTED / INTEGRATED — BROWSER VERIFICATION PENDING | registry/seed spec |
| NAV-13 Dashboard discovery | IMPLEMENTED / INTEGRATED — BROWSER VERIFICATION PENDING | same |
| NAV-14 Missing approval-type labels | IMPLEMENTED / INTEGRATED — BROWSER VERIFICATION PENDING | seed spec |

No item is claimed VERIFIED for the UI without a browser run. The 5173 environment shows the login page and no credentials were available through an official path (none were guessed, none searched for), so the browser pass is deferred as a single batch.

## 2. What changed (all frontend-led; no accounting rule, authorization semantic, company-isolation or approval-policy change)

**Backend (registry + seeds only).** `navigation-registry.ts`: top-level group gains `/pending-work` and `/guide` (ungated — every authenticated user; each source inside keeps its own permission); `/customers` listed once (Sales group; the Customers & Accounts cover still links it); Procurement items reordered PR → RFQ → PO (same items, same gating); `/accounting/dimensions` (`accounting.dimension`) and `/accounting/settings` (`accounting.currency`) added to the Accounting group, each on the node its own list route enforces. Terminology migrations `1789996000000` … `1790000000000` (idempotent upserts; every text ≤ 255 chars; `field.financial_status` is not re-seeded). `nav_group.production` English label "Production" → "Fulfilment" (Arabic "التجهيز" unchanged; Manufacturing stays its own group).

**Frontend.**
- `lib/pendingWork.ts`, `pages/PendingWork.tsx`, Dashboard card — counts what waits across the Approval Engine (`/approvals/requests`, `decidedAt = null`) and the Process-Engine approvals that live in their own screens (PR, PO, warehouse transactions, sales-order supervisor/manager/deposit stages, returns, new-item requests); links to the screen where the decision is taken. Engines are **not merged**; a 403/404 hides that source.
- `lib/guide.ts`, `pages/Guide.tsx` — setup order (Foundation → Accounting → Treasury → Master data → Operations → Control → Reports) with done/to-do hints read from existing list endpoints (policy step shows `ok/12` from the NAV-02 endpoint), and the Procurement / Sales / Inventory chains, each step linking an existing screen.
- `components/CommonTasks.tsx` — Goods receipt, Supplier payment, Customer payment, On-account payment, Invoice creation, Deposit, Treasury actions, New item request, Opening stock: each opens the existing hosting screen with a one-line "where is the action" hint (verified against the screens: GR in Purchase orders, supplier payment in Supplier invoices, customer/on-account payment and invoice creation in the Customer account, deposit panel in the Sales order, cash in/out/transfer/reverse in the Treasury ledger, new-item requests in Purchase requests, opening-stock import in Inventory).
- `lib/financialTrace.ts`, `components/FinancialTrace.tsx` — Document → Financial status (Pending / Posted / Rejected) → Financial event → **Open journal**, read-only over the existing `GET /accounting/financial-events` (permission `accounting.financial_event.view`; no permission → no block). Mounted on: Customer invoice detail, Payments list, Supplier invoice detail (invoice + its supplier payments), Purchase order goods-receipt list, Treasury ledger, Deposit panel (sales order).
- `lib/navVisibility.ts` (reads `/me/navigation`, grants nothing), `ReturnsTabs` on the four returns screens, canonical-BOM notice on `/bom`, `ReportsHub` on the Reports cover (financial statements, aging/statements, reconciliations — each link shown only if the user can reach it), `DashboardSections` (one link per section the user can reach).

## 3. Tested

- Frontend `tsc --noEmit` clean; backend `tsc -p tsconfig.build.json` clean; Vite dev server (5173) compiles every new/changed module (HTTP 200).
- Jest on the isolated PostgreSQL (127.0.0.1:5656): `navigation.service.spec` 20/20, new `nav-closure.spec` 9/9 (registry invariants + terminology-seed safety), `accounting-policy-config.company-isolation.spec` 8/8 (real-PG; applies all migrations incl. the five new ones through the harness). **37/37 on the first run, 0 skipped.** NAV-02's 68/68 affected regression was recorded earlier. **No full-repository regression was run or claimed** (reserved for the final release gate).

## 4. Limitations (honest)

1. **Browser verification pending for every UI gap above** (no credentials for 5173). To run in one batch: `/pending-work`, `/guide`, Dashboard (3 new blocks), `/invoices/:id`, `/payments`, `/supplier-invoices`, `/purchase-orders` (GR rows), `/treasury/ledger`, a Sales-order deposit, the four returns screens, `/bom`, `/reports-overview`, Accounting sidebar (Dimensions/Settings).
2. **NAV-07 reads the whole event list** — the existing endpoint has no per-document filter, so the browser fetches once per page view (8 s cache) and matches by `sourceEntityId`. Fine at current volume; a server-side `sourceEntityId` filter is the recommended follow-up (a backend change, deliberately not done here).
3. **Deposit events carry no `sourceEntityId`** (they land as `unknown`; the id is in the payload as `depositId`) — matched via the payload; a Treasury **transfer** shows its status on the *out* leg only (the event is keyed by the out transaction); a **Purchase order** has no financial event of its own (its Goods Receipts do); **Sales / Delivery** coverage is the deposit and the customer invoices (COD collection events are not surfaced on the shipment screen yet).
4. NAV-03 aggregates client-side from the existing list endpoints; the sales-order buckets inherit that endpoint's visibility (a sales rep sees own orders).
5. `/me/navigation` is fetched (30 s cache) by the cross-link components; on failure they show nothing extra.

## 5. Escalated decisions (only these)

- **ESC-3 — NAV-04, Approval Governance (BLOCKING for NAV-04 only; not decided).** No ratified maker/checker policy for PR/PO, customer/supplier payments, treasury. *Option A:* keep permission-only approval for PR/PO and no approval on payments/treasury (current behaviour). *Option B:* enforce maker ≠ checker on PR/PO now; payments/treasury only after thresholds are set. Recommendation: B for PR/PO; payments/treasury unchanged until thresholds — **a recommendation, not an approval**. Exact decision required: A or B (and, for B, who sets the payment/treasury thresholds).
- **ESC-4 — NAV-11, Authorization (not blocking, no change made).** The 12 items with neither node nor role (Dashboard, `/customers`, `/sales-orders`, `/returns`, `/products`, `/invoices`, `/payments`, `/ar-aging`, `/customer-accounts`, `/customer-statement`, `/reports-overview`, plus the new ungated pages) mirror API read routes that carry **no** `@RequirePermission` (verified in the controllers; only their writes are gated). Adding a node to the navigation would hide screens the API still serves — an authorization change. *Option A (recommended):* leave as is. *Option B:* first add view permissions to those read routes (a security/authorization decision with seed/role-template impact), then mirror them in the registry. Decision required only if the CTO wants B.
- **ESC-1 / ESC-2 (from NAV-02)** remain open and non-blocking: Company scope for the Configuration Engine (recommend A now, B before onboarding Companies with different charts); the five unconsumed AR/AP hint keys and the 5299 default.
- *Decision recorded, not escalated:* the canonical BOM screen is Manufacturing's `/manufacturing/boms` (rich lifecycle) — `/bom` is kept, unchanged, for Sales-only Companies and shows a pointer when Manufacturing is reachable. Nothing was removed and no authorization changed.

## 6. UAT readiness

- NAV-02: UAT READY.
- All other UI gaps: ready for UAT **after** the single batched browser pass above (expected low risk: read-only/link layers, no write path added, no gating changed).
- NAV-04: blocked on ESC-3. **Production = HOLD.** Not pushed.
