import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { api } from '../lib/api';
import { CommonTasks } from '../components/CommonTasks';
import { DashboardSections } from '../components/DashboardSections';
import { usePendingSources } from '../lib/pendingWork';
import { roleLabel } from '../lib/displayNames';

interface SalesOrder {
  id: string;
  status: string;
}
interface Task {
  state: string;
}
interface ReturnRequest {
  state: string;
}
interface Shipment {
  state: string;
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
const OPEN_TASK_STATES = ['assigned', 'accepted', 'in_progress', 'pending_verification'];
const OPEN_RETURN_STATES = ['requested', 'authorized', 'received', 'inspected'];
const IN_TRANSIT_SHIPMENT_STATES = ['picked_up', 'in_transit', 'out_for_delivery'];

interface Summary {
  ordersOpen: number;
  ordersReleased: number;
  pickTasksOpen: number;
  packTasksOpen: number;
  returnsOpen: number;
  shipmentsInTransit: number;
  pendingDeposits: number;
  monthSalesTotal: string;
  monthOrderCount: number;
}

export function Dashboard() {
  const { user } = useAuth();
  const { t, preload } = useLanguage();
  const pendingSources = usePendingSources();
  const pendingTotal = pendingSources ? pendingSources.reduce((sum, p) => sum + p.count, 0) : null;
  const [summary, setSummary] = useState<Summary | null>(null);
  const [topReps, setTopReps] = useState<SalesByRepRow[]>([]);

  preload([
    'nav.pending_work',
    'nav.customers',
    'nav.sales_orders',
    'nav.returns',
    'nav.fulfillment',
    'nav.shipments',
    'nav.reports',
    'panel.pick_tasks',
    'panel.pack_tasks',
    'panel.awaiting_fulfillment',
    'field.deposit_status',
    'field.sales_by_rep',
    'field.total_amount',
    'field.month_sales_total',
    'field.order_count',
  ]);

  useEffect(() => {
    (async () => {
      const [orders, pickTasks, packTasks, returns, shipments, salesOrdersReport, byRep] = await Promise.all([
        api.get<SalesOrder[]>('/sales-orders'),
        api.get<Task[]>('/fulfillment/pick-tasks'),
        api.get<Task[]>('/fulfillment/pack-tasks'),
        api.get<ReturnRequest[]>('/returns'),
        api.get<Shipment[]>('/shipments'),
        api.get<SalesOrderReportRow[]>('/reports/sales-orders'),
        api.get<SalesByRepRow[]>('/reports/sales-by-rep'),
      ]);

      const thisMonth = new Date().toISOString().slice(0, 7);
      const thisMonthOrders = salesOrdersReport.filter((r) => r.createdAt.slice(0, 7) === thisMonth);

      setSummary({
        ordersOpen: orders.filter((o) => OPEN_ORDER_STATES.includes(o.status)).length,
        ordersReleased: orders.filter((o) => o.status === 'released').length,
        pickTasksOpen: pickTasks.filter((p) => OPEN_TASK_STATES.includes(p.state)).length,
        packTasksOpen: packTasks.filter((p) => OPEN_TASK_STATES.includes(p.state)).length,
        returnsOpen: returns.filter((r) => OPEN_RETURN_STATES.includes(r.state)).length,
        shipmentsInTransit: shipments.filter((s) => IN_TRANSIT_SHIPMENT_STATES.includes(s.state)).length,
        pendingDeposits: salesOrdersReport.filter((r) => r.status === 'deposit_verification' || r.depositStatus === 'submitted').length,
        monthSalesTotal: thisMonthOrders.reduce((sum, r) => sum + Number(r.totalAmount), 0).toFixed(2),
        monthOrderCount: thisMonthOrders.length,
      });
      setTopReps([...byRep].sort((a, b) => Number(b.totalAmount) - Number(a.totalAmount)).slice(0, 5));
    })();
  }, []);

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.dashboard')}</h1>
      </div>
      <div className="card" style={{ marginBottom: 20 }}>
        <p style={{ margin: 0 }}>
          {user ? `${user.fullName} — ${user.roles.map((r) => roleLabel(t, r)).join(', ')}` : ''}
        </p>
      </div>

      {pendingTotal !== null && (
        <Link to="/pending-work" className="card" style={{ display: 'block', marginBottom: 20, textDecoration: 'none', color: 'inherit' }} data-testid="dashboard-pending-work">
          <strong>{t('nav.pending_work')}</strong>: <span style={{ fontSize: '1.4rem' }}>{pendingTotal}</span>
        </Link>
      )}

      <DashboardSections />

      <CommonTasks />

      {summary && (
        <>
          <div className="detail-grid" style={{ marginBottom: 20 }}>
            <Link to="/reports" className="card detail-field" style={{ textDecoration: 'none', color: 'inherit' }}>
              <div className="label">{t('field.month_sales_total')}</div>
              <div className="value" style={{ fontSize: '1.6rem' }}>{summary.monthSalesTotal}</div>
            </Link>
            <Link to="/sales-orders" className="card detail-field" style={{ textDecoration: 'none', color: 'inherit' }}>
              <div className="label">{t('nav.sales_orders')}</div>
              <div className="value" style={{ fontSize: '1.6rem' }}>{summary.ordersOpen}</div>
            </Link>
            <Link to="/sales-orders" className="card detail-field" style={{ textDecoration: 'none', color: 'inherit' }}>
              <div className="label">{t('panel.awaiting_fulfillment')}</div>
              <div className="value" style={{ fontSize: '1.6rem' }}>{summary.ordersReleased}</div>
            </Link>
            <Link to="/sales-orders" className="card detail-field" style={{ textDecoration: 'none', color: 'inherit' }}>
              <div className="label">{t('field.deposit_status')}</div>
              <div className="value" style={{ fontSize: '1.6rem' }}>{summary.pendingDeposits}</div>
            </Link>
          </div>

          <div className="detail-grid" style={{ marginBottom: 20 }}>
            <Link to="/fulfillment" className="card detail-field" style={{ textDecoration: 'none', color: 'inherit' }}>
              <div className="label">{t('panel.pick_tasks')}</div>
              <div className="value" style={{ fontSize: '1.6rem' }}>{summary.pickTasksOpen}</div>
            </Link>
            <Link to="/fulfillment" className="card detail-field" style={{ textDecoration: 'none', color: 'inherit' }}>
              <div className="label">{t('panel.pack_tasks')}</div>
              <div className="value" style={{ fontSize: '1.6rem' }}>{summary.packTasksOpen}</div>
            </Link>
            <Link to="/shipments" className="card detail-field" style={{ textDecoration: 'none', color: 'inherit' }}>
              <div className="label">{t('nav.shipments')}</div>
              <div className="value" style={{ fontSize: '1.6rem' }}>{summary.shipmentsInTransit}</div>
            </Link>
            <Link to="/returns" className="card detail-field" style={{ textDecoration: 'none', color: 'inherit' }}>
              <div className="label">{t('nav.returns')}</div>
              <div className="value" style={{ fontSize: '1.6rem' }}>{summary.returnsOpen}</div>
            </Link>
          </div>
        </>
      )}

      {topReps.length > 0 && (
        <div className="card" style={{ marginBottom: 20 }}>
          <h3 style={{ marginTop: 0 }}>{t('field.sales_by_rep')}</h3>
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('role.sales_rep')}</th>
                <th>{t('field.order_count')}</th>
                <th>{t('field.total_amount')}</th>
              </tr>
            </thead>
            <tbody>
              {topReps.map((r) => (
                <tr key={r.salesRepUserId}>
                  <td>{r.salesRepName}</td>
                  <td>{r.orderCount}</td>
                  <td>{r.totalAmount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <div className="action-row" style={{ marginTop: 0 }}>
          <Link className="btn btn-secondary" to="/sales-orders">
            {t('nav.sales_orders')}
          </Link>
          <Link className="btn btn-secondary" to="/customers">
            {t('nav.customers')}
          </Link>
          <Link className="btn btn-secondary" to="/returns">
            {t('nav.returns')}
          </Link>
          <Link className="btn btn-secondary" to="/reports">
            {t('nav.reports')}
          </Link>
        </div>
      </div>
    </div>
  );
}
