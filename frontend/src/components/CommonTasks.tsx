import { Link } from 'react-router-dom';
import { useLanguage } from '../context/LanguageContext';

/**
 * NAV-05 — discoverable entry points for operations that live INSIDE other screens (found by the navigation audit). Each shortcut opens the existing
 * screen that hosts the operation and says, in one line, where the action is once there. No new functionality, no new route.
 */
export const COMMON_TASKS: Array<{ key: string; to: string }> = [
  { key: 'goods_receipt', to: '/purchase-orders' },
  { key: 'supplier_payment', to: '/supplier-invoices' },
  { key: 'customer_payment', to: '/customer-accounts' },
  { key: 'on_account_payment', to: '/customer-accounts' },
  { key: 'invoice_creation', to: '/customer-accounts' },
  { key: 'deposit', to: '/sales-orders' },
  { key: 'treasury_actions', to: '/treasury/ledger' },
  { key: 'new_item_request', to: '/purchase-requests' },
  { key: 'opening_stock', to: '/inventory' },
];

export function CommonTasks() {
  const { t, preload } = useLanguage();
  preload(['panel.common_tasks_title', ...COMMON_TASKS.flatMap((c) => [`task.${c.key}.label`, `task.${c.key}.where`])]);
  return (
    <div className="card" style={{ marginBottom: 20 }} data-testid="common-tasks">
      <h3 style={{ marginTop: 0 }}>{t('panel.common_tasks_title')}</h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10 }}>
        {COMMON_TASKS.map((c) => (
          <Link key={c.key} to={c.to} className="card" style={{ textDecoration: 'none', color: 'inherit', padding: 10 }} data-testid={`task-${c.key}`}>
            <strong>{t(`task.${c.key}.label`)}</strong>
            <div style={{ fontSize: 12, opacity: 0.75, marginTop: 4 }}>{t(`task.${c.key}.where`)}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
