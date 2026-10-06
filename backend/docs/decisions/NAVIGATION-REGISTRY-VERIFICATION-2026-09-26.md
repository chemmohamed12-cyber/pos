# Navigation Registry — Independent Backend Verification (2026-09-26)

**Status: VERIFIED items IMPLEMENTED (2026-09-26, CTO Authorization —
"Navigation Root-Cause Fix").** Originally VERIFY ONLY; the CTO reviewed
this report and authorized implementation of the items classified
CONFIRMED only, with `permissionNode` used wherever the real backend
route is `@RequirePermission`-gated, never `roles` as a substitute. See
**§ Implementation Record** at the end of this document for exactly what
changed, the evidence closing the loop (real admin-permission-grant
data, not just registry shape), and what remains for the Frontend
session's own runtime verification.

This document's body below (Parts A/B/C, headline finding) is the
original verify-only pass and is left as-is — it is what the
implementation decision was made against.

## Headline finding (cross-cutting, more important than any single row)

**`navigation-registry.ts`'s own doc comment is stale relative to current
source.** It states: *"Every OTHER domain's GET/list routes are gated by
`@RequireModule` + auth only... those items keep their `module` + legacy
`roles` gate."* Direct verification today found this is **no longer
true** for at least 8 domains — `sales-returns`, `shipment-returns`,
`manufacturing/work-orders`, `attendance`, `payroll`, `targets`,
`commission`, and every `procurement/*` controller checked **all** gate
their GET/view routes with `@RequirePermission('<domain>.<resource>.view', 'read-only')`
today, not bare module+auth. Evidence (file:line):

| Domain | GET route | Permission node |
|---|---|---|
| `sales-returns` | `sales-returns.controller.ts:70` | `logistics.sales_return.view` |
| `manufacturing/work-orders` | `work-order.controller.ts:58` | `manufacturing.work_order.view` |
| `attendance` | `attendance.controller.ts:98` | `attendance.connector.view` (+ others per sub-resource) |
| `payroll` | `payroll.controller.ts:100` | `payroll.period.view` (+ others per sub-resource) |
| `targets` | `target.controller.ts:52` | `targets.target.view` |
| `commission` | `commission.controller.ts:101` | `commission.policy.view` (+ others per sub-resource) |
| `procurement/purchase-orders` | `purchase-order.controller.ts:55` | `procurement.purchase_order.view` |
| `procurement/purchase-requests` | `purchase-request.controller.ts:57` | `procurement.purchase_request.view` |
| `procurement/rfqs` | `rfq.controller.ts:50` | `procurement.rfq.view` |
| `procurement/supplier-invoices` | `supplier-invoice.controller.ts:50` | `procurement.supplier_invoice.view` |
| `accounting` (fixed-assets/grni/inventory/wip — separate controllers, same `accounting` prefix) | see per-row evidence below | `accounting.fixed_asset.view` / `accounting.grni.view` / `accounting.inventory.view` / `accounting.wip.view` |

