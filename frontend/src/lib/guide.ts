import { api } from './api';

/**
 * NAV-01 / NAV-09 — Setup & Process Guidance. A light, status-aware layer ON TOP of the existing navigation (the sidebar is untouched): the order in
 * which a Company is normally set up, and the main end-to-end process chains, every step linking to an EXISTING screen. Status is read from the
 * existing list endpoints under the user's own permissions; a source the user may not read shows no status (never an error, never a guess).
 */
export interface GuideStep {
  /** terminology code of the label (reuses the existing nav.* codes wherever one exists) */
  labelCode: string;
  to: string;
  /** optional existing list endpoint whose non-empty result means the step is "done" */
  check?: string;
}

export const SETUP_STAGES: Array<{ key: string; titleCode: string; steps: GuideStep[] }> = [
  {
    key: 'foundation',
    titleCode: 'guide.stage.foundation',
    steps: [
      { labelCode: 'nav.organization', to: '/organization', check: '/organization/units' },
      { labelCode: 'nav.warehouses', to: '/warehouses', check: '/inventory/warehouses' },
      { labelCode: 'nav.admin', to: '/admin', check: '/admin/users' },
    ],
  },
  {
    key: 'accounting',
    titleCode: 'guide.stage.accounting',
    steps: [
      { labelCode: 'nav.chart_of_accounts', to: '/accounting/chart-of-accounts', check: '/accounting/accounts' },
      { labelCode: 'nav.accounting_policy', to: '/accounting/policy' },
      { labelCode: 'nav.fiscal_periods', to: '/accounting/fiscal-periods', check: '/accounting/fiscal-years' },
      { labelCode: 'nav.accounting_settings', to: '/accounting/settings' },
      { labelCode: 'nav.dimensions', to: '/accounting/dimensions' },
    ],
  },
  { key: 'treasury', titleCode: 'guide.stage.treasury', steps: [{ labelCode: 'nav.treasury_settings', to: '/treasury/settings', check: '/treasury/accounts' }] },
  {
    key: 'master_data',
    titleCode: 'guide.stage.master_data',
    steps: [
      { labelCode: 'nav.suppliers', to: '/suppliers', check: '/procurement/suppliers/all' },
      { labelCode: 'nav.customers', to: '/customers', check: '/customers' },
      { labelCode: 'nav.products', to: '/products', check: '/products/all' },
      { labelCode: 'nav.price_lists', to: '/price-lists', check: '/price-lists' },
    ],
  },
  {
    key: 'operations',
    titleCode: 'guide.stage.operations',
    steps: [
      { labelCode: 'nav.purchase_requests', to: '/purchase-requests' },
      { labelCode: 'nav.sales_orders', to: '/sales-orders' },
      { labelCode: 'nav.movement_center', to: '/movement-center' },
    ],
  },
  {
    key: 'control',
    titleCode: 'guide.stage.control',
    steps: [
      { labelCode: 'nav.approvals', to: '/approvals', check: '/approvals/matrix-rules' },
      { labelCode: 'nav.pending_work', to: '/pending-work' },
      { labelCode: 'nav.financial_events', to: '/accounting/financial-events' },
    ],
  },
  {
    key: 'reports',
    titleCode: 'guide.stage.reports',
    steps: [
      { labelCode: 'nav.reports', to: '/reports-overview' },
      { labelCode: 'nav.trial_balance', to: '/accounting/trial-balance' },
      { labelCode: 'nav.balance_sheet', to: '/accounting/reports/balance-sheet' },
    ],
  },
];

export const PROCESS_FLOWS: Array<{ key: string; titleCode: string; steps: GuideStep[] }> = [
  {
    key: 'procurement',
    titleCode: 'guide.flow.procurement',
    steps: [
      { labelCode: 'nav.suppliers', to: '/suppliers' },
      { labelCode: 'nav.purchase_requests', to: '/purchase-requests' },
      { labelCode: 'nav.rfqs', to: '/rfqs' },
      { labelCode: 'guide.step.award', to: '/rfqs' },
      { labelCode: 'nav.purchase_orders', to: '/purchase-orders' },
      { labelCode: 'guide.step.goods_receipt', to: '/purchase-orders' },
      { labelCode: 'nav.supplier_invoices', to: '/supplier-invoices' },
      { labelCode: 'guide.step.supplier_payment', to: '/supplier-invoices' },
    ],
  },
  {
    key: 'sales',
    titleCode: 'guide.flow.sales',
    steps: [
      { labelCode: 'nav.customers', to: '/customers' },
      { labelCode: 'guide.step.product_price', to: '/price-lists' },
      { labelCode: 'nav.sales_orders', to: '/sales-orders' },
      { labelCode: 'nav.fulfillment', to: '/fulfillment' },
      { labelCode: 'nav.shipments', to: '/shipments' },
      { labelCode: 'nav.invoices', to: '/invoices' },
      { labelCode: 'nav.payments', to: '/payments' },
    ],
  },
  {
    key: 'inventory',
    titleCode: 'guide.flow.inventory',
    steps: [
      { labelCode: 'nav.products', to: '/products' },
      { labelCode: 'nav.warehouses', to: '/warehouses' },
      { labelCode: 'guide.step.stock', to: '/inventory' },
      { labelCode: 'nav.movement_center', to: '/movement-center' },
      { labelCode: 'nav.stock_count', to: '/stock-count' },
      { labelCode: 'guide.step.reconciliation', to: '/accounting/inventory' },
    ],
  },
];

/** done / todo / unknown (not permitted or unavailable) for every step that declares a check, keyed by endpoint. */
export async function loadStepStatus(): Promise<Record<string, 'done' | 'todo' | 'unknown'>> {
  const endpoints = [...new Set(SETUP_STAGES.flatMap((s) => s.steps.map((x) => x.check)).filter((c): c is string => !!c))];
  const out: Record<string, 'done' | 'todo' | 'unknown'> = {};
  await Promise.all(
    endpoints.map(async (e) => {
      try {
        const r = await api.get<unknown>(e);
        out[e] = Array.isArray(r) ? (r.length > 0 ? 'done' : 'todo') : 'unknown';
      } catch {
        out[e] = 'unknown';
      }
    }),
  );
  return out;
}

/** The accounting-policy step is "done" only when every managed key is configured (status comes from the NAV-02 endpoint). */
export async function loadPolicyProgress(): Promise<{ ok: number; total: number } | null> {
  try {
    const keys = await api.get<Array<{ status: string }>>('/accounting/policy-config');
    return Array.isArray(keys) ? { ok: keys.filter((k) => k.status === 'ok').length, total: keys.length } : null;
  } catch {
    return null;
  }
}
