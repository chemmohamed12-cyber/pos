import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { StatusBadge } from '../../components/StatusBadge';

interface SalesOrder {
  id: string;
  orderNumber: string;
  repSequenceNumber: number;
  customerId: string;
  totalAmount: string;
  status: string;
  createdAt: string;
}

interface Customer {
  id: string;
  name: string;
}

interface SalesOrdersPage {
  rows: SalesOrder[];
  total: number;
}

type Bucket = 'draft' | 'supervisor_review' | 'manager_approval' | 'deposit_verification' | 'all';

const PAGE_SIZE = 50;

/**
 * CTO directive — the Sales Orders screen's own dashboard: clickable
 * status tiles (Draft / Supervisor Review / Manager Approval / Deposit
 * Verification), each showing how many orders currently sit there,
 * opening straight into that filtered list on click. Visibility is
 * entirely inherited from `GET /sales-orders` itself (`SalesOrdersService.
 * listOrders`) — a plain sales_rep already gets back only their own
 * orders there, a supervisor/manager/admin gets every order — so these
 * tiles never need their own separate Scope logic, only a client-side
 * group-by-status over whatever the same endpoint already returned.
 *
 * Pagination audit fix (MASTER_PROJECT_STATUS.md §6): the tile counts
 * above and the 4 workflow-queue buckets (draft/supervisor_review/
 * manager_approval/deposit_verification) stay backed by the plain,
 * unpaginated `GET /sales-orders` call — those queues are operationally
 * bounded by design (a healthy pipeline doesn't accumulate thousands of
 * orders sitting in "draft"), and the tile counts need the FULL set to
 * stay accurate. The "all orders" bucket is the one genuinely unbounded
 * view (it only grows), so THAT table is server-paginated via the new
 * `?page=&pageSize=` contract on the same endpoint.
 */
export function SalesOrdersList() {
  const { t, preload } = useLanguage();
  const navigate = useNavigate();
  const [orders, setOrders] = useState<SalesOrder[] | null>(null);
  const [customerNames, setCustomerNames] = useState<Record<string, string>>({});
  const [bucket, setBucket] = useState<Bucket | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [allOrdersPage, setAllOrdersPage] = useState<SalesOrdersPage | null>(null);
  const [page, setPage] = useState(1);

  preload([
    'nav.sales_orders',
    'field.order_number',
    'field.rep_sequence_number',
    'field.customer',
    'field.total_amount',
    'field.status',
    'field.created_at',
    'action.create',
    'panel.no_sales_orders_yet',
    'action.back',
    'field.order_count',
    'action.previous_page',
    'action.next_page',
    'field.page_of_total',
    'sales_order_approval.state.draft',
    'sales_order_approval.state.supervisor_review',
    'sales_order_approval.state.manager_approval',
    'sales_order_approval.state.deposit_verification',
  ]);

  useEffect(() => {
    (async () => {
      try {
        const [ordersData, customersData] = await Promise.all([
          api.get<SalesOrder[]>('/sales-orders'),
          api.get<Customer[]>('/customers'),
        ]);
        setOrders(ordersData);
        setCustomerNames(Object.fromEntries(customersData.map((c) => [c.id, c.name])));
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Failed to load sales orders.');
      }
    })();
  }, []);

  // The "all" bucket is the genuinely unbounded view — server-paginated,
  // fetched separately from the tile-count/queue-bucket data above.
  useEffect(() => {
    if (bucket !== 'all') return;
    (async () => {
      try {
        const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
        const result = await api.get<SalesOrdersPage>(`/sales-orders?${params.toString()}`);
        setAllOrdersPage(result);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Failed to load sales orders.');
      }
    })();
  }, [bucket, page]);

  const TILES: Array<{ key: Bucket; labelKey: string }> = [
    { key: 'draft', labelKey: 'sales_order_approval.state.draft' },
    { key: 'supervisor_review', labelKey: 'sales_order_approval.state.supervisor_review' },
    { key: 'manager_approval', labelKey: 'sales_order_approval.state.manager_approval' },
    { key: 'deposit_verification', labelKey: 'sales_order_approval.state.deposit_verification' },
  ];

  const countFor = (b: Bucket) => (orders ? orders.filter((o) => o.status === b).length : 0);
  const visibleOrders =
    bucket === 'all' ? allOrdersPage?.rows ?? [] : orders && bucket ? orders.filter((o) => o.status === bucket) : [];
  const totalPages = useMemo(
    () => (allOrdersPage ? Math.max(1, Math.ceil(allOrdersPage.total / PAGE_SIZE)) : 1),
    [allOrdersPage],
  );

  function selectBucket(b: Bucket) {
    setBucket(b);
    if (b === 'all') setPage(1);
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.sales_orders')}</h1>
        <button className="btn btn-primary" onClick={() => navigate('/sales-orders/new')}>
          {t('action.create')}
        </button>
      </div>

      {error && <div className="error-text">{error}</div>}

      {bucket !== null && (
        <button className="btn btn-secondary" style={{ marginBottom: 16 }} onClick={() => setBucket(null)}>
          {t('action.back')}
        </button>
      )}

      {orders === null ? (
        <div className="empty-state">Loading…</div>
      ) : bucket === null ? (
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 24 }}>
          {TILES.map((tile) => (
            <button
              key={tile.key}
              className="card"
              style={{ minWidth: 180, textAlign: 'center', cursor: 'pointer', border: 'none' }}
              onClick={() => selectBucket(tile.key)}
            >
              <div style={{ fontSize: '2rem', fontWeight: 700 }}>{countFor(tile.key)}</div>
              <div style={{ color: '#6b7280' }}>{t(tile.labelKey)}</div>
            </button>
          ))}
          <button
            className="card"
            style={{ minWidth: 180, textAlign: 'center', cursor: 'pointer', border: 'none' }}
            onClick={() => selectBucket('all')}
          >
            <div style={{ fontSize: '2rem', fontWeight: 700 }}>{orders.length}</div>
            <div style={{ color: '#6b7280' }}>{t('field.order_count')}</div>
          </button>
        </div>
      ) : bucket === 'all' && allOrdersPage === null ? (
        <div className="empty-state">Loading…</div>
      ) : visibleOrders.length === 0 ? (
        <div className="empty-state">{t('panel.no_sales_orders_yet')}</div>
      ) : (
        <>
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.order_number')}</th>
              <th>{t('field.rep_sequence_number')}</th>
              <th>{t('field.customer')}</th>
              <th>{t('field.total_amount')}</th>
              <th>{t('field.status')}</th>
              <th>{t('field.created_at')}</th>
            </tr>
          </thead>
          <tbody>
            {visibleOrders.map((o) => (
              <tr key={o.id} onClick={() => navigate(`/sales-orders/${o.id}`)}>
                <td>{o.orderNumber}</td>
                <td>{o.repSequenceNumber}</td>
                <td>{customerNames[o.customerId] ?? '—'}</td>
                <td>{o.totalAmount}</td>
                <td>
                  <StatusBadge code={`sales_order_approval.state.${o.status}`} />
                </td>
                <td>{new Date(o.createdAt).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {bucket === 'all' && (
          <div className="action-row" style={{ marginTop: 14, alignItems: 'center' }}>
            <button className="btn btn-secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              {t('action.previous_page')}
            </button>
            <span style={{ fontSize: '0.85rem', color: '#6b7280' }}>
              {t('field.page_of_total').replace('{page}', String(page)).replace('{total}', String(totalPages))}
            </span>
            <button className="btn btn-secondary" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
              {t('action.next_page')}
            </button>
          </div>
        )}
        </>
      )}
    </div>
  );
}
