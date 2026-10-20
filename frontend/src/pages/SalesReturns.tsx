import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { ReturnsTabs } from '../components/ReturnsTabs';
import { StatusBadge } from '../components/StatusBadge';
import { fmtDate } from '../lib/formatDateTime';

/**
 * Sales/Shipment/Returns workflow review (CTO directive, 2026-09-16).
 * The general customer-return screen — independent of Shipment Return.
 * Order selection is "Specific Order" or "All Orders" (directive §5-§6);
 * in All-Orders mode, only products the customer actually bought within
 * the configured eligibility window are offered (directive §6-§7,
 * PRODUCT NAME as the primary label, code shown only as a hint), and a
 * single return document can span multiple source orders while every
 * line keeps its own real provenance (directive §10).
 */
interface Customer {
  id: string;
  name: string;
}
interface SalesOrder {
  id: string;
  orderNumber: string;
  customerId: string;
}
interface Product {
  id: string;
  sku: string;
  name: string;
}
interface EligibleLine {
  salesOrderId: string;
  orderNumber: string;
  salesOrderLineId: string;
  productId: string;
  originalQuantity: number;
  originalUnitPrice: string;
}
interface SalesReturnRow {
  id: string;
  returnNumber: string;
  customerName: string | null;
  totalAmount: string;
  returnDate: string;
  state: string;
}
interface SalesReturnDetail {
  header: { id: string; returnNumber: string; totalAmount: string; returnDate: string };
  state: string;
  customerName: string | null;
  lines: Array<{ productId: string; returnQuantity: number; returnPrice: string; originalUnitPrice: string; lineTotal: string; sourceSalesOrderId: string }>;
  sourceOrderIds: string[];
}
interface DraftLine {
  sourceSalesOrderLineId: string;
  sourceSalesOrderId: string;
  orderNumber: string;
  productId: string;
  returnQuantity: number;
  returnPrice: string;
  originalUnitPrice: string;
}

