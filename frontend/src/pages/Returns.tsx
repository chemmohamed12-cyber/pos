import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { ReturnsTabs } from '../components/ReturnsTabs';
import { StatusBadge } from '../components/StatusBadge';

interface ReturnRequest {
  id: string;
  returnNumber: string | null;
  salesOrderId: string;
  salesOrderLineId: string | null;
  productId: string;
  quantity: number;
  warehouseId: string;
  reason: string;
  returnType: 'exchange' | 'value_credit' | 'product_return' | null;
  origin: 'customer' | 'shipping_company_custody' | 'vehicle_custody';
  state: string;
}
interface SalesOrder {
  id: string;
  orderNumber: string;
  customerId: string;
}
interface OrderLine {
  id: string;
  productId: string;
  quantity: number;
}
interface Product {
  id: string;
  sku: string;
}
interface Customer {
  id: string;
  name: string;
}

const ACTIONS: Record<string, Array<{ action: string; node: string; endpoint: string }>> = {
  requested: [
    { action: 'authorize', node: 'wf.logistics.return.authorize', endpoint: 'authorize' },
    { action: 'reject', node: 'wf.logistics.return.reject', endpoint: 'reject' },
  ],
  authorized: [{ action: 'receive_at_warehouse', node: 'wf.logistics.return.receive', endpoint: 'receive' }],
  received: [{ action: 'inspect', node: 'wf.logistics.return.inspect', endpoint: 'inspect' }],
};

const DISPOSITIONS = ['restock', 'damaged', 'repair', 'scrap', 'replacement'];
const RETURN_TYPES = ['exchange', 'value_credit', 'product_return'] as const;

