import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { StatusBadge } from '../../components/StatusBadge';
import { ProductCombobox, type ProductOption } from '../../components/ProductCombobox';

interface Supplier {
  id: string;
  code: string;
  legalName: string;
}
interface Warehouse {
  id: string;
  code: string;
  name: string;
}
interface PurchaseOrderRow {
  id: string;
  poNumber: string;
  supplierId: string;
  warehouseId: string;
  totalAmountBase: string;
  state: string;
  createdAt: string;
}
interface PurchaseOrderLine {
  id: string;
  productId: string;
  quantity: string;
  unitCostBase: string;
  lineTotalBase: string;
  quantityReceived: string;
}
interface PurchaseOrderDetail {
  purchaseOrder: PurchaseOrderRow;
  state: string;
  lines: PurchaseOrderLine[];
}
interface GoodsReceipt {
  id: string;
  grNumber: string;
  createdAt: string;
}
interface DraftLine {
  productId: string;
  productName: string;
  quantity: string;
  unitCostBase: string;
}

const CANCELLABLE_STATES = new Set(['draft', 'submitted', 'approved']);

/**
 * ADR-048 — the `purchasing` bounded context's operational screen:
 * create/submit/approve a Purchase Order, then post Goods Receipts
 * against it until fully received. Every product selection here is by
 * name (`ProductCombobox`), same as the Warehouse/Inventory screens —
 * the id is what's actually sent to the backend.
 */