export function SalesReturns() {
  const { can } = useAuth();
  const { t, preload } = useLanguage();
  preload([
    'panel.no_sales_returns_yet',
    'field.customer',
    'field.order_scope',
    'order_scope.specific',
    'order_scope.all_orders',
    'field.sales_order',
    'field.return_date',
    'field.product',
    'field.available_quantity',
    'field.return_quantity',
    'field.return_price',
    'field.item_total',
    'field.total_return_amount',
    'field.return_number',
    'field.return_amount',
    'field.status',
    'field.actions',
    'field.source_orders',
    'field.original_unit_price',
    'action.create',
    'action.complete',
    'action.add_item',
    'action.view_details',
  ]);

  const [rows, setRows] = useState<SalesReturnRow[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [orders, setOrders] = useState<SalesOrder[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detailFor, setDetailFor] = useState<SalesReturnDetail | null>(null);

  const [customerId, setCustomerId] = useState('');
  const [orderScope, setOrderScope] = useState<'specific' | 'all_orders'>('all_orders');
  const [salesOrderId, setSalesOrderId] = useState('');
  const [returnDate, setReturnDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [eligible, setEligible] = useState<EligibleLine[]>([]);
  const [pickedLineId, setPickedLineId] = useState('');
  const [draftLines, setDraftLines] = useState<DraftLine[]>([]);
  const [reason, setReason] = useState('');

  async function loadAll() {
    try {
      const [rowsData, customersData, ordersData, productsData] = await Promise.all([
        api.get<SalesReturnRow[]>('/sales-returns'),
        api.get<Customer[]>('/customers'),
        api.get<SalesOrder[]>('/sales-orders'),
        api.get<Product[]>('/products/all'),
      ]);
      setRows(rowsData);
      setCustomers(customersData);
      setOrders(ordersData);
      setProducts(productsData);
    } catch (err) {
      // Foundation fix: mount-time load had no error handling.
      setError(err instanceof ApiError ? err.message : 'Failed to load sales returns.');
    }
  }

  useEffect(() => {
    loadAll();
  }, []);

  const productLabel = (id: string) => products.find((p) => p.id === id)?.name ?? id;
  const productCode = (id: string) => products.find((p) => p.id === id)?.sku ?? '';
  const customerOrders = orders.filter((o) => o.customerId === customerId);

  // Directive §6-§7 — real purchase-history join from the backend, refreshed whenever
  // customer/scope/order/date changes; never a client-side guess at eligibility.
  useEffect(() => {
    setPickedLineId('');
    setDraftLines([]);
    if (!customerId) {
      setEligible([]);
      return;
    }
    (async () => {
      const rows = await api.get<EligibleLine[]>(
        `/sales-returns/eligible-purchases?customerId=${encodeURIComponent(customerId)}&returnDate=${encodeURIComponent(returnDate)}`,
      );
      const scoped = orderScope === 'specific' && salesOrderId ? rows.filter((r) => r.salesOrderId === salesOrderId) : rows;
      setEligible(scoped);
    })();
  }, [customerId, orderScope, salesOrderId, returnDate]);

  function addItem() {
    const line = eligible.find((e) => e.salesOrderLineId === pickedLineId);
    if (!line) return;
    if (draftLines.some((d) => d.sourceSalesOrderLineId === line.salesOrderLineId)) return; // already added
    setDraftLines((prev) => [
      ...prev,
      {
        sourceSalesOrderLineId: line.salesOrderLineId,
        sourceSalesOrderId: line.salesOrderId,
        orderNumber: line.orderNumber,
        productId: line.productId,
        returnQuantity: 1,
        returnPrice: line.originalUnitPrice,
        originalUnitPrice: line.originalUnitPrice,
      },
    ]);
    setPickedLineId('');
  }

  function updateLine(index: number, patch: Partial<DraftLine>) {
    setDraftLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  function removeLine(index: number) {
    setDraftLines((prev) => prev.filter((_, i) => i !== index));
  }

  const totalReturnAmount = draftLines.reduce((sum, l) => sum + Number(l.returnPrice || 0) * Number(l.returnQuantity || 0), 0);

  async function createSalesReturn() {
    setBusy('create');
    setError(null);
    try {
      const lines = draftLines.map((l) => ({
        sourceSalesOrderLineId: l.sourceSalesOrderLineId,
        returnQuantity: l.returnQuantity,
        returnPrice: l.returnPrice,
      }));
      await api.post('/sales-returns', {
        customerId,
        salesOrderId: orderScope === 'specific' ? salesOrderId || null : null,
        returnDate: new Date(returnDate).toISOString(),
        lines,
        reason: reason || undefined,
      });
      setCustomerId('');
      setSalesOrderId('');
      setDraftLines([]);
      setReason('');
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create sales return.');
    } finally {
      setBusy(null);
    }
  }

  async function complete(id: string) {
    setBusy(id + 'complete');
    setError(null);
    try {
      await api.post(`/sales-returns/${id}/complete`, {});
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to complete sales return.');
    } finally {
      setBusy(null);
    }
  }

  async function viewDetail(id: string) {
    const detail = await api.get<SalesReturnDetail>(`/sales-returns/${id}`);
    setDetailFor(detail);
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.sales_returns')}</h1>
      </div>
      <ReturnsTabs />

      {error && <div className="error-text">{error}</div>}

      {can('wf.sales.rep.act', 'editable') && (
        <div className="card" style={{ marginBottom: 20 }}>
          <h3 style={{ marginTop: 0 }}>{t('action.create')}</h3>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 12 }}>
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
              <label>{t('field.order_scope')}</label>
              <select value={orderScope} onChange={(e) => setOrderScope(e.target.value as 'specific' | 'all_orders')}>
                <option value="all_orders">{t('order_scope.all_orders')}</option>
                <option value="specific">{t('order_scope.specific')}</option>
              </select>
            </div>
            {orderScope === 'specific' && (
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
            )}
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{t('field.return_date')}</label>
              <input type="date" value={returnDate} onChange={(e) => setReturnDate(e.target.value)} />
            </div>
            <div className="form-field" style={{ marginBottom: 0, flex: 1, minWidth: 160 }}>
              <label>{t('field.reason')}</label>
              <input value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
          </div>

          {customerId && (
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginBottom: 12 }}>
              <div className="form-field" style={{ marginBottom: 0, flex: 1, minWidth: 260 }}>
                <label>{t('field.product')}</label>
                <select value={pickedLineId} onChange={(e) => setPickedLineId(e.target.value)}>
                  <option value="">—</option>
                  {eligible.map((e) => (
                    <option key={e.salesOrderLineId} value={e.salesOrderLineId}>
                      {productLabel(e.productId)} ({productCode(e.productId)}) — {e.orderNumber}, {t('field.available_quantity')}: {e.originalQuantity}
                    </option>
                  ))}
                </select>
              </div>
              <button className="btn btn-secondary" disabled={!pickedLineId} onClick={addItem}>
                {t('action.add_item')}
              </button>
            </div>
          )}

          {draftLines.length > 0 && (
            <table className="data-table" style={{ marginBottom: 12 }}>
              <thead>
                <tr>
                  <th>{t('field.product')}</th>
                  <th>{t('field.sales_order')}</th>
                  <th>{t('field.original_unit_price')}</th>
                  <th>{t('field.return_quantity')}</th>
                  <th>{t('field.return_price')}</th>
                  <th>{t('field.item_total')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {draftLines.map((l, i) => (
                  <tr key={l.sourceSalesOrderLineId}>
                    <td>{productLabel(l.productId)}</td>
                    <td>{l.orderNumber}</td>
                    <td>{l.originalUnitPrice}</td>
                    <td>
                      <input
                        type="number"
                        min={1}
                        value={l.returnQuantity}
                        onChange={(e) => updateLine(i, { returnQuantity: Number(e.target.value) })}
                        style={{ width: 80 }}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        value={l.returnPrice}
                        onChange={(e) => updateLine(i, { returnPrice: e.target.value })}
                        style={{ width: 100 }}
                      />
                    </td>
                    <td>{(Number(l.returnPrice || 0) * Number(l.returnQuantity || 0)).toFixed(2)}</td>
                    <td>
                      <button className="btn btn-danger" onClick={() => removeLine(i)}>
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong>
              {t('field.total_return_amount')}: {totalReturnAmount.toFixed(2)}
            </strong>
            <button className="btn btn-primary" disabled={busy === 'create' || !customerId || draftLines.length === 0} onClick={createSalesReturn}>
              {t('action.create')}
            </button>
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="empty-state">{t('panel.no_sales_returns_yet')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.return_number')}</th>
              <th>{t('field.customer')}</th>
              <th>{t('field.return_amount')}</th>
              <th>{t('field.return_date')}</th>
              <th>{t('field.status')}</th>
              <th>{t('field.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={{ cursor: 'pointer' }}>
                <td onClick={() => viewDetail(r.id)}>{r.returnNumber}</td>
                <td onClick={() => viewDetail(r.id)}>{r.customerName ?? '—'}</td>
                <td onClick={() => viewDetail(r.id)}>{r.totalAmount}</td>
                <td onClick={() => viewDetail(r.id)}>{fmtDate(r.returnDate)}</td>
                <td onClick={() => viewDetail(r.id)}>
                  <StatusBadge code={`sales_return.state.${r.state}`} />
                </td>
                <td>
                  <button className="btn btn-secondary" style={{ marginInlineEnd: 6 }} onClick={() => viewDetail(r.id)}>
                    {t('action.view_details')}
                  </button>
                  {r.state === 'requested' && can('wf.logistics.return.receive', 'editable') && (
                    <button className="btn btn-primary" disabled={busy === r.id + 'complete'} onClick={() => complete(r.id)}>
                      {t('action.complete')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {detailFor && (
        <div className="card" style={{ marginTop: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <h3 style={{ marginTop: 0 }}>
              {t('field.return_number')}: {detailFor.header.returnNumber}
            </h3>
            <button className="btn btn-secondary" onClick={() => setDetailFor(null)}>
              ×
            </button>
          </div>
          <div>
            {t('field.customer')}: <strong>{detailFor.customerName ?? '—'}</strong>
          </div>
          <div>
            {t('field.status')}: <StatusBadge code={`sales_return.state.${detailFor.state}`} />
          </div>
          <div>
            {t('field.source_orders')}:{' '}
            <strong>{detailFor.sourceOrderIds.map((id) => orders.find((o) => o.id === id)?.orderNumber ?? id).join(', ')}</strong>
          </div>
          <table className="data-table" style={{ marginTop: 12 }}>
            <thead>
              <tr>
                <th>{t('field.product')}</th>
                <th>{t('field.sales_order')}</th>
                <th>{t('field.original_unit_price')}</th>
                <th>{t('field.return_quantity')}</th>
                <th>{t('field.return_price')}</th>
                <th>{t('field.item_total')}</th>
              </tr>
            </thead>
            <tbody>
              {detailFor.lines.map((l, i) => (
                <tr key={i}>
                  <td>{productLabel(l.productId)}</td>
                  <td>{orders.find((o) => o.id === l.sourceSalesOrderId)?.orderNumber ?? l.sourceSalesOrderId}</td>
                  <td>{l.originalUnitPrice}</td>
                  <td>{l.returnQuantity}</td>
                  <td>{l.returnPrice}</td>
                  <td>{l.lineTotal}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
