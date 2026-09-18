import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import './Layout.css';

interface NavItem {
  to: string;
  code: string;
  roles?: string[];
}
interface NavGroup {
  code: string; // section header terminology code, or '' for the standalone top-level item
  items: NavItem[];
  /** CTO directive ("Section Cover / Main Dashboard System") — the group header itself links to this section's Cover page, not just a toggle. */
  coverTo?: string;
}

/**
 * Warehouse & Inventory Control UX/UI V1 (CTO directive §3) — a
 * collapsible, grouped ERP-style sidebar instead of one flat list.
 * Groups persist their collapsed/expanded state per-browser
 * (localStorage) so a user's layout preference survives a reload.
 */
const NAV_GROUPS: NavGroup[] = [
  { code: '', items: [{ to: '/', code: 'nav.dashboard' }] },
  {
    code: 'nav_group.sales',
    coverTo: '/sales',
    items: [
      { to: '/customers', code: 'nav.customers' },
      { to: '/sales-orders', code: 'nav.sales_orders' },
      { to: '/returns', code: 'nav.returns' },
      { to: '/sales-returns', code: 'nav.sales_returns' },
    ],
  },
  {
    // Sidebar Information Architecture update (2026-09-18) — Catalog ("الأصناف
    // والأسعار") and Production/Fulfillment ("التجهيز") are no longer their own
    // top-level sections; their existing items are regrouped here, in front of
    // (Catalog) and behind (Fulfillment) the original Warehouses items, per the
    // requested Master Data -> Inventory -> Preparation flow. No route, page,
    // permission, or business logic changed — `/catalog` and `/fulfillment-overview`
    // (their former Cover pages) still exist and still work, just without their
    // own sidebar group header.
    code: 'nav_group.warehouses',
    coverTo: '/warehouse-overview',
    items: [
      { to: '/products', code: 'nav.products' },
      { to: '/price-lists', code: 'nav.price_lists', roles: ['admin', 'sales_manager'] },
      { to: '/bom', code: 'nav.bom', roles: ['admin'] },
      { to: '/warehouse-overview', code: 'nav.warehouse_overview', roles: ['warehouse_worker', 'warehouse_supervisor', 'inventory_controller', 'admin'] },
      { to: '/shipments', code: 'nav.shipments', roles: ['warehouse_worker', 'admin'] },
      { to: '/warehouses', code: 'nav.warehouses', roles: ['warehouse_worker', 'warehouse_supervisor', 'inventory_controller'] },
      { to: '/movement-center', code: 'nav.movement_center', roles: ['warehouse_worker', 'warehouse_supervisor', 'inventory_controller'] },
      { to: '/inventory', code: 'nav.inventory', roles: ['warehouse_worker', 'warehouse_supervisor', 'inventory_controller'] },
      { to: '/stock-count', code: 'nav.stock_count', roles: ['warehouse_worker', 'warehouse_supervisor', 'inventory_controller'] },
      { to: '/fulfillment', code: 'nav.fulfillment', roles: ['warehouse_worker'] },
    ],
  },
  {
    code: 'nav_group.shipping',
    coverTo: '/shipping',
    items: [
      { to: '/shipments', code: 'nav.shipments', roles: ['driver', 'warehouse_worker'] },
      { to: '/shipping-methods', code: 'nav.shipping_methods', roles: ['admin'] },
      { to: '/custody-returns', code: 'nav.custody_returns', roles: ['admin', 'warehouse_worker', 'sales_supervisor'] },
      { to: '/shipment-returns', code: 'nav.shipment_returns', roles: ['admin', 'warehouse_worker'] },
      { to: '/collection-settlements', code: 'nav.collection_settlements', roles: ['admin', 'finance'] },
    ],
  },
  {
    code: 'nav_group.customers_accounts',
    coverTo: '/customers-accounts',
    items: [
      { to: '/customers', code: 'nav.customers' },
      { to: '/customer-accounts', code: 'nav.customer_accounts' },
      { to: '/customer-statement', code: 'nav.customer_statement' },
      { to: '/invoices', code: 'nav.invoices' },
      { to: '/payments', code: 'nav.payments' },
      { to: '/ar-aging', code: 'nav.ar_aging' },
    ],
  },
  {
    // Sidebar Information Architecture update (2026-09-18) — "المشتريات"
    // position 5 in the requested main sequence. Moved ahead of Treasury;
    // content/routes/roles unchanged.
    code: 'nav_group.procurement',
    items: [
      { to: '/suppliers', code: 'nav.suppliers', roles: ['admin', 'finance'] },
      { to: '/purchase-requests', code: 'nav.purchase_requests', roles: ['admin', 'finance'] },
      { to: '/rfqs', code: 'nav.rfqs', roles: ['admin', 'finance'] },
      { to: '/purchase-orders', code: 'nav.purchase_orders', roles: ['admin', 'finance'] },
      { to: '/supplier-invoices', code: 'nav.supplier_invoices', roles: ['admin', 'finance'] },
      { to: '/supplier-statement', code: 'nav.supplier_statement', roles: ['admin', 'finance'] },
      { to: '/ap-aging', code: 'nav.ap_aging', roles: ['admin', 'finance'] },
    ],
  },
  {
    // Not part of the requested 9-section sequence, but existing, working
    // functionality the request says to preserve ("مع الحفاظ على أي أقسام
    // أخرى موجودة حاليًا إذا كانت مطلوبة وظيفيًا") — kept as its own section,
    // placed ahead of Accounting since Treasury/cash movements feed the GL.
    code: 'nav_group.treasury',
    coverTo: '/treasury',
    items: [
      { to: '/treasury/accounts', code: 'nav.treasury_accounts', roles: ['admin', 'finance'] },
      { to: '/treasury/ledger', code: 'nav.treasury_ledger', roles: ['admin', 'finance'] },
    ],
  },
  {
    code: 'module.accounting',
    coverTo: '/accounting',
    items: [
      { to: '/accounting/chart-of-accounts', code: 'nav.chart_of_accounts', roles: ['admin'] },
      { to: '/accounting/journals', code: 'nav.journals', roles: ['admin'] },
      { to: '/accounting/ledger', code: 'nav.general_ledger', roles: ['admin'] },
      { to: '/accounting/trial-balance', code: 'nav.trial_balance', roles: ['admin'] },
      { to: '/accounting/financial-events', code: 'nav.financial_events', roles: ['admin'] },
      { to: '/accounting/ar', code: 'nav.ar_reconciliation', roles: ['admin'] },
      { to: '/accounting/ap', code: 'nav.ap_reconciliation', roles: ['admin'] },
      { to: '/accounting/cash-bank', code: 'nav.cash_bank_reconciliation', roles: ['admin'] },
      { to: '/accounting/fixed-assets', code: 'nav.fixed_assets', roles: ['admin'] },
      { to: '/accounting/inventory', code: 'nav.inventory_accounting', roles: ['admin'] },
      { to: '/accounting/dimensions', code: 'nav.dimensions', roles: ['admin'] },
      { to: '/accounting/settings', code: 'nav.accounting_settings', roles: ['admin'] },
      { to: '/accounting/reports/balance-sheet', code: 'nav.balance_sheet', roles: ['admin'] },
      { to: '/accounting/reports/profit-and-loss', code: 'nav.profit_and_loss', roles: ['admin'] },
      { to: '/accounting/reports/cash-flow', code: 'nav.cash_flow', roles: ['admin'] },
    ],
  },
  {
    code: 'module.hr',
    coverTo: '/hr',
    items: [
      { to: '/hr/employees', code: 'nav.hr_employees', roles: ['admin'] },
      { to: '/hr/departments', code: 'nav.hr_departments', roles: ['admin'] },
    ],
  },
  { code: '', items: [{ to: '/reports-overview', code: 'nav.reports' }] },
  {
    code: 'nav_group.administration',
    coverTo: '/administration',
    items: [
      { to: '/organization', code: 'nav.organization', roles: ['admin'] },
      { to: '/admin', code: 'nav.admin', roles: ['admin'] },
      { to: '/approvals', code: 'nav.approvals', roles: ['admin'] },
      { to: '/integrations', code: 'nav.integrations', roles: ['admin'] },
    ],
  },
];