**Implication:** the peer's proposal for Part B (6 missing domains) and
the `sales-returns`/`shipment-returns` items in Part C assumed a
`module` + legacy-`roles` gate (matching the old hardcoded frontend
list). That would be **architecturally inconsistent with the registry's
own stated rule** ("set `permissionNode` only where EVERY route the item
links to is permission-gated... so nav visibility and actual route
access use the SAME axis") — these domains' routes ARE permission-gated
today, so the correct fix per the registry's own design intent is
`permissionNode`, not `roles`. This is flagged as **ARCHITECTURAL
DECISION REQUIRED** on every affected row below, not silently corrected
to one option or the other.

## Part A — Role-array gaps (peer claimed 6 items, labeled "7")

| # | Proposed change | Registry (current, verified) | Verdict |
|---|---|---|---|
| A1 | `/warehouses` add `'admin'` | `roles: ['warehouse_worker','warehouse_supervisor','inventory_controller']` (navigation-registry.ts:79) — confirmed missing `'admin'` | **CONFIRMED** gap exists |
| A2 | `/movement-center` add `'admin'` | Same array (line 80) | **CONFIRMED** |
| A3 | `/inventory` add `'admin'` | Same array (line 81) | **CONFIRMED** |
| A4 | `/stock-count` add `'admin'` | Same array (line 82) | **CONFIRMED** |
| A5 | `/fulfillment` add `'admin'` | `roles: ['warehouse_worker']` (line 88), sole item in `nav_group.production` — confirmed this hides the WHOLE group for admin-only | **CONFIRMED**, severity claim accurate |
| A6 | `/shipments` add `'admin'` | `roles: ['driver']` (line 94) | **CONFIRMED** gap exists — but **INCORRECT framing**: `nav_group.shipping`'s other 3 items (`shipping-methods`, `custody-returns`, `collection-settlements`) already include `'admin'` (lines 95-97), so the group does **not** disappear for admin, only this one item is hidden |

**Correction to peer's own count:** peer's message says "7 items across
3 groups" but lists exactly 6 (4+1+1). Minor, but a real arithmetic
discrepancy in the source claim — one more reason not to accept numbers
without independent recount.

**Correction to peer's severity framing:** the peer's first message
described "several sidebar groups render empty or disappear entirely"
for Warehouses. That's **not accurate** — `nav_group.warehouses`'s first
item, `/warehouse-overview` (line 78), already includes `'admin'` in its
`roles` array. The group is visible to admin today; only 4 of its 5
child items are hidden. Only `nav_group.production` (Fulfillment)
genuinely disappears entirely, because it has exactly one item.

**Whether adding `'admin'` is the CORRECT fix (not just consistent with
old behavior):** not independently verified in this pass whether the
underlying `inventory.controller.ts` / `fulfillment.controller.ts` /
`shipment.controller.ts` routes are role-restricted at the API level
(would need each controller's own guard chain read to confirm admin can
actually call these APIs today) — **NOT CONFIRMED**, recommend checking
before implementing even though the fix looks low-risk (additive only,
matches every other item in the same groups that already includes
`'admin'`).

## Part B — Six missing domains (peer claimed 24 items)

All six module manifests confirmed to exist: `procurement.manifest.ts`,
`manufacturing.manifest.ts`, `attendance.manifest.ts`,
`payroll.manifest.ts`, `targets.manifest.ts`, `commission.manifest.ts`
(`src/foundation/module-registry/manifests/`). All six controllers
confirmed to exist with real, working GET routes. Per the headline
finding above, **every one of these domains' GET routes is
permission-gated today**, not module-only.

| # | Proposed group/item | Backend contract | Module | Permission node (verified where checked) | Verdict |
|---|---|---|---|---|---|
| B1 | Procurement: `/suppliers` | `supplier.controller.ts` (`procurement/suppliers`) | `procurement` | not re-checked this pass (Tier 1, Area 21 Matrix) | **CONFIRMED** exists; permission node **NOT CONFIRMED** |
| B2 | Procurement: `/purchase-orders` | `purchase-order.controller.ts:47,55` | `procurement` | `procurement.purchase_order.view` | **CONFIRMED** |
| B3 | Procurement: `/purchase-requests` | `purchase-request.controller.ts:49,57` | `procurement` | `procurement.purchase_request.view` | **CONFIRMED** |
| B4 | Procurement: `/rfqs` | `rfq.controller.ts:42,50` | `procurement` | `procurement.rfq.view` | **CONFIRMED** |
| B5 | Procurement: `/supplier-invoices` | `supplier-invoice.controller.ts:42,50` | `procurement` | `procurement.supplier_invoice.view` | **CONFIRMED** |
| B6 | Procurement: `/ap-aging` | `supplier-invoice.controller.ts:57` (`GET ap-aging`) — real, confirmed route, same controller as B5, not a separate page's controller | `procurement` | `procurement.supplier_invoice.view` (same guard as B5, not independently checked) | **CONFIRMED** route exists — **NOT CONFIRMED** whether frontend treats it as a separate nav-worthy page or a view within B5's page (needs frontend confirmation) |
| B7 | Procurement: `/supplier-statement` | Likely `supplier.controller.ts:168` (`GET :id/ledger`) by naming symmetry with the existing `/customer-statement` item — **no literal "statement" string found anywhere in procurement controllers** | `procurement` | not checked | **NOT CONFIRMED** — plausible backend target identified, but not a literal 1:1 match; needs frontend page source to confirm which endpoint it actually calls |
| B8 | Manufacturing: `/manufacturing`, `/manufacturing/work-orders` | `work-order.controller.ts:49,58` | `manufacturing` | `manufacturing.work_order.view` | **CONFIRMED** for `/manufacturing/work-orders`; `/manufacturing` (cover page) — **NOT CONFIRMED**, no backend concept of a bare `/manufacturing` route (this is a frontend-only cover page question) |
| B9 | Attendance: `/attendance`, `/attendance/connectors`, `/attendance/import`, `/attendance/biometric-import`, `/attendance/facts`, `/attendance/days` | `attendance.controller.ts:84` (`Controller('attendance')`) | `attendance` | `attendance.connector.view` confirmed for the connectors sub-resource (line 98); other 4 sub-routes **NOT individually re-checked** this pass | **CONFIRMED** domain/controller exists; **NOT CONFIRMED** per-sub-route permission nodes for import/biometric-import/facts/days |
| B10 | Payroll: `/payroll/periods`, `/payroll/compensation`, `/payroll/runs` | `payroll.controller.ts:86` | `payroll` | `payroll.period.view` confirmed for periods (line 100); compensation/runs **NOT individually re-checked** | **CONFIRMED** domain exists; **NOT CONFIRMED** per-sub-route nodes for compensation/runs |
| B11 | Targets: `/targets`, `/targets/targets` | `target.controller.ts:38,52` | `targets` | `targets.target.view` | **CONFIRMED** |
| B12 | Commission: `/commission`, `/commission/policies`, `/commission/results`, `/commission/batches` | `commission.controller.ts:84` | `commission` | `commission.policy.view` confirmed for policies (line 101); results/batches **NOT individually re-checked** | **CONFIRMED** domain exists; **NOT CONFIRMED** per-sub-route nodes for results/batches |

**All of B1-B12: ARCHITECTURAL DECISION REQUIRED on the gate shape** —
per the headline finding, these should very likely use `permissionNode`
per sub-item (matching each route's real `@RequirePermission` node), not
the peer's proposed `module` + legacy-`roles`-from-old-hardcoded-list
approach. This is a design decision (which axis to encode), not purely
a data-correctness question, so it is flagged for your decision rather
than defaulted either way.

**Frontend page existence (all of B1-B12):** **NOT CONFIRMED** from this
session — no access to `App.tsx` or the page components. This is
exactly the piece the Frontend session's own independent verification
(per your relayed instruction) needs to close.

## Part C — Twelve newly-found gaps

| # | Proposed item | Backend contract | Permission node (verified) | Verdict |
|---|---|---|---|---|
| C1 | `/sales-returns` | `sales-returns.controller.ts:61,70` | `logistics.sales_return.view` | **CONFIRMED** route + node; frontend page existence **NOT CONFIRMED** |
| C2 | `/shipment-returns` | `shipment-returns.controller.ts:44` | not confirmed for the GET route specifically (only create/post nodes checked: `logistics.shipment_return.create`/`.post`) | **CONFIRMED** controller exists; GET/view permission node **NOT CONFIRMED** |
| C3 | `/approvals` | `approval.controller.ts:69-97` | `core.approval.view` (list/detail), `core.approval.manage` (decide) — **NOT a role list at all** | **INCORRECT as proposed.** The peer flagged `roles: ['admin']` only as an unverified precedent to check — verification confirms that precedent does **not** match current reality: the route has no role-based gate today, only `PermissionGuard`+`core.approval.view`/`.manage`. A `roles: ['admin']` nav item would not track the real API gate (an admin without `core.approval.view` granted would still see the nav item; a non-admin WITH that permission granted would not see it despite being able to call the API). Correct fix is `permissionNode: 'core.approval'`-style, matching `nav_group.hr`'s own pattern — **ARCHITECTURAL DECISION REQUIRED**, not a default. |
| C4 | `/hr/leave-requests` | `hr.controller.ts:243` (`GET leave-requests`) | `hr.leave_request.view` (line 242) | **CONFIRMED**, and the exact correct `permissionNode` is now known precisely: `hr.leave_request`, matching `nav_group.hr`'s existing `hr.employee`/`hr.department` pattern exactly |
| C5 | `/accounting/ledger` | `general-ledger.controller.ts:217` (`GET ledger`) | `accounting.ledger.view` (line 215) — **the exact same node already used by the existing `/accounting/trial-balance` nav item** | **CONFIRMED** gap — real, distinct backend route (`getLedgerOverview()`), currently zero registry presence, even though its own permission node is already proven safe in production via trial-balance. **Nuance not in the peer's report:** `getLedgerOverview()` and `getTrialBalance()` currently call the exact same underlying service method (`this.ledger.getTrialBalance(...)`) — functionally identical today. Whether the frontend's `GeneralLedger.tsx` is a genuinely distinct page (e.g. with account drill-down via `GET ledger/:accountId`, also confirmed, same node) or effectively a duplicate of the Trial Balance page is a **frontend-side question, NOT CONFIRMED** here. |
| C6 | `/accounting/fixed-assets` | `fixed-asset.controller.ts:177` | `accounting.fixed_asset.view` (line 176) | **CONFIRMED** |
| C7 | `/accounting/inventory` | `inventory-accounting.controller.ts:90` | `accounting.inventory.view` (line 89) | **CONFIRMED** |
| C8 | `/accounting/grni` | `grni.controller.ts:40` | `accounting.grni.view` (line 39) | **CONFIRMED** |
| C9 | `/accounting/fiscal-periods` | `accounting.controller.ts` (`fiscal-years`, `fiscal-years/:id/periods`, closing workflow routes) | `accounting.fiscal_year.view` (line 459) for the base list; closing-specific sub-routes not individually re-checked | **CONFIRMED** backend contract exists; exact frontend-page-to-endpoint mapping **NOT CONFIRMED** |
| C10 | `/accounting/dimensions` | `accounting.controller.ts` (`dimension-types`, `dimension-types/:id/values`, `dimension-values/:id`) | not individually re-checked this pass (pattern strongly suggests `accounting.dimension_type.view`-style, unconfirmed) | **CONFIRMED** backend contract exists; exact permission node **NOT CONFIRMED** |
| C11 | `/accounting/settings` | No dedicated "settings" controller/route found. Likely maps to `accounting.controller.ts`'s `currencies`/`tax-codes`/`tax-periods` routes (all confirmed real, all permission-gated per-resource) | N/A — aggregate, not one node | **NOT CONFIRMED** — real backend support exists for the constituent operations, but which combination `AccountingSettings.tsx` actually calls is a frontend-side fact this session cannot verify |
| C12 | `/accounting` `coverTo` correction | Verified directly from `navigation-registry.ts` itself (no frontend access needed for this part): **`nav_group.accounting` is the only one of 8 groups whose `coverTo` points at a child business item** (`/accounting/chart-of-accounts`, which is also literally items[0]) rather than a dedicated cover-only route. Every other group's `coverTo` (`/sales`, `/warehouse-overview`, `/fulfillment-overview`, `/shipping`, `/customers-accounts`, `/treasury`, `/catalog`, `/hr`, `/administration`) is a distinct path not otherwise listed as a child item (except `warehouse-overview`, which is both — a partial exception). | N/A | **CONFIRMED pattern-break** (directly, from source, independent of the frontend claim) — but whether `/accounting` (a bare path, distinct from `/accounting/chart-of-accounts`) actually resolves to a real `AccountingCover.tsx` component is **NOT CONFIRMED** without frontend access. **ARCHITECTURAL DECISION REQUIRED**: is `/accounting/chart-of-accounts` the intended landing page (by original design) or an oversight matching the pattern-break found here? |

## Summary

```
Proposed: 43
Confirmed: 20   (A1-A5, B2-B5, B8(work-orders only), B9(connectors sub-route only),
                 B10(periods sub-route only), B11, B12(policies sub-route only),
                 C1, C4, C5, C6, C7, C8, C9(base list), C12(pattern-break only))
Not Confirmed: 15  (A6 role-correctness question, B1 permission node, B6 nav-worthiness,
                    B7 exact endpoint, B8 cover route, B9 four sub-routes, B10 two
                    sub-routes, B12 two sub-routes, C2 GET node, C9 sub-route detail,
                    C10 exact node, C11 whole item, C12 frontend page existence)
Incorrect: 1     (C3 — roles:['admin'] does not match the real permission-based gate)
Architectural Decision Required: 15  (all of B1-B12's gate-shape question, C3, C12)
```

(Rows overlap across categories — e.g. B9 is both "domain confirmed" and
"4 sub-routes not confirmed" — the summary above enumerates the
distinct open questions, not a strict partition of the 43.)

## What happens next (superseded by the Implementation Record below — kept for history)

This report is backend-side evidence only. Full closure per your
instruction (`VERIFY → REPORT → CTO AUTHORIZATION → IMPLEMENT → TEST →
RUNTIME VERIFY`) needs the Frontend session's own independent
verification of the frontend-only facts marked NOT CONFIRMED above
(page existence, App.tsx route wiring, which endpoint each settings/
statement page actually calls) before you have a complete picture to
authorize against. No file has been modified. No `admin` added to any
`roles` array, no new `NavGroup`/`NavItem` added, no `coverTo` changed.

## Implementation Record (2026-09-26, CTO Authorization — "Navigation Root-Cause Fix")

**Scope implemented: exactly the items classified CONFIRMED above, and
no others.** Held back per the CTO's explicit "Do NOT implement yet"
list: all of Part B (6 missing domains — every one flagged
ARCHITECTURAL DECISION REQUIRED on the gate shape), C1 (`/sales-returns`
— group placement was never resolved to a specific existing group), C2
(`/shipment-returns` — GET permission node not confirmed), C3
(`/approvals` — explicitly rejected), C10 (`/accounting/dimensions` —
exact node not confirmed at authorization time), C11
(`/accounting/settings` — ambiguous aggregate).

### Changes made — `src/foundation/navigation/navigation-registry.ts`

1. **A1-A4**: added `'admin'` to `roles` on `/warehouses`,
   `/movement-center`, `/inventory`, `/stock-count`.
2. **A5**: added `'admin'` to `roles` on `/fulfillment`.
3. **A6**: added `'admin'` to `roles` on `/shipments`.
4. **C4**: new item `/hr/leave-requests` in `nav_group.hr`, gated
   `permissionNode: 'hr.leave_request'`.
5. **C5**: new item `/accounting/ledger` in `nav_group.accounting`,
   gated `module: 'accounting'`, `feature: 'accounting.general_ledger'`,
   `permissionNode: 'accounting.ledger'` — mirrors its sibling
   `/accounting/trial-balance` exactly (same permission node, same
   underlying service call today).
6. **C6-C9**: new items `/accounting/fixed-assets`,
   `/accounting/inventory`, `/accounting/grni`,
   `/accounting/fiscal-periods` in `nav_group.accounting`, each gated
   `module: 'accounting'` + its own `permissionNode`
   (`accounting.fixed_asset` / `accounting.inventory` /
   `accounting.grni` / `accounting.fiscal_year` respectively) — **no**
   `feature` field on any of these 4, verified per-route: none of their
   real GET handlers carry `@RequireFeature`, and `fixed-asset.controller.ts`'s
   own doc comment (ADR-045 D4) explicitly states register-reads are
   deliberately exempt from the (toggleable) `accounting.fixed_assets`
   feature gate — including it would risk wrongly hiding a page the API
   still serves.
7. **C12**: `nav_group.accounting`'s `coverTo` changed from
   `/accounting/chart-of-accounts` to `/accounting`, matching every
   sibling group's pattern of a dedicated Cover route.

**Rule compliance (CTO's 7 Authorization Rules):** no `roles` used where
the underlying route is `@RequirePermission`-gated (C4-C9 all use
`permissionNode`; A1-A6 keep `roles` only because their underlying
routes are verified NOT permission-gated — see below); no global admin
bypass added anywhere; no hardcoded frontend navigation reintroduced (no
frontend file touched at all); no admin added "just because the current
user is admin" where the API is permission-based; `coverTo` treated as
an independent config correction, not bundled into any permission
decision.

### New evidence found during implementation (recorded, not chased further)

- **Terminology already fully seeded for all 6 new item codes** —
  `nav.hr_leave_requests`, `nav.general_ledger`, `nav.fixed_assets`,
  `nav.inventory_accounting`, `nav.grni_reconciliation`,
  `nav.fiscal_periods` all already exist in prior migrations
  (`SeedHrPhase1Terminology`, `SeedGeneralLedgerTerminology`,
  `SeedFixedAssetInventoryDimensionSettingsTerminology`,
  `SeedWave1FrontendCompletionTerminology`,
  `SeedFiscalPeriodsNavTerminology`). **No new terminology migration was
  needed.** This is strong independent confirmation that the frontend
  pages behind these 6 items already exist — one migration's own doc
  comment names them explicitly: *"This seeds exactly what
  `FixedAssets.tsx` / `InventoryAccounting.tsx` / `Dimensions.tsx` /
  `AccountingSettings.tsx` need"* (`1789600700001-SeedFixedAssetInventoryDimensionSettingsTerminology.ts`).
  This also means `nav.dimensions` terminology already exists too —
  **new evidence upgrading C10's confidence** beyond what this report
  originally found; not implemented now (out of the authorized batch),
  flagged here as a candidate for a fast follow-up decision rather than
  silently added.
- **Real proof the permission-node fixes will actually resolve `true`
  for a real admin user, not just structurally correct shape**: read
  `PermissionService.resolve()`/`hasAtLeast()` directly —
  `ancestorChain('accounting.fixed_asset')` = `['accounting.fixed_asset', 'accounting']`,
  and the resolver walks up to the first configured ancestor. Migration
  `1755858000000-SeedAdminModulePermissionsForHrAndAccounting.ts`
  confirms the `admin` role holds `role_permissions` rows for
  `nodeKey='hr'` and `nodeKey='accounting'` at `access='editable'` —
  both root grants, both satisfying every new `hr.*`/`accounting.*`
  permission node added in this fix via the ancestor-chain walk. This
  independently confirms the peer's original claim ("admin's module-root
  grants satisfy every permissionNode-gated item via the ancestor-chain
  walk") against the actual `PermissionService` source and actual seeded
  data — not accepted on the peer's word.
- **A1-A6 confirmed safe as pure `roles` fixes, not a Permission-axis
  miss**: read the GET-route guard chains directly.
  `inventory.controller.ts`'s `warehouses`/`stock` reads and
  `warehouse-transactions.controller.ts`'s `overview`/list reads carry
  **no** `@RequirePermission` (only writes do) — confirming `roles`
  remains the real, accurate enforcement axis for A1-A4. `fulfillment.controller.ts`
  carries `JwtAuthGuard` only — no module/permission/role guard of any
  kind — confirming A5's `roles` array was never backed by any real
  restriction (a separate, out-of-scope entitlement-gating gap,
  already recorded in the main Matrix's §2.6, not fixed here).
  `shipment.controller.ts`'s list/overview reads are module+auth only,
  confirming A6.

### Verification performed (backend-side, real evidence — not asserted)

- `npm run build` — clean, exit 0.
- `npx eslint` on both changed/added files — 0 problems.
- **New test file** `src/foundation/navigation/navigation.service.spec.ts`
  (none existed before this fix) — 12/12 passing, covering: admin now
  sees all 6 fixed items; the previously-fully-hidden `nav_group.production`
  now renders for admin; non-admin roles (`warehouse_worker`, `driver`,
  no role) see exactly what they saw before (no regression); each of the
  6 new/changed permission-gated items resolves correctly when the node
  is granted and correctly stays hidden when it isn't; the 4 new
  accounting items carry no `feature` field; `coverTo` correction
  reflected; existing `nav_group.hr` items unaffected by the new sibling
  item; the role/permission-free dashboard item is unaffected.
- **Full regression suite** re-run sequentially (`--runInBand`) after
  the change — result reported once complete (see chat).

### What still needs the Frontend session (cannot be produced from this backend-only session)

- A live `GET /me/navigation` HTTP call against a running server with a
  real admin session, and the full browser walkthrough (login → expand
  every group → open a representative route per domain → Console/Network
  clean) — this session has no frontend dev server or browser attached.
- The **"Navigation Completeness" table** the CTO requested
  (`Operational routes: X`) needs the frontend's own route inventory
  (`App.tsx`) — not available here. From the backend registry alone:
  **total `NavItem` count is now 48** (was 42 before this fix; +6 new:
  the 5 accounting additions + 1 HR addition; the 6 role-array edits
  changed no counts). `Missing registry` / `Incorrectly filtered` /
  `Unclassified` figures require cross-referencing against the
  frontend's actual route list, which only the Frontend session can
  produce.

## Implementation Record, Batch 2 (2026-09-26, CTO Authorization — "Full Navigation Closure")

Following the CTO's explicit domain-by-domain authorization ("Full
Navigation Closure — Remaining Domains", 2026-09-26), this batch adds
Procurement, Attendance, Payroll, Targets, Commission, Manufacturing
(special/gated), Sales Returns, Shipment Returns, and Approvals. Per the
CTO's explicit rule ("لا role/permission/feature guessing" — no
guessing), **every permission node, feature flag, and module code below
was independently re-verified against source in this session**, not
copied from the peer session's spec — several of the peer's specific
claims were found to be **wrong** on direct verification (see below),
which is exactly why this discipline exists.

### Peer claims found INCORRECT on independent verification

- The peer claimed Procurement's list routes carry "only
  `@RequireModule('procurement')` + auth, no `@RequirePermission`."
  **False** — direct read of `purchase-order.controller.ts`,
  `purchase-request.controller.ts`, `rfq.controller.ts`,
  `supplier-invoice.controller.ts`, and `supplier.controller.ts` found
  every one of their GET/list routes carries a real
  `@RequirePermission('procurement.<resource>.view', 'read-only')`.
  Implemented with the real permission nodes, not module-only.

### Changes made — `src/foundation/navigation/navigation-registry.ts`

New groups (all verified module/permission/feature per item against
source, not the peer's spec):

| Group | Items | Module | Permission node(s) | Feature |
|---|---|---|---|---|
| `nav_group.procurement` | `/suppliers`, `/purchase-orders`, `/purchase-requests`, `/rfqs`, `/supplier-invoices`, `/supplier-statement`, `/ap-aging` | `procurement` | `procurement.supplier` / `.purchase_order` / `.purchase_request` / `.rfq` / `.supplier_invoice` / `.supplier` (statement, via `:id/ledger`) / `.supplier_invoice` (ap-aging, same node as the list) | none |
| `nav_group.attendance` | `/attendance/connectors`, `/import`, `/biometric-import`, `/facts`, `/days` | `attendance` | `attendance.connector` / `attendance.import` (shared by import + biometric-import) / `attendance.day` (shared by facts + days) | none — no `@RequireFeature` found anywhere in the controller |
| `nav_group.payroll` | `/payroll/periods`, `/compensation`, `/runs` | `payroll` | `payroll.period` / `.compensation` / `.run` | none |
| `nav_group.targets` | `/targets/targets` | `targets` | `targets.target` | none |
| `nav_group.commission` | `/commission/policies`, `/results`, `/batches` | `commission` | `commission.policy` / `.result` / `.batch` (real node is literally `commission.batch.submit` even for the GET list — used as-is, not renamed) | none |
| `nav_group.manufacturing` | `/manufacturing/work-orders` | `manufacturing` | `manufacturing.work_order` | **`manufacturing.work_orders`** — CTO-mandated special case, see below |

New items in existing groups:
- `/sales-returns` → `nav_group.sales` (alongside its sibling `/returns`), `module: 'logistics'`, `permissionNode: 'logistics.sales_return'`.
- `/shipment-returns` → `nav_group.shipping` (alongside its sibling `custody-returns`), `module: 'logistics'`, `permissionNode: 'logistics.shipment_return'`.
- `/approvals` → `nav_group.administration`, no `module` (Core/platform, like every other item in that group), `permissionNode: 'core.approval'`. **No `roles` field** — `roles: ['admin']` was the peer's own flagged, unverified precedent, and this session confirmed it does not match reality (below).

**Group placement note (a judgment call, not a verified fact):** the
CTO's package did not specify which existing group `/sales-returns` and
`/shipment-returns` belong to. Placed by direct textual/domain match
next to each item's closest sibling (`/returns` and `custody-returns`
respectively) — flagged here as a placement decision, not something
derived from a backend contract, in case the Frontend session's own
grouping differs.

### Manufacturing — implemented exactly as the CTO's special-case instruction requires

Verified directly: `work-order.controller.ts`'s list route carries BOTH
`@RequireFeature('manufacturing.work_orders')` and
`@RequirePermission('manufacturing.work_order.view', 'read-only')`.
`manufacturing.manifest.ts`: `{ code: 'manufacturing.work_orders', default: false, toggleable: true }`.
`EntitlementService.resolve()` (line ~246): under `unlicensed-full` mode,
only `feature_codes` with `default: true` are auto-added — confirming
`manufacturing.work_orders` is genuinely OFF today for every user,
including admin. The registry item includes **both** `feature:
'manufacturing.work_orders'` and `permissionNode: 'manufacturing.work_order'`
— it will correctly stay hidden until an installation's entitlement
manifest actually turns the feature on, with no bypass, no role-gate
substitute, and no code change to `RequireFeatureGuard` or the
controller. Confirmed via a new test that neither the feature alone nor
the permission alone reveals the item — only both together.

### Approvals — the peer's own flagged precedent rejected, with direct proof

Read `approval.controller.ts` in full again: `@UseGuards(JwtAuthGuard, RolesGuard)`
at the class level, but **zero `@RequireRole` decorators anywhere in the
file** (grep confirmed). Read `RolesGuard.canActivate()` directly: when
no role metadata is configured (`reflector.getAllAndOverride` returns
undefined/empty), it returns `true` unconditionally — a documented,
intentional no-op, not a bug. The only real gate is `PermissionGuard` +
`@RequirePermission('core.approval.view'/'core.approval.manage')`. The
nav item uses `permissionNode: 'core.approval'` and carries no `roles`
field at all.

### Real admin-permission-grant evidence closing the loop for all 6 new module roots

Read the 6 corresponding `SeedAdminPermissionsFor<Module>` migrations
directly (`procurement`, `attendance`, `payroll`, `targets`,
`commission`, `manufacturing`) — each grants the `admin` role a
`role_permissions` row at `nodeKey='<module>'`, `access='editable'`.
Every new permission node added in this batch (e.g.
`procurement.purchase_order`, `attendance.connector`,
`commission.batch`) inherits from one of these root grants via
`PermissionService`'s ancestor-chain walk — same mechanism already
proven for `hr`/`accounting` in Batch 1. Also confirmed directly:
`{ role: 'admin', node: 'logistics', access: 'editable' }` in
`BackfillLegacyRolePermissions` (covers Sales/Shipment Returns), and a
literal `'core.approval'`, `'editable'` grant to `admin` in
`CreateApprovalEngine` itself (covers Approvals).

### New terminology migrations — 5 new files, `nav_group.*` labels only

Every single new nav ITEM code (`nav.suppliers`, `nav.purchase_orders`,
… all the way through `nav.approvals`) was **already seeded** in prior
migrations — none needed. The 5 new GROUP header codes
(`nav_group.attendance`, `nav_group.payroll`, `nav_group.targets`,
`nav_group.commission`, `nav_group.manufacturing`) had **never** been
seeded anywhere (`nav_group.procurement` already existed and needed no
new migration) — the exact same class of gap
`SeedNavGroupHrTerminology1755854300000` fixed for `nav_group.hr` in an
earlier phase. Five new migrations added, one per domain-tagged folder,
following that exact precedent:
`attendance/1789730500000-SeedNavGroupAttendanceTerminology.ts`,
`payroll/1789740300000-SeedNavGroupPayrollTerminology.ts`,
`targets/1789750300000-SeedNavGroupTargetsTerminology.ts`,
`commission/1789751500000-SeedNavGroupCommissionTerminology.ts`,
`manufacturing/1789734100000-SeedNavGroupManufacturingTerminology.ts`.

### Verification performed

- `npm run build` — clean, exit 0.
- `npx eslint` on the registry file and all 5 new migrations — 0 problems.
- Extended `navigation.service.spec.ts` with 8 new test cases (20/20
  total passing) covering: all 7 Procurement items on their real nodes;
  Attendance's shared-node pairs; Payroll's 3 distinct nodes; Targets;
  Commission's `.batch` node; Manufacturing's dual feature+permission
  gate (4 sub-cases: neither/permission-only/feature-only/both); Sales
  Returns and Shipment Returns correctly placed in their groups; and
  Approvals correctly NOT gated by `roles: ['admin']`.
- Full regression suite re-run sequentially — result reported once
  complete (see chat).

### What still needs the Frontend session

Everything listed at the end of Batch 1 applies here too, plus: whether
the 22 new items' frontend pages actually exist at the exact routes used
here (this session confirmed their *terminology* already exists, which
is strong indirect evidence, but not the same as confirming `App.tsx`
wiring), and the group-placement judgment call for Sales/Shipment
Returns noted above.
- Whether `/accounting/ledger` (`GeneralLedger.tsx`, per the peer) is a
  genuinely distinct page from `/accounting/trial-balance` in the
  frontend, or effectively renders the same content today (their
  backend handlers are currently identical) — a frontend-side fact.
- Whether `/accounting` truly resolves to a working `AccountingCover.tsx`
  now that `coverTo` points there (C12) — a frontend-side fact.
