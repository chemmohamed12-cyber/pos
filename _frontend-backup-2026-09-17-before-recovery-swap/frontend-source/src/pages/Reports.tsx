import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError, getAccessToken } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { StatusBadge } from '../components/StatusBadge';

interface SalesOrderReportRow {
  id: string;
  orderNumber: string;
  createdAt: string;
  customerId: string;
  customerName: string;
  salesRepUserId: string;
  salesRepName: string;
  status: string;
  workflowPolicy: string;
  totalAmount: string;
  depositStatus: string | null;
  depositAmount: string | null;
}
interface SalesByPeriodRow {
  period: string;
  orderCount: number;
  totalAmount: string;
}
interface SalesByCustomerRow {
  customerId: string;
  customerName: string;
  orderCount: number;
  totalAmount: string;
}
interface SalesByRepRow {
  salesRepUserId: string;
  salesRepName: string;
  orderCount: number;
  totalAmount: string;
}
interface StockReportRow {
  warehouseId: string;
  productId: string;
  onHand: number;
  reserved: number;
  available: number;
}
interface MovementRow {
  id: string;
  warehouseId: string;
  productId: string;
  quantity: number;
  movementType: string;
  createdAt: string;
}
interface Task {
  id: string;
  fulfillmentOrderId: string;
  state: string;
}
interface Shipment {
  id: string;
  waybillNumber: string;
  fulfillmentOrderId: string;
  driverUserId: string | null;
  state: string;
}
interface DeliveryOutcome {
  outcome: string;
  failureReason: string | null;
  occurredAt: string;
}
interface Collection {
  amount: string;
  method: string;
  occurredAt: string;
}
interface CustodyCodReportRow {
  custodianType: 'company' | 'vehicle';
  custodianId: string;
  custodianCode: string;
  custodianName: string;
  custodyBalance: string;
  activeShipmentsCount: number;
  codCollectedTotal: string;
  codPendingTotal: string;
  codRemittedTotal: string;
}
interface CustodyCodReport {
  rows: CustodyCodReportRow[];
  totals: { custodyBalance: string; codCollectedTotal: string; codPendingTotal: string; codRemittedTotal: string };
}
interface ReturnRow {
  id: string;
  salesOrderId: string;
  productId: string;
  quantity: number;
  warehouseId: string;
  reason: string;
  state: string;
}
interface Warehouse {
  id: string;
  code: string;
  name: string;
}
interface Product {
  id: string;
  sku: string;
  name: string;
}

const TABS = [
  'sales_orders',
  'sales_by_period',
  'sales_by_customer',
  'sales_by_rep',
  'stock_report',
  'warehouse_movements',
  'fulfillment',
  'shipments',
  'delivery',
  'returns',
  'custody_cod',
] as const;
type Tab = (typeof TABS)[number];

/** Custody/COD Reporting (CTO directive, Phase 5) is money-sensitive — same admin/finance tier as its own backend route. Every other tab stays open to all authenticated users, matching ReportsController's "reads broadly available" boundary. */
const FINANCE_ONLY_TABS: Tab[] = ['custody_cod'];

const TAB_LABEL_CODE: Record<Tab, string> = {
  sales_orders: 'nav.sales_orders',
  sales_by_period: 'field.sales_by_period',
  sales_by_customer: 'field.sales_by_customer',
  sales_by_rep: 'field.sales_by_rep',
  stock_report: 'field.stock_report',
  warehouse_movements: 'field.warehouse_movements',
  fulfillment: 'nav.fulfillment',
  shipments: 'nav.shipments',
  delivery: 'field.delivery_report',
  returns: 'nav.returns',
  custody_cod: 'panel.custody_cod_report',
};

