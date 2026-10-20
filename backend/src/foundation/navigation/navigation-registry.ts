/**
 * ERP Foundation — P7 (Server-Driven Frontend Navigation).
 * `ERP_FOUNDATION_PHASE_PLAN.md` §P7.
 *
 * The server-side source of truth for the SPA's sidebar — a direct,
 * data-preserving translation of `frontend/src/components/Layout.tsx`'s
 * former `NAV_GROUPS` (same items, same routes, same labels, same
 * grouping/order) with each item's visibility now declared as metadata
 * (`module`/`feature`/`roles`) instead of being baked into client code.
 * `GET /me/navigation` resolves this against the current principal;
 * `Layout.tsx` renders whatever it receives, with zero filtering logic
 * of its own — moving the *decision* server-side, not just duplicating it.
 *
 * Resolution per item (`navigation.service.ts`):
 *  1. `module` (if set) — must be in the resolved Entitlement's `modules`
 *     (Entitlement Engine, P3). Every module is entitled today
 *     (`ENTITLEMENT_MODE=unlicensed-full` default), so this is currently
 *     a no-op filter — forward-compatible with P6, not yet load-bearing.
 *  2. `feature` (if set) — same, against `features`.
 *  3. `permissionNode` (if set) — must resolve to at least `'read-only'`
 *     via the Permission Engine. **Set only where EVERY route the nav item
 *     links to is permission-gated (incl. its GET/view routes)** so nav
 *     visibility and actual route access use the SAME axis and cannot
 *     drift. Post P4 Tranche-2 (2026-09-06 — all 14 domains guard-swapped,
 *     `P4_CLOSURE.md`): `treasury` is the one domain whose controller
 *     applies `@RequirePermission('finance','editable')` uniformly on
 *     every route including the ledger GET (`evidence/P4/T2-treasury-2026-09-06.md`)
 *     — its two nav items now gate on `permissionNode: 'finance'` (the
 *     `BackfillLegacyRolePermissions` migration granted the legacy `finance`
 *     role and `admin` that exact node, so this is a behaviour-preserving
 *     swap of `roles: ['admin','finance']`). Every OTHER domain's GET/list
 *     routes are gated by `@RequireModule` + auth only (writes carry
 *     `@RequirePermission`), so adding a read `permissionNode` there would
 *     wrongly HIDE a page the API would serve — those items keep their
 *     `module` + legacy `roles` gate (still the accurate coarse reality).
 *  4. `roles` (if set) — must hold at least one. Unset = visible to
 *     every authenticated user (same semantics `Layout.tsx` used).
 *  5. A group renders only if at least one of its items is visible
 *     (same as `Layout.tsx`'s prior `visibleGroups` filter).
 */

export interface NavItem {
  to: string;
  code: string;
  /** Entitlement Engine module_code gate. */
  module?: string;
  /** Entitlement Engine feature_code gate (within `module`). */
  feature?: string;
  /** Permission Engine node gate — see class doc comment §3; unset everywhere today. */
  permissionNode?: string;
  /** Legacy per-item role gate — the ACTUAL enforcement mechanism every linked route still uses today (P4 Tranche-2 has not guard-swapped these domains). */
  roles?: string[];
  /** F5 — a WORKFLOW RULE (capability, `authorization/workflow-rules.ts`) that replaces `roles` for the migrated items; decided under the active `AUTHZ_WORKFLOW_MODE`. The platform tools (`/admin`, `/integrations`, `/release-center`) keep `roles: ['admin']` — see the F5 report (AZ-01 residual). */
  workflowRule?: string;
}

export interface NavGroup {
  /** Section header terminology code, or '' for a standalone top-level item. */
  code: string;
  items: NavItem[];
  /** The group header itself links here (CTO directive — "Section Cover / Main Dashboard System"). */
  coverTo?: string;
}