export function Returns() {
  const { can } = useAuth();
  const { t, preload } = useLanguage();
  preload([
    'panel.no_returns_yet',
    'field.sales_order',
    'field.product',
    'field.quantity',
    'field.reason',
    'field.status',
    'field.actions',
    'field.customer',
    'field.return_type',
    'field.return_number',
    'action.create',
    'action.query',
    'return_type.exchange',
    'return_type.value_credit',
    'return_type.product_return',
    'field.return_origin',
    'return_origin.customer',
    'return_origin.shipping_company_custody',
    'return_origin.vehicle_custody',
  ]);
  const [returns, setReturns] = useState<ReturnRequest[]>([]);
  const [orders, setOrders] = useState<SalesOrder[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [orderLines, setOrderLines] = useState<OrderLine[]>([]);

  const [customerId, setCustomerId] = useState('');
  const [salesOrderId, setSalesOrderId] = useState('');
  const [salesOrderLineId, setSalesOrderLineId] = useState('');
  const [returnType, setReturnType] = useState<(typeof RETURN_TYPES)[number] | ''>('');
  const [quantity, setQuantity] = useState(1);
  const [reason, setReason] = useState('');

  const [dispositionChoice, setDispositionChoice] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadAll() {
    try {
      const [returnsData, ordersData, productsData, customersData] = await Promise.all([
        api.get<ReturnRequest[]>('/returns'),
        api.get<SalesOrder[]>('/sales-orders'),
        api.get<Product[]>('/products'),
        api.get<Customer[]>('/customers'),
      ]);
      setReturns(returnsData);
      setOrders(ordersData);
      setProducts(productsData);
      setCustomers(customersData);
    } catch (err) {
      // Foundation fix: mount-time load had no error handling.
      setError(err instanceof ApiError ? err.message : 'Failed to load returns.');
    }
  }

  useEffect(() => {
    loadAll();
  }, []);

  // Directive §9 — "Customer → Query → Orders/Shipments → Details →
  // Return": the customer's own orders are derived client-side from the
  // already-Scope-filtered /sales-orders list (same "N calls fine at V1
  // scale" precedent used elsewhere), never a manually-typed order number.
  const customerOrders = orders.filter((o) => o.customerId === customerId);

  useEffect(() => {
    setSalesOrderId('');
    setSalesOrderLineId('');
    setOrderLines([]);
  }, [customerId]);

  useEffect(() => {
    setSalesOrderLineId('');
    if (!salesOrderId) {
      setOrderLines([]);
      return;
    }
    (async () => {
      const order = await api.get<{ lines: OrderLine[] }>(`/sales-orders/${salesOrderId}`);
      setOrderLines(order.lines);
    })();
  }, [salesOrderId]);

  const selectedLine = orderLines.find((l) => l.id === salesOrderLineId);

  async function createReturn() {
    setBusy('create');
    setError(null);
    try {
      await api.post('/returns', { salesOrderLineId, quantity, returnType, reason });
      setSalesOrderId('');
      setSalesOrderLineId('');
      setReturnType('');
      setQuantity(1);
      setReason('');
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create return request.');
    } finally {
      setBusy(null);
    }
  }

  async function runAction(id: string, endpoint: string) {
    setBusy(id + endpoint);
    setError(null);
    try {
      await api.post(`/returns/${id}/${endpoint}`, {});
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update return.');
    } finally {
      setBusy(null);
    }
  }

  async function recordDisposition(id: string) {
    const disposition = dispositionChoice[id] ?? 'restock';
    setBusy(id + 'disposition');
    setError(null);
    try {
      await api.post(`/returns/${id}/disposition`, { disposition });
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to record disposition.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.returns')}</h1>
      </div>
      <ReturnsTabs />

      {error && <div className="error-text">{error}</div>}

      {can('wf.sales.rep.act', 'editable') && (
        <div className="card" style={{ marginBottom: 20 }}>
          <h3 style={{ marginTop: 0 }}>{t('action.create')}</h3>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{t('field.customer')}</label>
              <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                <option value="">—</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{t('field.sales_order')}</label>
              <select value={salesOrderId} onChange={(e) => setSalesOrderId(e.target.value)} disabled={!customerId}>
                <option value="">—</option>
                {customerOrders.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.orderNumber}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{t('field.product')}</label>
              <select value={salesOrderLineId} onChange={(e) => setSalesOrderLineId(e.target.value)} disabled={!salesOrderId}>
                <option value="">—</option>
                {orderLines.map((l) => (
                  <option key={l.id} value={l.id}>
                    {products.find((p) => p.id === l.productId)?.sku ?? l.productId} ({l.quantity})
                  </option>
                ))}
              </select>
            </div>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{t('field.return_type')}</label>
              <select value={returnType} onChange={(e) => setReturnType(e.target.value as (typeof RETURN_TYPES)[number])}>
                <option value="">—</option>
                {RETURN_TYPES.map((rt) => (
                  <option key={rt} value={rt}>
                    {t(`return_type.${rt}`)}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-field" style={{ marginBottom: 0, width: 80 }}>
              <label>{t('field.quantity')}</label>
              <input
                type="number"
                min={1}
                max={selectedLine?.quantity}
                value={quantity}
                onChange={(e) => setQuantity(Number(e.target.value))}
              />
            </div>
            <div className="form-field" style={{ marginBottom: 0, flex: 1, minWidth: 160 }}>
              <label>{t('field.reason')}</label>
              <input value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            <button
              className="btn btn-primary"
              disabled={busy === 'create' || !salesOrderLineId || !returnType || !reason}
              onClick={createReturn}
            >
              {t('action.create')}
            </button>
          </div>
        </div>
      )}

      {returns.length === 0 ? (
        <div className="empty-state">{t('panel.no_returns_yet')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.return_number')}</th>
              <th>{t('field.return_origin')}</th>
              <th>{t('field.sales_order')}</th>
              <th>{t('field.product')}</th>
              <th>{t('field.quantity')}</th>
              <th>{t('field.return_type')}</th>
              <th>{t('field.reason')}</th>
              <th>{t('field.status')}</th>
              <th>{t('field.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {returns.map((r) => (
              <tr key={r.id}>
                <td>{r.returnNumber ?? '—'}</td>
                <td>{t(`return_origin.${r.origin}`)}</td>
                <td>{orders.find((o) => o.id === r.salesOrderId)?.orderNumber ?? r.salesOrderId}</td>
                <td>{products.find((p) => p.id === r.productId)?.sku ?? r.productId}</td>
                <td>{r.quantity}</td>
                <td>{r.returnType ? t(`return_type.${r.returnType}`) : '—'}</td>
                <td>{r.reason}</td>
                <td>
                  <StatusBadge code={`return_request.state.${r.state}`} />
                </td>
                <td>
                  {(ACTIONS[r.state] ?? [])
                    .filter((a) => can(a.node, 'editable'))
                    .map((a) => (
                      <button
                        key={a.action}
                        className={a.action === 'reject' ? 'btn btn-danger' : 'btn btn-secondary'}
                        style={{ marginInlineEnd: 6 }}
                        disabled={busy === r.id + a.endpoint}
                        onClick={() => runAction(r.id, a.endpoint)}
                      >
                        {t(`return_request.action.${a.action}`)}
                      </button>
                    ))}
                  <button className="btn btn-secondary" onClick={() => window.open(`/print/return/${r.id}`, '_blank')}>
                    {t('action.print')}
                  </button>
                  {r.state === 'inspected' && can('wf.logistics.return.disposition', 'editable') && (
                    <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                      <select
                        value={dispositionChoice[r.id] ?? 'restock'}
                        onChange={(e) => setDispositionChoice((prev) => ({ ...prev, [r.id]: e.target.value }))}
                      >
                        {DISPOSITIONS.map((d) => (
                          <option key={d} value={d}>
                            {t(`disposition.${d}`)}
                          </option>
                        ))}
                      </select>
                      <button className="btn btn-primary" disabled={busy === r.id + 'disposition'} onClick={() => recordDisposition(r.id)}>
                        {t('return_request.action.disposition')}
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