/** Downloads an xlsx export endpoint via fetch+Blob (same pattern as ExcelImportExport — these endpoints need the JWT header, a bare link can't attach one). */
async function downloadExport(url: string, filename: string) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${getAccessToken()}` } });
  if (!res.ok) throw new Error(`Export failed (status ${res.status}).`);
  const blob = await res.blob();
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(blobUrl);
}

function ExportButton({ url, filename }: { url: string; filename: string }) {
  const { t } = useLanguage();
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="btn btn-secondary"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await downloadExport(url, filename);
        } finally {
          setBusy(false);
        }
      }}
    >
      {t('action.export_excel')}
    </button>
  );
}

/** Opens the shared /print/report view (ReportPrint.tsx) for one of the four report types whose API already returns display-ready (name-resolved) columns — see ReportPrint's own doc comment for why the id/lookup-heavy tabs (stock, movements, fulfillment, shipments, delivery, returns) aren't wired to print yet. */
function PrintButton({ type, query }: { type: string; query?: string }) {
  const { t } = useLanguage();
  return (
    <button
      className="btn btn-secondary"
      onClick={() => window.open(`/print/report?type=${type}${query ? `&${query}` : ''}`, '_blank')}
    >
      {t('action.print')}
    </button>
  );
}

export function Reports() {
  const { hasRole } = useAuth();
  const { t, preload } = useLanguage();
  const [searchParams] = useSearchParams();
  const requestedTab = searchParams.get('tab');
  const initialTab = (TABS as readonly string[]).includes(requestedTab ?? '') ? (requestedTab as Tab) : 'sales_orders';
  const [tab, setTab] = useState<Tab>(initialTab);
  const [error, setError] = useState<string | null>(null);
  const visibleTabs = TABS.filter((tb) => !FINANCE_ONLY_TABS.includes(tb) || hasRole('admin', 'finance'));

  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [products, setProducts] = useState<Product[]>([]);

  preload([
    'nav.reports',
    ...Object.values(TAB_LABEL_CODE),
    'field.order_number',
    'field.created_at',
    'field.customer',
    'role.sales_rep',
    'field.status',
    'field.total_amount',
    'field.deposit_status',
    'field.deposit_amount',
    'field.period',
    'field.order_count',
    'field.group_by',
    'field.day',
    'field.month',
    'field.warehouse',
    'field.product',
    'field.sku',
    'field.name',
    'field.on_hand',
    'field.reserved',
    'field.available',
    'field.movement_type',
    'field.quantity',
    'field.date_from',
    'field.date_to',
    'field.all',
    'field.waybill',
    'field.driver',
    'field.outcome',
    'field.collected_amount',
    'field.fulfillment_order',
    'panel.pick_tasks',
    'panel.pack_tasks',
    'action.export_excel',
    'panel.no_report_data',
    'field.custodian_type',
    'field.custody_balance',
    'field.active_shipments',
    'field.cod_collected',
    'field.cod_pending',
    'field.cod_remitted',
    'panel.shipping_companies',
    'panel.vehicles',
  ]);

  useEffect(() => {
    Promise.all([api.get<Warehouse[]>('/inventory/warehouses'), api.get<Product[]>('/products/all')])
      .then(([wh, prod]) => {
        setWarehouses(wh);
        setProducts(prod);
      })
      .catch(() => undefined);
  }, []);

  const warehouseName = (id: string) => warehouses.find((w) => w.id === id)?.code ?? id;
  const productLabel = (id: string) => {
    const p = products.find((x) => x.id === id);
    return p ? `${p.sku} — ${p.name}` : id;
  };

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.reports')}</h1>
      </div>

      <div className="action-row" style={{ marginBottom: 16, flexWrap: 'wrap' }}>
        {visibleTabs.map((tb) => (
          <button
            key={tb}
            className={tb === tab ? 'btn btn-primary' : 'btn btn-secondary'}
            onClick={() => setTab(tb)}
          >
            {t(TAB_LABEL_CODE[tb])}
          </button>
        ))}
      </div>

      {error && <div className="error-text">{error}</div>}

      {tab === 'sales_orders' && <SalesOrdersReport setError={setError} />}
      {tab === 'sales_by_period' && <SalesByPeriodReport setError={setError} />}
      {tab === 'sales_by_customer' && <SalesByCustomerReport setError={setError} />}
      {tab === 'sales_by_rep' && <SalesByRepReport setError={setError} />}
      {tab === 'stock_report' && (
        <StockReport setError={setError} warehouses={warehouses} warehouseName={warehouseName} productLabel={productLabel} />
      )}
      {tab === 'warehouse_movements' && (
        <MovementsReport setError={setError} warehouses={warehouses} products={products} warehouseName={warehouseName} productLabel={productLabel} />
      )}
      {tab === 'fulfillment' && <FulfillmentReport setError={setError} />}
      {tab === 'shipments' && <ShipmentsReport setError={setError} />}
      {tab === 'delivery' && <DeliveryReport setError={setError} />}
      {tab === 'returns' && <ReturnsReport setError={setError} warehouseName={warehouseName} productLabel={productLabel} />}
      {tab === 'custody_cod' && <CustodyCodReportTab setError={setError} />}
    </div>
  );
}

function SalesOrdersReport({ setError }: { setError: (e: string | null) => void }) {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const [rows, setRows] = useState<SalesOrderReportRow[] | null>(null);
  useEffect(() => {
    api
      .get<SalesOrderReportRow[]>('/reports/sales-orders')
      .then(setRows)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load report.'));
  }, [setError]);

  if (rows === null) return <div className="empty-state">Loading…</div>;
  return (
    <div>
      <div className="action-row" style={{ marginBottom: 12 }}>
        <ExportButton url="/api/reports/sales-orders/export" filename="sales-orders-report.xlsx" />
        <PrintButton type="sales_orders" />
      </div>
      {rows.length === 0 ? (
        <div className="empty-state">{t('panel.no_report_data')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.order_number')}</th>
              <th>{t('field.created_at')}</th>
              <th>{t('field.customer')}</th>
              <th>{t('role.sales_rep')}</th>
              <th>{t('field.status')}</th>
              <th>{t('field.total_amount')}</th>
              <th>{t('field.deposit_status')}</th>
              <th>{t('field.deposit_amount')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} onClick={() => navigate(`/sales-orders/${r.id}`)} style={{ cursor: 'pointer' }}>
                <td>
                  <span style={{ color: '#2563eb', fontWeight: 600 }}>{r.orderNumber}</span>
                </td>
                <td>{new Date(r.createdAt).toLocaleDateString()}</td>
                <td>{r.customerName}</td>
                <td>{r.salesRepName}</td>
                <td>
                  <StatusBadge code={`sales_order_approval.state.${r.status}`} />
                </td>
                <td>{r.totalAmount}</td>
                <td>{r.depositStatus ? <StatusBadge code={`deposit.status.${r.depositStatus}`} /> : '—'}</td>
                <td>{r.depositAmount ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function SalesByPeriodReport({ setError }: { setError: (e: string | null) => void }) {
  const { t } = useLanguage();
  const [groupBy, setGroupBy] = useState<'day' | 'month'>('day');
  const [rows, setRows] = useState<SalesByPeriodRow[] | null>(null);

  useEffect(() => {
    setRows(null);
    api
      .get<SalesByPeriodRow[]>(`/reports/sales-by-period?groupBy=${groupBy}`)
      .then(setRows)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load report.'));
  }, [groupBy, setError]);

  return (
    <div>
      <div className="action-row" style={{ marginBottom: 12, alignItems: 'flex-end' }}>
        <div className="form-field" style={{ marginBottom: 0, width: 160 }}>
          <label>{t('field.group_by')}</label>
          <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as 'day' | 'month')}>
            <option value="day">{t('field.day')}</option>
            <option value="month">{t('field.month')}</option>
          </select>
        </div>
        <ExportButton url={`/api/reports/sales-by-period/export?groupBy=${groupBy}`} filename="sales-by-period.xlsx" />
        <PrintButton type="sales_by_period" query={`groupBy=${groupBy}`} />
      </div>
      {rows === null ? (
        <div className="empty-state">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="empty-state">{t('panel.no_report_data')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.period')}</th>
              <th>{t('field.order_count')}</th>
              <th>{t('field.total_amount')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.period}>
                <td>{r.period}</td>
                <td>{r.orderCount}</td>
                <td>{r.totalAmount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function SalesByCustomerReport({ setError }: { setError: (e: string | null) => void }) {
  const { t } = useLanguage();
  const [rows, setRows] = useState<SalesByCustomerRow[] | null>(null);
  useEffect(() => {
    api
      .get<SalesByCustomerRow[]>('/reports/sales-by-customer')
      .then(setRows)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load report.'));
  }, [setError]);

  if (rows === null) return <div className="empty-state">Loading…</div>;
  return (
    <div>
      <div className="action-row" style={{ marginBottom: 12 }}>
        <ExportButton url="/api/reports/sales-by-customer/export" filename="sales-by-customer.xlsx" />
        <PrintButton type="sales_by_customer" />
      </div>
      {rows.length === 0 ? (
        <div className="empty-state">{t('panel.no_report_data')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.customer')}</th>
              <th>{t('field.order_count')}</th>
              <th>{t('field.total_amount')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.customerId}>
                <td>{r.customerName}</td>
                <td>{r.orderCount}</td>
                <td>{r.totalAmount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function SalesByRepReport({ setError }: { setError: (e: string | null) => void }) {
  const { t } = useLanguage();
  const [rows, setRows] = useState<SalesByRepRow[] | null>(null);
  useEffect(() => {
    api
      .get<SalesByRepRow[]>('/reports/sales-by-rep')
      .then(setRows)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load report.'));
  }, [setError]);

  if (rows === null) return <div className="empty-state">Loading…</div>;
  return (
    <div>
      <div className="action-row" style={{ marginBottom: 12 }}>
        <ExportButton url="/api/reports/sales-by-rep/export" filename="sales-by-rep.xlsx" />
        <PrintButton type="sales_by_rep" />
      </div>
      {rows.length === 0 ? (
        <div className="empty-state">{t('panel.no_report_data')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('role.sales_rep')}</th>
              <th>{t('field.order_count')}</th>
              <th>{t('field.total_amount')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.salesRepUserId}>
                <td>{r.salesRepName}</td>
                <td>{r.orderCount}</td>
                <td>{r.totalAmount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function StockReport({
  setError,
  warehouses,
  warehouseName,
  productLabel,
}: {
  setError: (e: string | null) => void;
  warehouses: Warehouse[];
  warehouseName: (id: string) => string;
  productLabel: (id: string) => string;
}) {
  const { t } = useLanguage();
  const [warehouseId, setWarehouseId] = useState('');
  const [rows, setRows] = useState<StockReportRow[] | null>(null);

  useEffect(() => {
    setRows(null);
    api
      .get<StockReportRow[]>(`/inventory/reports/stock${warehouseId ? `?warehouseId=${warehouseId}` : ''}`)
      .then(setRows)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load report.'));
  }, [warehouseId, setError]);

  return (
    <div>
      <div className="action-row" style={{ marginBottom: 12, alignItems: 'flex-end' }}>
        <div className="form-field" style={{ marginBottom: 0, minWidth: 200 }}>
          <label>{t('field.warehouse')}</label>
          <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
            <option value="">{t('field.all')}</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.code} — {w.name}
              </option>
            ))}
          </select>
        </div>
        <ExportButton
          url={`/api/inventory/reports/stock/export${warehouseId ? `?warehouseId=${warehouseId}` : ''}`}
          filename="stock-report.xlsx"
        />
      </div>
      {rows === null ? (
        <div className="empty-state">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="empty-state">{t('panel.no_report_data')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.warehouse')}</th>
              <th>{t('field.product')}</th>
              <th>{t('field.on_hand')}</th>
              <th>{t('field.reserved')}</th>
              <th>{t('field.available')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.warehouseId}:${r.productId}`}>
                <td>{warehouseName(r.warehouseId)}</td>
                <td>{productLabel(r.productId)}</td>
                <td>{r.onHand}</td>
                <td>{r.reserved}</td>
                <td>{r.available}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const MOVEMENT_TYPES = [
  'receipt', 'dispatch', 'adjustment', 'transfer_in', 'transfer_out', 'return', 'assembly_consumption', 'assembly_output',
];