export const NAVIGATION_REGISTRY: NavGroup[] = [
  {
    code: '',
    items: [
      { to: '/', code: 'nav.dashboard' },
      // NAV-03 — every authenticated user; each source inside the page keeps its own permission (an unreadable source is simply hidden).
      { to: '/pending-work', code: 'nav.pending_work' },
      // NAV-01 / NAV-09 — guidance only (links + done/to-do hints from existing list endpoints); every authenticated user.
      { to: '/guide', code: 'nav.guide' },
    ],
  },
  {
    code: 'nav_group.sales',
    coverTo: '/sales',
    items: [
      { to: '/customers', code: 'nav.customers', module: 'sales' },
      { to: '/sales-orders', code: 'nav.sales_orders', module: 'sales' },
      { to: '/returns', code: 'nav.returns', module: 'logistics' },
      // 2026-09-26 — Navigation Root-Cause Fix, Full Closure batch: `sales-returns.controller.ts`'s
      // base `GET()` list route carries `@RequirePermission('logistics.sales_return.view')`, no role
      // gate at all — same `logistics` module as the sibling `/returns` item above (established
      // precedent for a `logistics`-module item living in `nav_group.sales`, not a new pattern).
      { to: '/sales-returns', code: 'nav.sales_returns', module: 'logistics', permissionNode: 'logistics.sales_return' },
    ],
  },
  {
    code: 'nav_group.warehouses',
    coverTo: '/warehouse-overview',
    items: [
      { to: '/warehouse-overview', code: 'nav.warehouse_overview', module: 'inventory', workflowRule: 'nav.warehouse' },
      // 2026-09-26 — Navigation Root-Cause Fix (CTO-authorized, NAVIGATION-REGISTRY-VERIFICATION-2026-09-26.md
      // items A1-A4): `inventory.controller.ts`/`warehouse-transactions.controller.ts`'s GET/list routes
      // for these 4 items carry NO `@RequirePermission` (verified directly — only writes are permission-gated),
      // so `roles` remains the actual, accurate enforcement axis here (not a `permissionNode` case). `admin`
      // added — the old client-side `hasRole()` bypass (removed when this registry was authored) meant admin
      // always saw these; the registry's own role list never carried that bypass forward.
      { to: '/warehouses', code: 'nav.warehouses', module: 'inventory', workflowRule: 'nav.warehouse' },
      { to: '/movement-center', code: 'nav.movement_center', module: 'inventory', workflowRule: 'nav.warehouse' },
      { to: '/inventory', code: 'nav.inventory', module: 'inventory', workflowRule: 'nav.warehouse' },
      { to: '/stock-count', code: 'nav.stock_count', module: 'inventory', workflowRule: 'nav.warehouse' },
      // C1 (2026-10-17): the valuation report is served by `GET inventory/valuation/report`, gated by `inventory.valuation.view` (read-only).
      { to: '/inventory/valuation-report', code: 'nav.valuation_report', module: 'inventory', permissionNode: 'inventory.valuation' },
    ],
  },
  {
    code: 'nav_group.production',
    coverTo: '/fulfillment-overview',
    // 2026-09-26 — Navigation Root-Cause Fix (item A5): `fulfillment.controller.ts` carries only
    // `JwtAuthGuard` — no `RequireModuleGuard`/`PermissionGuard`/`RolesGuard` at all (a separate,
    // out-of-scope entitlement-gating finding, not fixed here) — so `roles` here has never mirrored a
    // real backend restriction; adding `admin` is a pure, safe nav-visibility correction.
    items: [{ to: '/fulfillment', code: 'nav.fulfillment', module: 'inventory', workflowRule: 'nav.fulfillment' }],
  },
  {
    code: 'nav_group.shipping',
    coverTo: '/shipping',
    items: [
      // 2026-09-26 — Navigation Root-Cause Fix (item A6): `shipment.controller.ts`'s GET/list routes
      // are module+auth only (writes are permission-gated) — `roles` is the accurate axis; `admin`
      // was already present on this group's other 3 items, just missing here.
      { to: '/shipments', code: 'nav.shipments', module: 'logistics', workflowRule: 'nav.shipments' },
      { to: '/shipping-methods', code: 'nav.shipping_methods', module: 'logistics', workflowRule: 'nav.shipping_methods' },
      { to: '/custody-returns', code: 'nav.custody_returns', module: 'logistics', workflowRule: 'nav.custody_returns' },
      { to: '/collection-settlements', code: 'nav.collection_settlements', module: 'logistics', workflowRule: 'nav.collection_settlements' },
      // 2026-09-26 — Navigation Root-Cause Fix, Full Closure batch: `shipment-returns.controller.ts`'s
      // base `GET()` list route carries `@RequirePermission('logistics.shipment_return.view')`, no role
      // gate — grouped alongside `custody-returns`, this group's existing returns-adjacent item.
      { to: '/shipment-returns', code: 'nav.shipment_returns', module: 'logistics', permissionNode: 'logistics.shipment_return' },
    ],
  },
  {
    code: 'nav_group.customers_accounts',
    coverTo: '/customers-accounts',
    items: [
      // NAV-06 — `/customers` is listed once, in the Sales group (its owner); the Customers & Accounts cover still links to it.
      { to: '/customer-accounts', code: 'nav.customer_accounts', module: 'finance' },
      { to: '/customer-statement', code: 'nav.customer_statement', module: 'finance' },
      { to: '/invoices', code: 'nav.invoices', module: 'finance' },
      { to: '/payments', code: 'nav.payments', module: 'finance' },
      { to: '/ar-aging', code: 'nav.ar_aging', module: 'finance' },
    ],
  },
  {
    code: 'nav_group.treasury',
    coverTo: '/treasury',
    items: [
      // P7 / post-P4-T2: treasury routes are uniformly `@RequirePermission('finance','editable')`
      // (incl. the ledger GET) — nav gates on the same node, `read-only`
      // being the minimum (editable satisfies it). Behaviour-identical to
      // the former `roles: ['admin','finance']` via the legacy-role backfill.
      { to: '/treasury/accounts', code: 'nav.treasury_accounts', module: 'finance', permissionNode: 'finance' },
      { to: '/treasury/ledger', code: 'nav.treasury_ledger', module: 'finance', permissionNode: 'finance' },
    ],
  },
  {
    code: 'nav_group.catalog',
    coverTo: '/catalog',
    items: [
      { to: '/products', code: 'nav.products', module: 'sales' },
      { to: '/price-lists', code: 'nav.price_lists', module: 'sales', workflowRule: 'nav.price_lists' },
      { to: '/bom', code: 'nav.bom', module: 'sales', workflowRule: 'nav.bom' },
    ],
  },
  { code: '', items: [{ to: '/reports-overview', code: 'nav.reports', module: 'reporting' }] },
  {
    // ERP Foundation P9 (ADR-029) — the first navigation group for a module
    // that didn't exist before this phase, added with zero change to
    // `NavigationService.resolveFor` or `Layout.tsx` (P7's server-driven nav
    // resolves this exactly like every other `module`-gated group).
    code: 'nav_group.hr',
    coverTo: '/hr',
    items: [
      // ADR-039 §5 — nav↔API alignment. HR's GET routes are permission-gated
      // (`hr.employee.view` / `hr.department.view` — Commercial Release Gate
      // SEC-07 / red-team RT05-1: employee records are PII). Nav visibility now
      // gates on the SAME nodes so an item is never shown to a role the API
      // would 404. Same shape as `nav_group.accounting`'s items. Navigation is
      // NOT the security boundary — the server-side `@RequirePermission` is.
      { to: '/hr/employees', code: 'nav.hr_employees', module: 'hr', permissionNode: 'hr.employee' },
      { to: '/hr/departments', code: 'nav.hr_departments', module: 'hr', permissionNode: 'hr.department' },
      // 2026-09-26 — Navigation Root-Cause Fix (item C4, NAVIGATION-REGISTRY-VERIFICATION-2026-09-26.md):
      // `hr.controller.ts`'s `GET leave-requests` carries `@RequirePermission('hr.leave_request.view', 'read-only')`
      // — same shape as this group's other 2 items, gated on the SAME node the API actually enforces.
      { to: '/hr/leave-requests', code: 'nav.hr_leave_requests', module: 'hr', permissionNode: 'hr.leave_request' },
    ],
  },
  {
    // Financial Core — F02 (ADR-034). Same shape as the `hr` group: a
    // `module`-gated group resolved by P7's server-driven nav with zero
    // change to `NavigationService.resolveFor` or `Layout.tsx`. The
    // Chart of Accounts item carries a `permissionNode` read gate
    // because its list route IS `@RequirePermission('accounting.account.view')`
    // (unlike most domains' bare-`@RequireModule` list routes — so hiding
    // it when the node is absent matches what the API would actually do).
    code: 'nav_group.accounting',
    // 2026-09-26 — Navigation Root-Cause Fix (item C12, NAVIGATION-REGISTRY-VERIFICATION-2026-09-26.md):
    // this was the only one of 8 groups whose `coverTo` pointed at a child business item
    // (`/accounting/chart-of-accounts`, itself also items[0]) instead of a dedicated Cover route —
    // every sibling group's `coverTo` targets its own Cover page. Corrected to match that pattern;
    // an independent Navigation-configuration correction, not an authorization change.
    coverTo: '/accounting',
    items: [
      {
        to: '/accounting/chart-of-accounts',
        code: 'nav.chart_of_accounts',
        module: 'accounting',
        feature: 'accounting.chart_of_accounts',
        permissionNode: 'accounting.account',
      },
      // F03 — General Ledger + Financial Event Engine (ADR-035).
      {
        to: '/accounting/policy',
        code: 'nav.accounting_policy',
        module: 'accounting',
        permissionNode: 'accounting.account',
      },
      {
        to: '/accounting/journals',
        code: 'nav.journals',
        module: 'accounting',
        feature: 'accounting.general_ledger',
        permissionNode: 'accounting.journal',
      },
      {
        to: '/accounting/trial-balance',
        code: 'nav.trial_balance',
        module: 'accounting',
        feature: 'accounting.general_ledger',
        permissionNode: 'accounting.ledger',
      },
      // 2026-09-26 — Navigation Root-Cause Fix (item C5, NAVIGATION-REGISTRY-VERIFICATION-2026-09-26.md):
      // `general-ledger.controller.ts`'s `GET ledger` is a real, distinct route (`getLedgerOverview`,
      // currently delegating to the same `getTrialBalance` service call as its sibling above — same
      // gate shape, mirrored here) with zero registry presence until now. `GET ledger/:accountId`
      // (per-account drill-down, same permission node) is reachable once this item is visible; not
      // given its own nav entry since it's a detail view of this one, matching this group's convention
      // of not listing `:id` detail routes separately (see `/accounting/accounts/:id`, uncovered too).
      {
        to: '/accounting/ledger',
        code: 'nav.general_ledger',
        module: 'accounting',
        feature: 'accounting.general_ledger',
        permissionNode: 'accounting.ledger',
      },
      {
        to: '/accounting/financial-events',
        code: 'nav.financial_events',
        module: 'accounting',
        feature: 'accounting.general_ledger',
        permissionNode: 'accounting.financial_event',
      },
      // F04 — Accounts Receivable (ADR-036): AR↔GL reconciliation, the
      // accounting customer statement, and maker-checker AR adjustments.
      {
        to: '/accounting/ar',
        code: 'nav.ar_reconciliation',
        module: 'accounting',
        feature: 'accounting.accounts_receivable',
        permissionNode: 'accounting.ar',
      },
      // F05 — Accounts Payable (ADR-037): AP↔GL reconciliation (dormant
      // until the operational supplier phase), the AP statement, and
      // maker-checker AP adjustments.
      {
        to: '/accounting/ap',
        code: 'nav.ap_reconciliation',
        module: 'accounting',
        feature: 'accounting.accounts_payable',
        permissionNode: 'accounting.ap',
      },
      // F06 — Cash & Bank (ADR-038): per-account Treasury↔GL reconciliation,
      // the Cash/Bank position statement, and maker-checker cash/bank adjustments.
      {
        to: '/accounting/cash-bank',
        code: 'nav.cash_bank_reconciliation',
        module: 'accounting',
        feature: 'accounting.cash_bank',
        permissionNode: 'accounting.cash',
      },
      // 2026-09-26 — Navigation Root-Cause Fix (items C6-C9, NAVIGATION-REGISTRY-VERIFICATION-2026-09-26.md):
      // 4 more real, permission-gated `accounting` routes with zero prior registry presence. No `feature`
      // field on any of these 4 — verified directly per route: `fixed-asset.controller.ts`'s own doc
      // comment (F12/ADR-045 D4) states register-read/reconciliation are DELIBERATELY exempt from the
      // (toggleable) `accounting.fixed_assets` feature gate, so including it here would risk wrongly
      // hiding a page the API still serves once that feature is toggled off; `grni`/`inventory-accounting`/
      // `fiscal-years` GET routes carry no `@RequireFeature` at all. Matches this group's own stated rule:
      // encode only the axis the linked route actually enforces.
      {
        to: '/accounting/fixed-assets',
        code: 'nav.fixed_assets',
        module: 'accounting',
        permissionNode: 'accounting.fixed_asset',
      },
      {
        to: '/accounting/inventory',
        code: 'nav.inventory_accounting',
        module: 'accounting',
        permissionNode: 'accounting.inventory',
      },
      {
        to: '/accounting/grni',
        code: 'nav.grni_reconciliation',
        module: 'accounting',
        permissionNode: 'accounting.grni',
      },
      {
        to: '/accounting/fiscal-periods',
        code: 'nav.fiscal_periods',
        module: 'accounting',
        permissionNode: 'accounting.fiscal_year',
      },
      // NAV-10 — Dimensions and Accounting Settings (currencies / tax codes / tax periods) were reachable only from the Accounting cover. Each is gated on the
      // node its own list route enforces (`accounting.dimension.view`, `accounting.currency.view`), so navigation never shows what the API would refuse.
      {
        to: '/accounting/dimensions',
        code: 'nav.dimensions',
        module: 'accounting',
        permissionNode: 'accounting.dimension',
      },
      {
        to: '/accounting/settings',
        code: 'nav.accounting_settings',
        module: 'accounting',
        permissionNode: 'accounting.currency',
      },
      // F14 — Financial Reporting (ADR-047 D7/D8). `feature: 'accounting.general_ledger'` matches
      // Trial Balance's own gate — reporting is built on the same GL data, no new feature flag (D7).
      {
        to: '/accounting/reports/balance-sheet',
        code: 'nav.balance_sheet',
        module: 'accounting',
        feature: 'accounting.general_ledger',
        permissionNode: 'accounting.report',
      },
      {
        to: '/accounting/reports/profit-and-loss',
        code: 'nav.profit_and_loss',
        module: 'accounting',
        feature: 'accounting.general_ledger',
        permissionNode: 'accounting.report',
      },
      {
        to: '/accounting/reports/cash-flow',
        code: 'nav.cash_flow',
        module: 'accounting',
        feature: 'accounting.general_ledger',
        permissionNode: 'accounting.report',
      },
    ],
  },
  {
    // 2026-09-26 — Navigation Root-Cause Fix, Full Closure batch. All 7 items
    // verified directly against `supplier.controller.ts`/`purchase-order.controller.ts`/
    // `purchase-request.controller.ts`/`rfq.controller.ts`/`supplier-invoice.controller.ts` —
    // every GET/list route is `@RequirePermission`-gated, contradicting an earlier peer claim
    // that these were module-only; not trusted without this direct read.
    code: 'nav_group.procurement',
    coverTo: '/procurement',
    items: [
      { to: '/suppliers', code: 'nav.suppliers', module: 'procurement', permissionNode: 'procurement.supplier' },
      // NAV-01 — the same items, in process order (request -> RFQ -> order); no item added, removed or re-gated.
      { to: '/purchase-requests', code: 'nav.purchase_requests', module: 'procurement', permissionNode: 'procurement.purchase_request' },
      { to: '/rfqs', code: 'nav.rfqs', module: 'procurement', permissionNode: 'procurement.rfq' },
      { to: '/purchase-orders', code: 'nav.purchase_orders', module: 'procurement', permissionNode: 'procurement.purchase_order' },
      { to: '/supplier-invoices', code: 'nav.supplier_invoices', module: 'procurement', permissionNode: 'procurement.supplier_invoice' },
      { to: '/purchase-returns', code: 'nav.purchase_returns', module: 'procurement', permissionNode: 'procurement.purchase_return' },
      // `GET :id/ledger` on `supplier.controller.ts` — same node as the supplier list/detail routes.
      { to: '/supplier-statement', code: 'nav.supplier_statement', module: 'procurement', permissionNode: 'procurement.supplier' },
      // `GET ap-aging` on `supplier-invoice.controller.ts` — same node as that controller's list route.
      { to: '/ap-aging', code: 'nav.ap_aging', module: 'procurement', permissionNode: 'procurement.supplier_invoice' },
    ],
  },
  {
    // Verified directly against `attendance.controller.ts` — no `@RequireFeature` anywhere in this
    // controller (the `attendance.tracking` feature is `default: true`, so this is correctly omitted).
    code: 'nav_group.attendance',
    coverTo: '/attendance',
    items: [
      { to: '/attendance/connectors', code: 'nav.attendance_connectors', module: 'attendance', permissionNode: 'attendance.connector' },
      // `/attendance/import` and `/attendance/biometric-import` share the same permission family —
      // both pages' primary read route (`import-template` / `biometric-import-template`) is gated
      // `attendance.import.view`.
      { to: '/attendance/import', code: 'nav.attendance_import', module: 'attendance', permissionNode: 'attendance.import' },
      { to: '/attendance/biometric-import', code: 'nav.attendance_biometric_import', module: 'attendance', permissionNode: 'attendance.import' },
      // `GET biometric-facts` and `GET days` are both `attendance.day.view` — same node, verified per-route.
      { to: '/attendance/facts', code: 'nav.attendance_facts', module: 'attendance', permissionNode: 'attendance.day' },
      { to: '/attendance/days', code: 'nav.attendance_days', module: 'attendance', permissionNode: 'attendance.day' },
    ],
  },
  {
    // Verified directly against `payroll.controller.ts` — no `@RequireFeature` on any route despite
    // `payroll.core` being `default: false` in the manifest (a real manifest/route mismatch, not
    // fixed here — flagged in NAVIGATION-REGISTRY-VERIFICATION-2026-09-26.md, not this file's concern).
    code: 'nav_group.payroll',
    coverTo: '/payroll',
    items: [
      { to: '/payroll/periods', code: 'nav.payroll_periods', module: 'payroll', permissionNode: 'payroll.period' },
      { to: '/payroll/compensation', code: 'nav.payroll_compensation', module: 'payroll', permissionNode: 'payroll.compensation' },
      { to: '/payroll/runs', code: 'nav.payroll_runs', module: 'payroll', permissionNode: 'payroll.run' },
    ],
  },
  {
    // Same shape as `nav_group.production` — a single-item group. No `@RequireFeature` on the route
    // despite `targets.core` being `default: false` in the manifest (same class of gap as Payroll).
    code: 'nav_group.targets',
    coverTo: '/targets',
    items: [{ to: '/targets/targets', code: 'nav.targets', module: 'targets', permissionNode: 'targets.target' }],
  },
  {
    // Verified directly against `commission.controller.ts`. `/commission/batches`'s real GET route is
    // gated `@RequirePermission('commission.batch.submit', 'read-only')` — the node is literally named
    // "...submit" but IS the actual read-gate for this list route (unusual naming, not invented around);
    // `permissionNode: 'commission.batch'` (its ancestor) is used, matching the real enforced node exactly.
    code: 'nav_group.commission',
    coverTo: '/commission',
    items: [
      { to: '/commission/policies', code: 'nav.commission_policies', module: 'commission', permissionNode: 'commission.policy' },
      { to: '/commission/results', code: 'nav.commission_results', module: 'commission', permissionNode: 'commission.result' },
      { to: '/commission/batches', code: 'nav.commission_batches', module: 'commission', permissionNode: 'commission.batch' },
    ],
  },
  {
    // ADR-061 Addendum 1 (A5/A6) — every item gates on the SAME axes its API routes enforce:
    // `@RequireModule('manufacturing')` + `@RequirePermission('manufacturing.<area>.view')`. The
    // `manufacturing.work_orders` feature is structural (follows the module's entitlement), so Work Orders
    // needs no separate feature toggle. Assembly's API is `inventory.assembly.create`; the screen lives in
    // the Manufacturing workspace and reads the BOM list, so it is gated by the manufacturing module.
    code: 'nav_group.manufacturing',
    coverTo: '/manufacturing',
    items: [
      { to: '/manufacturing/work-orders', code: 'nav.manufacturing_work_orders', module: 'manufacturing', feature: 'manufacturing.work_orders', permissionNode: 'manufacturing.work_order' },
      { to: '/manufacturing/boms', code: 'nav.manufacturing_boms', module: 'manufacturing', permissionNode: 'manufacturing.bom' },
      { to: '/manufacturing/routings', code: 'nav.manufacturing_routings', module: 'manufacturing', permissionNode: 'manufacturing.routing' },
      { to: '/manufacturing/work-centers', code: 'nav.manufacturing_work_centers', module: 'manufacturing', permissionNode: 'manufacturing.work_center' },
      { to: '/manufacturing/assembly', code: 'nav.manufacturing_assembly', module: 'manufacturing', permissionNode: 'inventory.assembly' },
    ],
  },
  {
    code: 'nav_group.administration',
    coverTo: '/administration',
    items: [
      // No `module` — these are Core/platform routes (foundation/organization,
      // foundation/admin, foundation/integrations, foundation/release),
      // not part of any of the 5 V1 business modules. Core is always
      // present (ADR-023 — "core is implicit and never listed" in
      // depends_on), so entitlement never restricts these; `roles` is
      // the whole gate, exactly as it is on their actual routes today.
      // CTO ruling B1 (2026-10-08): Organization administration is the Company administration node `core.company.organization.manage` (formerly the workflow rule `core.organization.manage`).
      { to: '/organization', code: 'nav.organization', permissionNode: 'core.company.organization.manage' },
      // F2 (2026-10-07): the Company's own user directory, invitations and roles. `/company/users*` is gated by `core.company.members.manage` (read for the directory, editable for writes) on every route, so nav visibility and route access use the same axis.
      { to: '/company-users', code: 'nav.company_users', permissionNode: 'core.company.members.manage' },
      // F3: roles, templates and capabilities of the Company. Every `/company/roles*` route is gated by `core.company.roles.manage` (read for lists, editable for writes).
      { to: '/company-roles', code: 'nav.company_roles', permissionNode: 'core.company.roles.manage' },
      { to: '/admin', code: 'nav.admin', roles: ['admin'] },
      { to: '/integrations', code: 'nav.integrations', roles: ['admin'] },
      { to: '/release-center', code: 'nav.release_center', roles: ['admin'] },
      // 2026-09-26 — Navigation Root-Cause Fix, Full Closure batch: `approval.controller.ts` carries
      // NO `@RequireModule` (a Core/platform feature, like every other item in this group) and NO
      // `@RequireRole` anywhere (`RolesGuard` is present but configured with zero required roles —
      // verified a no-op: `RolesGuard.canActivate` returns `true` when no role metadata is set). The
      // real, only gate is `PermissionGuard` + `@RequirePermission('core.approval.view'/'.manage')` —
      // `roles: ['admin']` (the old pre-migration precedent) does NOT match this and was rejected.
      { to: '/approvals', code: 'nav.approvals', permissionNode: 'core.approval' },
    ],
  },
];