const ALL_CODES = NAV_GROUPS.flatMap((g) => [g.code, ...g.items.map((i) => i.code)]).filter(Boolean);

/** Accordion: at most one group open at a time — opening one closes any other, avoiding the crowded all-expanded sidebar. */
function loadOpenGroup(): string | null {
  try {
    return localStorage.getItem('daii_nav_open_group') || null;
  } catch {
    return null;
  }
}

export function Layout() {
  const { user, logout, hasRole } = useAuth();
  const { lang, setLang, t, preload } = useLanguage();
  const [openGroup, setOpenGroup] = useState<string | null>(loadOpenGroup);

  preload(ALL_CODES);

  function toggleGroup(code: string) {
    setOpenGroup((prev) => {
      const next = prev === code ? null : code;
      localStorage.setItem('daii_nav_open_group', next ?? '');
      return next;
    });
  }

  // Used by the section title's own Cover-page link: navigating there should
  // always reveal its children too, never collapse them (unlike the chevron
  // toggle / header-row click, which do toggle open<->closed).
  function expandGroup(code: string) {
    setOpenGroup(code);
    localStorage.setItem('daii_nav_open_group', code);
  }

  const visibleGroups = NAV_GROUPS.map((g) => ({ ...g, items: g.items.filter((item) => !item.roles || hasRole(...item.roles)) })).filter(
    (g) => g.items.length > 0,
  );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">Daii</div>
        <nav>
          {visibleGroups.map((group, i) =>
            group.code === '' ? (
              group.items.map((item) => (
                <NavLink key={item.to} to={item.to} end={item.to === '/'} className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}>
                  {t(item.code)}
                </NavLink>
              ))
            ) : (
              <div key={group.code || i} className={`nav-section${openGroup === group.code ? ' expanded' : ''}`}>
                <div
                  className="nav-section-header"
                  onClick={(e) => {
                    // The title text still links to the section's Cover page (CTO
                    // directive), and the chevron button has its own handler — only
                    // expand/collapse here when the click landed elsewhere on the row.
                    if ((e.target as HTMLElement).closest('a, button')) return;
                    toggleGroup(group.code);
                  }}
                >
                  {group.coverTo ? (
                    <NavLink to={group.coverTo} className="nav-section-header-title" onClick={() => expandGroup(group.code)}>
                      {t(group.code)}
                    </NavLink>
                  ) : (
                    <span className="nav-section-header-title">{t(group.code)}</span>
                  )}
                  <button className="nav-chevron-btn" onClick={() => toggleGroup(group.code)} aria-label={t(group.code)}>
                    <span className={`nav-chevron ${openGroup === group.code ? '' : 'collapsed'}`}>▾</span>
                  </button>
                </div>
                {openGroup === group.code && (
                  <div className="nav-section-items">
                    {group.items.map((item) => (
                      <NavLink key={item.to} to={item.to} className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}>
                        {t(item.code)}
                      </NavLink>
                    ))}
                  </div>
                )}
              </div>
            ),
          )}
        </nav>
      </aside>
      <div className="main-column">
        <header className="topbar">
          <div className="topbar-user">
            {user && (
              <>
                <span className="user-name">{user.fullName}</span>
                <span className="user-roles">{user.roles.map((r) => t(`role.${r}`)).join(', ')}</span>
              </>
            )}
          </div>
          <div className="topbar-actions">
            <button className="lang-toggle" onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')}>
              {lang === 'ar' ? 'EN' : 'ع'}
            </button>
            <button className="logout-btn" onClick={logout}>
              {t('action.logout')}
            </button>
          </div>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
