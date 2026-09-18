import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { SectionCover } from '../../components/SectionCover';
import { MiniBarChart } from '../../components/MiniBarChart';

interface SalesOrder {
  status: string;
}
interface SalesOrderReportRow {
  createdAt: string;
  status: string;
  totalAmount: string;
  depositStatus: string | null;
}
interface SalesByRepRow {
  salesRepUserId: string;
  salesRepName: string;
  orderCount: number;
  totalAmount: string;
}

const OPEN_ORDER_STATES = ['draft', 'supervisor_review', 'manager_approval', 'pending_resubmission', 'deposit_verification'];

/** CTO directive ("Section Cover / Main Dashboard System") — the Sales section's own landing page: same real KPIs `Dashboard.tsx` already computes, scoped to Sales, plus a top-reps breakdown. */
export function SalesCover() {
  const { t, preload } = useLanguage();
  const [kpis, setKpis] = useState<{ open: number; released: number; pendingDeposits: number; monthTotal: string } | null>(null);
  const [topReps, setTopReps] = useState<SalesByRepRow[]>([]);

  preload([
    'nav_group.sales',
    'nav.customers',
    'nav.sales_orders',
    'nav.returns',
    'panel.awaiting_fulfillment',
    'field.deposit_status',
    'field.month_sales_total',
    'field.sales_by_rep',
  ]);

  useEffect(() => {
    (async () => {
      const [orders, salesOrdersReport, byRep] = await Promise.all([
        api.get<SalesOrder[]>('/sales-orders'),
        api.get<SalesOrderReportRow[]>('/reports/sales-orders'),
        api.get<SalesByRepRow[]>('/reports/sales-by-rep'),
      ]);
      const thisMonth = new Date().toISOString().slice(0, 7);
      const thisMonthOrders = salesOrdersReport.filter((r) => r.createdAt.slice(0, 7) === thisMonth);
      setKpis({
        open: orders.filter((o) => OPEN_ORDER_STATES.includes(o.status)).length,
        released: orders.filter((o) => o.status === 'released').length,
        pendingDeposits: salesOrdersReport.filter((r) => r.status === 'deposit_verification' || r.depositStatus === 'submitted').length,
        monthTotal: thisMonthOrders.reduce((sum, r) => sum + Number(r.totalAmount), 0).toFixed(2),
      });
      setTopReps([...byRep].sort((a, b) => Number(b.totalAmount) - Number(a.totalAmount)).slice(0, 5));
    })();
  }, []);

  return (
    <SectionCover
      titleCode="nav_group.sales"
      shortcuts={[
        { to: '/customers', labelCode: 'nav.customers' },
        { to: '/sales-orders', labelCode: 'nav.sales_orders' },
        { to: '/returns', labelCode: 'nav.returns' },
      ]}
      kpis={
        kpis
          ? [
              { labelCode: 'field.month_sales_total', value: kpis.monthTotal, to: '/reports' },
              { labelCode: 'nav.sales_orders', value: kpis.open, to: '/sales-orders' },
              { labelCode: 'panel.awaiting_fulfillment', value: kpis.released, to: '/sales-orders' },
              { labelCode: 'field.deposit_status', value: kpis.pendingDeposits, to: '/sales-orders', tone: kpis.pendingDeposits > 0 ? 'warning' : 'default' },
            ]
          : undefined
      }
    >
      {topReps.length > 0 && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>{t('field.sales_by_rep')}</h3>
          <MiniBarChart data={topReps.map((r) => ({ label: r.salesRepName, value: Number(r.totalAmount) }))} formatValue={(v) => v.toFixed(2)} />
        </div>
      )}
    </SectionCover>
  );
}
