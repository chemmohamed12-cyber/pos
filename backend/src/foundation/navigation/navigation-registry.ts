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
}

export interface NavGroup {
  /** Section header terminology code, or '' for a standalone top-level item. */
  code: string;
  items: NavItem[];
  /** The group header itself links here (CTO directive — "Section Cover / Main Dashboard System"). */
  coverTo?: string;
}

export const NAVIGATION_REGISTRY: NavGroup[] = [
  { code: '', items: [{ to: '/', code: 'nav.dashboard' }] },
  {
    code: 'nav_group.sales',
    coverTo: '/sales',
    items: [
      { to: '/customers', code: 'nav.customers', module: 'sales' },
      { to: '/sales-orders', code: 'nav.sales_orders', module: 'sales' },
      { to: '/returns', code: 'nav.returns', module: 'logistics' },
    ],
  },
  {
    code: 'nav_group.warehouses',
    coverTo: '/warehouse-overview',
    items: [
      { to: '/warehouse-overview', code: 'nav.warehouse_overview', module: 'inventory', roles: ['warehouse_worker', 'warehouse_supervisor', 'inventory_controller', 'admin'] },
      { to: '/warehouses', code: 'nav.warehouses', module: 'inventory', roles: ['warehouse_worker', 'warehouse_supervisor', 'inventory_controller'] },
      { to: '/movement-center', code: 'nav.movement_center', module: 'inventory', roles: ['warehouse_worker', 'warehouse_supervisor', 'inventory_controller'] },
      { to: '/inventory', code: 'nav.inventory', module: 'inventory', roles: ['warehouse_worker', 'warehouse_supervisor', 'inventory_controller'] },
      { to: '/stock-count', code: 'nav.stock_count', module: 'inventory', roles: ['warehouse_worker', 'warehouse_supervisor', 'inventory_controller'] },
    ],
  },
  {
    code: 'nav_group.production',
    coverTo: '/fulfillment-overview',
    items: [{ to: '/fulfillment', code: 'nav.fulfillment', module: 'inventory', roles: ['warehouse_worker'] }],
  },
  {
    code: 'nav_group.shipping',
    coverTo: '/shipping',
    items: [
      { to: '/shipments', code: 'nav.shipments', module: 'logistics', roles: ['driver'] },
      { to: '/shipping-methods', code: 'nav.shipping_methods', module: 'logistics', roles: ['admin'] },
      { to: '/custody-returns', code: 'nav.custody_returns', module: 'logistics', roles: ['admin', 'warehouse_worker', 'sales_supervisor'] },
      { to: '/collection-settlements', code: 'nav.collection_settlements', module: 'logistics', roles: ['admin', 'finance'] },
    ],
  },
  {
    code: 'nav_group.customers_accounts',
    coverTo: '/customers-accounts',
    items: [
      { to: '/customers', code: 'nav.customers', module: 'sales' },
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
      { to: '/price-lists', code: 'nav.price_lists', module: 'sales', roles: ['admin', 'sales_manager'] },
      { to: '/bom', code: 'nav.bom', module: 'sales', roles: ['admin'] },
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
    coverTo: '/accounting/chart-of-accounts',
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
    code: 'nav_group.administration',
    coverTo: '/administration',
    items: [
      // No `module` — these are Core/platform routes (foundation/organization,
      // foundation/admin, foundation/integrations, foundation/release),
      // not part of any of the 5 V1 business modules. Core is always
      // present (ADR-023 — "core is implicit and never listed" in
      // depends_on), so entitlement never restricts these; `roles` is
      // the whole gate, exactly as it is on their actual routes today.
      { to: '/organization', code: 'nav.organization', roles: ['admin'] },
      { to: '/admin', code: 'nav.admin', roles: ['admin'] },
      { to: '/integrations', code: 'nav.integrations', roles: ['admin'] },
      { to: '/release-center', code: 'nav.release_center', roles: ['admin'] },
    ],
  },
];