export function PurchaseOrders() {
  const { hasRole } = useAuth();
  const { t, preload } = useLanguage();
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [orders, setOrders] = useState<PurchaseOrderRow[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PurchaseOrderDetail | null>(null);
  const [receipts, setReceipts] = useState<GoodsReceipt[]>([]);

  const [supplierId, setSupplierId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [draftLines, setDraftLines] = useState<DraftLine[]>([]);
  const [lineProductSearch, setLineProductSearch] = useState('');
  const [lineQty, setLineQty] = useState('');
  const [lineCost, setLineCost] = useState('');
  const [creating, setCreating] = useState(false);

  const [receiveQty, setReceiveQty] = useState<Record<string, string>>({});
  const [posting, setPosting] = useState(false);

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  preload([
    'nav.purchase_orders',
    'field.po_number',
    'field.gr_number',
    'field.supplier',
    'field.warehouse',
    'field.total_amount',
    'field.unit_cost',
    'field.line_total',
    'field.quantity_ordered',
    'field.quantity_received',
    'field.quantity_remaining',
    'field.status',
    'field.notes',
    'field.product',
    'field.quantity',
    'action.create_purchase_order',
    'action.add_po_line',
    'action.submit',
    'action.approve',
    'action.reject',
    'action.cancel',
    'action.post_goods_receipt',
    'panel.no_purchase_orders_yet',
    'panel.no_goods_receipts_yet',
    'purchase_order_lifecycle.state.draft',
    'purchase_order_lifecycle.state.submitted',
    'purchase_order_lifecycle.state.approved',
    'purchase_order_lifecycle.state.partially_received',
    'purchase_order_lifecycle.state.received',
    'purchase_order_lifecycle.state.closed',
    'purchase_order_lifecycle.state.cancelled',
  ]);

  async function load() {
    try {
      const [ord, sup, wh, prod] = await Promise.all([
        api.get<PurchaseOrderRow[]>('/procurement/purchase-orders'),
        api.get<Supplier[]>('/procurement/suppliers/all'),
        api.get<Warehouse[]>('/inventory/warehouses'),
        api.get<ProductOption[]>('/products/all'),
      ]);
      setOrders(ord);
      setSuppliers(sup);
      setWarehouses(wh);
      setProducts(prod);
      if (wh[0]) setWarehouseId((w) => w || wh[0].id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load purchase orders.');
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function loadDetail(id: string) {
    setSelectedId(id);
    const [d, gr] = await Promise.all([
      api.get<PurchaseOrderDetail>(`/procurement/purchase-orders/${id}`),
      api.get<GoodsReceipt[]>(`/procurement/goods-receipts/by-purchase-order/${id}`),
    ]);
    setDetail(d);
    setReceipts(gr);
    setReceiveQty({});
  }

  function addDraftLine() {
    if (!lineProductSearch) return;
    const product = products.find((p) => p.name === lineProductSearch);
    if (!product || !lineQty || !lineCost) return;
    setDraftLines((prev) => [...prev, { productId: product.id, productName: product.name, quantity: lineQty, unitCostBase: lineCost }]);
    setLineProductSearch('');
    setLineQty('');
    setLineCost('');
  }

  function removeDraftLine(i: number) {
    setDraftLines((prev) => prev.filter((_, idx) => idx !== i));
  }

  const draftTotal = useMemo(() => draftLines.reduce((sum, l) => sum + Number(l.quantity) * Number(l.unitCostBase), 0), [draftLines]);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    if (!supplierId || !warehouseId || draftLines.length === 0) return;
    setCreating(true);
    setError(null);
    try {
      await api.post('/procurement/purchase-orders', {
        supplierId,
        warehouseId,
        lines: draftLines.map((l) => ({ productId: l.productId, quantity: l.quantity, unitCostBase: l.unitCostBase })),
      });
      setSupplierId('');
      setDraftLines([]);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create purchase order.');
    } finally {
      setCreating(false);
    }
  }

  async function doTransition(action: 'submit' | 'approve' | 'reject' | 'cancel') {
    if (!selectedId) return;
    setBusyAction(action);
    setError(null);
    try {
      await api.post(`/procurement/purchase-orders/${selectedId}/${action}`);
      await load();
      await loadDetail(selectedId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Failed to ${action} purchase order.`);
    } finally {
      setBusyAction(null);
    }
  }

  async function onPostReceipt() {
    if (!selectedId || !detail) return;
    const lines = detail.lines
      .filter((l) => Number(receiveQty[l.id] ?? 0) > 0)
      .map((l) => ({ purchaseOrderLineId: l.id, quantityReceived: receiveQty[l.id] }));
    if (lines.length === 0) return;
    setPosting(true);
    setError(null);
    try {
      await api.post('/procurement/goods-receipts', { purchaseOrderId: selectedId, lines });
      await load();
      await loadDetail(selectedId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to post goods receipt.');
    } finally {
      setPosting(false);
    }
  }

  const supplierName = (id: string) => suppliers.find((s) => s.id === id)?.legalName ?? id;
  const warehouseName = (id: string) => warehouses.find((w) => w.id === id)?.name ?? id;
  const productName = (id: string) => products.find((p) => p.id === id)?.name ?? id;

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.purchase_orders')}</h1>
      </div>

      {hasRole('admin') && (
        <div className="card" style={{ marginBottom: 20 }}>
          <form onSubmit={onCreate}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 14 }}>
              <div className="form-field" style={{ marginBottom: 0, minWidth: 220 }}>
                <label>{t('field.supplier')}</label>
                <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} required>
                  <option value="">—</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.code} — {s.legalName}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-field" style={{ marginBottom: 0, minWidth: 220 }}>
                <label>{t('field.warehouse')}</label>
                <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} required>
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.code} — {w.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 10 }}>
              <div style={{ minWidth: 260 }}>
                <ProductCombobox products={products} value={lineProductSearch} onValueChange={setLineProductSearch} onSelect={(p) => setLineProductSearch(p.name)} placeholder={t('field.product')} />
              </div>
              <div className="form-field" style={{ marginBottom: 0 }}>
                <label>{t('field.quantity')}</label>
                <input type="number" min={0} step="0.001" value={lineQty} onChange={(e) => setLineQty(e.target.value)} style={{ width: 100 }} />
              </div>
              <div className="form-field" style={{ marginBottom: 0 }}>
                <label>{t('field.unit_cost')}</label>
                <input type="number" min={0} step="0.0001" value={lineCost} onChange={(e) => setLineCost(e.target.value)} style={{ width: 110 }} />
              </div>
              <button type="button" className="btn btn-secondary" onClick={addDraftLine}>
                {t('action.add_po_line')}
              </button>
            </div>

            {draftLines.length > 0 && (
              <table className="data-table" style={{ marginBottom: 14 }}>
                <thead>
                  <tr>
                    <th>{t('field.product')}</th>
                    <th>{t('field.quantity')}</th>
                    <th>{t('field.unit_cost')}</th>
                    <th>{t('field.line_total')}</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {draftLines.map((l, i) => (
                    <tr key={i}>
                      <td>{l.productName}</td>
                      <td>{l.quantity}</td>
                      <td>{l.unitCostBase}</td>
                      <td>{(Number(l.quantity) * Number(l.unitCostBase)).toFixed(2)}</td>
                      <td>
                        <button type="button" className="btn btn-secondary" onClick={() => removeDraftLine(i)}>
                          ×
                        </button>
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td colSpan={3} style={{ textAlign: 'end', fontWeight: 600 }}>
                      {t('field.total_amount')}
                    </td>
                    <td style={{ fontWeight: 600 }}>{draftTotal.toFixed(2)}</td>
                    <td></td>
                  </tr>
                </tbody>
              </table>
            )}

            <button className="btn btn-primary" type="submit" disabled={creating || draftLines.length === 0}>
              {t('action.create_purchase_order')}
            </button>
          </form>
        </div>
      )}

      {error && <div className="error-text">{error}</div>}

      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          {orders === null ? (
            <div className="empty-state">Loading…</div>
          ) : orders.length === 0 ? (
            <div className="empty-state">{t('panel.no_purchase_orders_yet')}</div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('field.po_number')}</th>
                  <th>{t('field.supplier')}</th>
                  <th>{t('field.warehouse')}</th>
                  <th>{t('field.total_amount')}</th>
                  <th>{t('field.status')}</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id} style={{ cursor: 'pointer' }} onClick={() => loadDetail(o.id)}>
                    <td>{o.poNumber}</td>
                    <td>{supplierName(o.supplierId)}</td>
                    <td>{warehouseName(o.warehouseId)}</td>
                    <td>{o.totalAmountBase}</td>
                    <td>
                      <StatusBadge code={`purchase_order_lifecycle.state.${o.state}`} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {detail && (
          <div className="card" style={{ width: 440, flexShrink: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <h3 style={{ margin: 0 }}>{detail.purchaseOrder.poNumber}</h3>
              <StatusBadge code={`purchase_order_lifecycle.state.${detail.state}`} />
            </div>

            {hasRole('admin') && (
              <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
                {detail.state === 'draft' && (
                  <button className="btn btn-secondary" disabled={busyAction === 'submit'} onClick={() => doTransition('submit')}>
                    {t('action.submit')}
                  </button>
                )}
                {detail.state === 'submitted' && (
                  <>
                    <button className="btn btn-primary" disabled={busyAction === 'approve'} onClick={() => doTransition('approve')}>
                      {t('action.approve')}
                    </button>
                    <button className="btn btn-secondary" disabled={busyAction === 'reject'} onClick={() => doTransition('reject')}>
                      {t('action.reject')}
                    </button>
                  </>
                )}
                {CANCELLABLE_STATES.has(detail.state) && (
                  <button className="btn btn-danger" disabled={busyAction === 'cancel'} onClick={() => doTransition('cancel')}>
                    {t('action.cancel')}
                  </button>
                )}
              </div>
            )}

            <table className="data-table" style={{ marginBottom: 14 }}>
              <thead>
                <tr>
                  <th>{t('field.product')}</th>
                  <th>{t('field.quantity_ordered')}</th>
                  <th>{t('field.quantity_received')}</th>
                  {(detail.state === 'approved' || detail.state === 'partially_received') && <th>{t('action.post_goods_receipt')}</th>}
                </tr>
              </thead>
              <tbody>
                {detail.lines.map((l) => {
                  const remaining = Number(l.quantity) - Number(l.quantityReceived);
                  return (
                    <tr key={l.id}>
                      <td>{productName(l.productId)}</td>
                      <td>{l.quantity}</td>
                      <td>{l.quantityReceived}</td>
                      {(detail.state === 'approved' || detail.state === 'partially_received') && (
                        <td>
                          {remaining > 0 && hasRole('admin') && (
                            <input
                              type="number"
                              min={0}
                              max={remaining}
                              step="0.001"
                              placeholder={String(remaining)}
                              value={receiveQty[l.id] ?? ''}
                              onChange={(e) => setReceiveQty((prev) => ({ ...prev, [l.id]: e.target.value }))}
                              style={{ width: 80 }}
                            />
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {(detail.state === 'approved' || detail.state === 'partially_received') && hasRole('admin') && (
              <button className="btn btn-primary" disabled={posting} onClick={onPostReceipt} style={{ marginBottom: 14 }}>
                {t('action.post_goods_receipt')}
              </button>
            )}

            <h4>{t('field.gr_number')}</h4>
            {receipts.length === 0 ? (
              <div className="empty-state" style={{ padding: 10 }}>
                {t('panel.no_goods_receipts_yet')}
              </div>
            ) : (
              <ul style={{ paddingInlineStart: 18 }}>
                {receipts.map((r) => (
                  <li key={r.id}>
                    {r.grNumber} — {new Date(r.createdAt).toLocaleString()}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
