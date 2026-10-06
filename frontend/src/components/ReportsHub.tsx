import { Link } from 'react-router-dom';
import { useLanguage } from '../context/LanguageContext';
import { useVisibleRoutes } from '../lib/navVisibility';

/**
 * NAV-08 — one Reports entry that points at EVERY existing report screen, grouped by category, instead of the sales/operations tabs only. Pure
 * links to existing screens; a link is shown only when the user can reach that screen (same server-driven navigation as the sidebar). No report is added, changed or recalculated.
 */
type Gate = { route: string };
const HUB: Array<{ key: string; titleCode: string; items: Array<{ to: string; labelCode: string; gate: Gate }> }> = [
  {
    key: 'financial',
    titleCode: 'reports_hub.financial',
    items: [
      { to: '/accounting/reports/balance-sheet', labelCode: 'nav.balance_sheet', gate: { route: '/accounting/reports/balance-sheet' } },
      { to: '/accounting/reports/profit-and-loss', labelCode: 'nav.profit_and_loss', gate: { route: '/accounting/reports/profit-and-loss' } },
      { to: '/accounting/reports/cash-flow', labelCode: 'nav.cash_flow', gate: { route: '/accounting/reports/cash-flow' } },
      { to: '/accounting/trial-balance', labelCode: 'nav.trial_balance', gate: { route: '/accounting/trial-balance' } },
      { to: '/accounting/ledger', labelCode: 'nav.general_ledger', gate: { route: '/accounting/ledger' } },
    ],
  },
  {
    key: 'partners',
    titleCode: 'reports_hub.partners',
    items: [
      { to: '/ar-aging', labelCode: 'nav.ar_aging', gate: { route: '/ar-aging' } },
      { to: '/customer-statement', labelCode: 'nav.customer_statement', gate: { route: '/customer-statement' } },
      { to: '/ap-aging', labelCode: 'nav.ap_aging', gate: { route: '/ap-aging' } },
      { to: '/supplier-statement', labelCode: 'nav.supplier_statement', gate: { route: '/supplier-statement' } },
    ],
  },
  {
    key: 'reconciliations',
    titleCode: 'reports_hub.reconciliations',
    items: [
      { to: '/accounting/ar', labelCode: 'nav.ar_reconciliation', gate: { route: '/accounting/ar' } },
      { to: '/accounting/ap', labelCode: 'nav.ap_reconciliation', gate: { route: '/accounting/ap' } },
      { to: '/accounting/cash-bank', labelCode: 'nav.cash_bank_reconciliation', gate: { route: '/accounting/cash-bank' } },
      { to: '/accounting/inventory', labelCode: 'nav.inventory_accounting', gate: { route: '/accounting/inventory' } },
      { to: '/treasury/ledger', labelCode: 'nav.treasury_ledger', gate: { route: '/treasury/ledger' } },
    ],
  },
];

export function ReportsHub() {
  const { t, preload } = useLanguage();
  const visible = useVisibleRoutes();
  preload(['reports_hub.title', ...HUB.flatMap((g) => [g.titleCode, ...g.items.map((i) => i.labelCode)])]);
  if (!visible) return null;
  const allowed = (g: Gate) => visible.has(g.route);
  const groups = HUB.map((g) => ({ ...g, items: g.items.filter((i) => allowed(i.gate)) })).filter((g) => g.items.length > 0);
  if (groups.length === 0) return null;
  return (
    <div className="card" style={{ marginBottom: 20 }} data-testid="reports-hub">
      <h3 style={{ marginTop: 0 }}>{t('reports_hub.title')}</h3>
      {groups.map((g) => (
        <div key={g.key} style={{ marginBottom: 12 }}>
          <strong>{t(g.titleCode)}</strong>
          <div className="section-cover-shortcuts" style={{ marginTop: 6 }}>
            {g.items.map((i) => (
              <Link key={i.to} to={i.to} className="section-cover-shortcut">
                {t(i.labelCode)}
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