function MovementsReport({
  setError,
  warehouses,
  products,
  warehouseName,
  productLabel,
}: {
  setError: (e: string | null) => void;
  warehouses: Warehouse[];
  products: Product[];
  warehouseName: (id: string) => string;
  productLabel: (id: string) => string;
}) {
  const { t } = useLanguage();
  const [warehouseId, setWarehouseId] = useState('');
  const [productId, setProductId] = useState('');
  const [movementType, setMovementType] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [rows, setRows] = useState<MovementRow[] | null>(null);

  function buildQuery() {
    const params = new URLSearchParams();
    if (warehouseId) params.set('warehouseId', warehouseId);
    if (productId) params.set('productId', productId);
    if (movementType) params.set('movementType', movementType);
    if (dateFrom) params.set('dateFrom', dateFrom);
    if (dateTo) params.set('dateTo', dateTo);
    return params.toString();
  }

  useEffect(() => {
    setRows(null);
    const qs = buildQuery();
    api
      .get<MovementRow[]>(`/inventory/reports/movements${qs ? `?${qs}` : ''}`)
      .then(setRows)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load report.'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [warehouseId, productId, movementType, dateFrom, dateTo, setError]);

  return (
    <div>
      <div className="action-row" style={{ marginBottom: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div className="form-field" style={{ marginBottom: 0, minWidth: 180 }}>
          <label>{t('field.warehouse')}</label>
          <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
            <option value="">{t('field.all')}</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.code} — {w.name}
              </option>
            ))}
          </select>
        </div>
        <div className="form-field" style={{ marginBottom: 0, minWidth: 200 }}>
          <label>{t('field.product')}</label>
          <select value={productId} onChange={(e) => setProductId(e.target.value)}>
            <option value="">{t('field.all')}</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.sku} — {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="form-field" style={{ marginBottom: 0, minWidth: 160 }}>
          <label>{t('field.movement_type')}</label>
          <select value={movementType} onChange={(e) => setMovementType(e.target.value)}>
            <option value="">{t('field.all')}</option>
            {MOVEMENT_TYPES.map((m) => (
              <option key={m} value={m}>
                {t(`movement_type.${m}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="form-field" style={{ marginBottom: 0 }}>
          <label>{t('field.date_from')}</label>
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
        </div>
        <div className="form-field" style={{ marginBottom: 0 }}>
          <label>{t('field.date_to')}</label>
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
        </div>
        <ExportButton url={`/api/inventory/reports/movements/export${buildQuery() ? `?${buildQuery()}` : ''}`} filename="warehouse-movements-report.xlsx" />
      </div>
      {rows === null ? (
        <div className="empty-state">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="empty-state">{t('panel.no_report_data')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.created_at')}</th>
              <th>{t('field.warehouse')}</th>
              <th>{t('field.product')}</th>
              <th>{t('field.movement_type')}</th>
              <th>{t('field.quantity')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{new Date(r.createdAt).toLocaleString()}</td>
                <td>{warehouseName(r.warehouseId)}</td>
                <td>{productLabel(r.productId)}</td>
                <td>
                  <StatusBadge code={`movement_type.${r.movementType}`} />
                </td>
                <td>{r.quantity}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function FulfillmentReport({ setError }: { setError: (e: string | null) => void }) {
  const { t } = useLanguage();
  const [pickTasks, setPickTasks] = useState<Task[] | null>(null);
  const [packTasks, setPackTasks] = useState<Task[] | null>(null);

  useEffect(() => {
    Promise.all([api.get<Task[]>('/fulfillment/pick-tasks'), api.get<Task[]>('/fulfillment/pack-tasks')])
      .then(([pick, pack]) => {
        setPickTasks(pick);
        setPackTasks(pack);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load report.'));
  }, [setError]);

  if (pickTasks === null || packTasks === null) return <div className="empty-state">Loading…</div>;
  return (
    <div>
      <h3 style={{ marginTop: 0 }}>{t('panel.pick_tasks')}</h3>
      <table className="data-table" style={{ marginBottom: 24 }}>
        <thead>
          <tr>
            <th>{t('field.fulfillment_order')}</th>
            <th>{t('field.status')}</th>
          </tr>
        </thead>
        <tbody>
          {pickTasks.map((task) => (
            <tr key={task.id}>
              <td>{task.fulfillmentOrderId}</td>
              <td>
                <StatusBadge code={`fulfillment_task.state.${task.state}`} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>{t('panel.pack_tasks')}</h3>
      <table className="data-table">
        <thead>
          <tr>
            <th>{t('field.fulfillment_order')}</th>
            <th>{t('field.status')}</th>
          </tr>
        </thead>
        <tbody>
          {packTasks.map((task) => (
            <tr key={task.id}>
              <td>{task.fulfillmentOrderId}</td>
              <td>
                <StatusBadge code={`fulfillment_task.state.${task.state}`} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ShipmentsReport({ setError }: { setError: (e: string | null) => void }) {
  const { t } = useLanguage();
  const [rows, setRows] = useState<Shipment[] | null>(null);
  const [driverNames, setDriverNames] = useState<Record<string, string>>({});
  useEffect(() => {
    api
      .get<Shipment[]>('/shipments')
      .then(setRows)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load report.'));
    // Admin-only lookup (AdminController requires the admin role) — a
    // non-admin viewer of this report just sees the driver's id instead
    // of dying on a 403, same defensive pattern as pages/Shipments.tsx.
    api
      .get<Array<{ id: string; fullName: string }>>('/admin/users')
      .then((users) => setDriverNames(Object.fromEntries(users.map((u) => [u.id, u.fullName]))))
      .catch(() => undefined);
  }, [setError]);

  if (rows === null) return <div className="empty-state">Loading…</div>;
  if (rows.length === 0) return <div className="empty-state">{t('panel.no_report_data')}</div>;
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>{t('field.waybill')}</th>
          <th>{t('field.driver')}</th>
          <th>{t('field.status')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((s) => (
          <tr key={s.id}>
            <td>{s.waybillNumber}</td>
            <td>{s.driverUserId ? (driverNames[s.driverUserId] ?? s.driverUserId) : '—'}</td>
            <td>
              <StatusBadge code={`shipment_lifecycle.state.${s.state}`} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Delivery status per shipment — no "list all outcomes/collections" endpoint exists (each is a per-shipment lookup by design), so this composes GET /shipments with a per-shipment outcome/collection fetch, same N-calls-at-V1-scale pattern already used elsewhere (e.g. SalesOrdersDetail's deposit panel). */
function DeliveryReport({ setError }: { setError: (e: string | null) => void }) {
  const { t } = useLanguage();
  const [rows, setRows] = useState<Array<{ shipment: Shipment; outcome: DeliveryOutcome | null; collection: Collection | null }> | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const shipments = await api.get<Shipment[]>('/shipments');
        const dispatched = shipments.filter((s) => s.state !== 'assigned' && s.state !== 'picked_up');
        const enriched = await Promise.all(
          dispatched.map(async (shipment) => {
            const [outcome, collection] = await Promise.all([
              api.get<DeliveryOutcome | null>(`/delivery/outcomes?shipmentId=${shipment.id}`).catch(() => null),
              api.get<Collection | null>(`/delivery/collections?shipmentId=${shipment.id}`).catch(() => null),
            ]);
            return { shipment, outcome, collection };
          }),
        );
        setRows(enriched);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Failed to load report.');
      }
    })();
  }, [setError]);

  if (rows === null) return <div className="empty-state">Loading…</div>;
  if (rows.length === 0) return <div className="empty-state">{t('panel.no_report_data')}</div>;
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>{t('field.waybill')}</th>
          <th>{t('field.status')}</th>
          <th>{t('field.outcome')}</th>
          <th>{t('field.collected_amount')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ shipment, outcome, collection }) => (
          <tr key={shipment.id}>
            <td>{shipment.waybillNumber}</td>
            <td>
              <StatusBadge code={`shipment_lifecycle.state.${shipment.state}`} />
            </td>
            <td>{outcome ? t(`delivery_outcome.${outcome.outcome}`) : '—'}</td>
            <td>{collection ? `${collection.amount} (${collection.method})` : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ReturnsReport({
  setError,
  warehouseName,
  productLabel,
}: {
  setError: (e: string | null) => void;
  warehouseName: (id: string) => string;
  productLabel: (id: string) => string;
}) {
  const { t } = useLanguage();
  const [rows, setRows] = useState<ReturnRow[] | null>(null);
  useEffect(() => {
    api
      .get<ReturnRow[]>('/returns')
      .then(setRows)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load report.'));
  }, [setError]);

  if (rows === null) return <div className="empty-state">Loading…</div>;
  if (rows.length === 0) return <div className="empty-state">{t('panel.no_report_data')}</div>;
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>{t('field.product')}</th>
          <th>{t('field.warehouse')}</th>
          <th>{t('field.quantity')}</th>
          <th>{t('field.status')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td>{productLabel(r.productId)}</td>
            <td>{warehouseName(r.warehouseId)}</td>
            <td>{r.quantity}</td>
            <td>
              <StatusBadge code={`return_request.state.${r.state}`} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Custody/COD Reporting (CTO directive, Phase 5 — "custody/COD reporting"). Money-sensitive — the tab itself is hidden from non-admin/finance users (see FINANCE_ONLY_TABS), matching the backend route's own `@RequireRole('admin', 'finance')` gate. */
function CustodyCodReportTab({ setError }: { setError: (e: string | null) => void }) {
  const { t } = useLanguage();
  const [report, setReport] = useState<CustodyCodReport | null>(null);

  useEffect(() => {
    api
      .get<CustodyCodReport>('/reports/custody-cod')
      .then(setReport)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load report.'));
  }, [setError]);

  if (report === null) return <div className="empty-state">Loading…</div>;
  return (
    <div>
      <div className="action-row" style={{ marginBottom: 12 }}>
        <ExportButton url="/api/reports/custody-cod/export" filename="custody-cod-report.xlsx" />
      </div>
      {report.rows.length === 0 ? (
        <div className="empty-state">{t('panel.no_report_data')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.custodian_type')}</th>
              <th>{t('field.custody_balance')}</th>
              <th>{t('field.active_shipments')}</th>
              <th>{t('field.cod_collected')}</th>
              <th>{t('field.cod_pending')}</th>
              <th>{t('field.cod_remitted')}</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.map((r) => (
              <tr key={r.custodianId}>
                <td>
                  {r.custodianType === 'vehicle' ? t('panel.vehicles') : t('panel.shipping_companies')}: {r.custodianCode} — {r.custodianName}
                </td>
                <td>{r.custodyBalance}</td>
                <td>{r.activeShipmentsCount}</td>
                <td>{r.codCollectedTotal}</td>
                <td>{r.codPendingTotal}</td>
                <td>{r.codRemittedTotal}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>
                <strong>{t('field.total_amount')}</strong>
              </td>
              <td>
                <strong>{report.totals.custodyBalance}</strong>
              </td>
              <td>—</td>
              <td>
                <strong>{report.totals.codCollectedTotal}</strong>
              </td>
              <td>
                <strong>{report.totals.codPendingTotal}</strong>
              </td>
              <td>
                <strong>{report.totals.codRemittedTotal}</strong>
              </td>
            </tr>
          </tfoot>
        </table>
      )}
    </div>
  );
}
