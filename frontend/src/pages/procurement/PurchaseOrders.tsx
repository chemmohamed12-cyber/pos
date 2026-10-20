import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { StatusBadge } from '../../components/StatusBadge';
import { FinancialStatusCell } from '../../components/FinancialTrace';
import { StockCell, useStockAvailability } from '../../components/StockAvailability';
import { ProductCombobox, type ProductOption } from '../../components/ProductCombobox';
import { fmtDateTime } from '../../lib/formatDateTime';

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
  /** ESC-3 (maker != checker): the creator may not approve their own PO — the server refuses it; the screen just does not offer it. */
  createdByUserId?: string | null;
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
  productSku: string;
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
  const { user, authz, can } = useAuth();
  // F1.3 — first `can()` consumer: the goods-receipt form is shown by the Company's own capability (the node the server enforces); falls back to the legacy role gate only while the authorization view is unavailable.
  const canReceiveGoods = authz ? can('procurement.goods_receipt.create', 'editable') : false;
  const { t, preload } = useLanguage();
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [products, setProducts] = useState<ProductOption[]>([]);
  // Items assigned to each warehouse (D1) — `null` until loaded or if the call fails, in which case the picker falls back to every item.
  const [warehouseItems, setWarehouseItems] = useState<Array<{ warehouseId: string; productId: string }> | null>(null);
  const [orders, setOrders] = useState<PurchaseOrderRow[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PurchaseOrderDetail | null>(null);
  const [receipts, setReceipts] = useState<GoodsReceipt[]>([]);

  const [supplierId, setSupplierId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [draftLines, setDraftLines] = useState<DraftLine[]>([]);
  const [lineProductSearch, setLineProductSearch] = useState('');
  // The item actually picked from the list. Several items can share a name (different codes), so the line is added by this id, never by looking the name up.
  const [pickedProduct, setPickedProduct] = useState<ProductOption | null>(null);
  const [lineQty, setLineQty] = useState('');
  const [lineCost, setLineCost] = useState('');
  const [creating, setCreating] = useState(false);

  const [receiveQty, setReceiveQty] = useState<Record<string, string>>({});
  const [posting, setPosting] = useState(false);

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // PRC-01 — official on-hand / reserved / available for the order's warehouse (read-only, informational)
  const draftStock = useStockAvailability(warehouseId, draftLines.map((l) => l.productId));
  const detailStock = useStockAvailability(detail?.purchaseOrder.warehouseId, (detail?.lines ?? []).map((l) => l.productId));

  preload([
    'field.on_hand',
    'field.reserved',
    'field.available',
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
    'field.code',
    'error.product_already_on_transaction',
    'field.quantity',
    'action.create_purchase_order',
    'action.add_po_line',
    'action.submit',
    'action.approve',
    'panel.maker_cannot_decide',
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
      const [ord, sup, wh, prod, whItems] = await Promise.all([
        api.get<PurchaseOrderRow[]>('/procurement/purchase-orders'),
        api.get<Supplier[]>('/procurement/suppliers/all'),
        api.get<Warehouse[]>('/inventory/warehouses'),
        api.get<ProductOption[]>('/products/all'),
        api.get<Array<{ warehouseId: string; productId: string }>>('/inventory/warehouse-items').catch(() => null),
      ]);
      setOrders(ord);
      setSuppliers(sup);
      setWarehouses(wh);
      setProducts(prod);
      setWarehouseItems(whItems);
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
    try {
      const [d, gr] = await Promise.all([
        api.get<PurchaseOrderDetail>(`/procurement/purchase-orders/${id}`),
        api.get<GoodsReceipt[]>(`/procurement/goods-receipts/by-purchase-order/${id}`),
      ]);
      setDetail(d);
      setReceipts(gr);
    } catch (err) {
      // Foundation fix: called directly from a row onClick with no error handling.
      setError(err instanceof ApiError ? err.message : 'Failed to load purchase order detail.');
    }
    setReceiveQty({});
  }

  // Only the items assigned to the chosen warehouse are offered (all items while the assignments are unavailable).
  const pickerProducts = useMemo(() => {
    if (!warehouseItems || !warehouseId) return products;
    const assigned = new Set(warehouseItems.filter((w) => w.warehouseId === warehouseId).map((w) => w.productId));
    return products.filter((p) => assigned.has(p.id));
  }, [products, warehouseItems, warehouseId]);

  // An item already on the draft is no longer listed in the picker; a scanned or typed code for it still resolves and gets the duplicate warning below.
  const usedProductIds = useMemo(() => new Set(draftLines.map((l) => l.productId)), [draftLines]);

  function duplicateWarning(product: ProductOption): string {
    return `"${product.sku}" — ${t('error.product_already_on_transaction')}`;
  }

  function onPickProduct(product: ProductOption) {
    if (draftLines.some((l) => l.productId === product.id)) {
      setError(duplicateWarning(product));
      setTimeout(() => {
        setLineProductSearch('');
        setPickedProduct(null);
      }, 0); // after the picker has filled its own text
      return;
    }
    setError(null);
    setPickedProduct(product);
    setLineProductSearch(product.name);
  }

  function onSearchTextChange(text: string) {
    setLineProductSearch(text);
    setPickedProduct((prev) => (prev && prev.name === text ? prev : null));
  }

  function addDraftLine() {
    if (!lineProductSearch) return;
    const sameName = pickerProducts.filter((p) => p.name === lineProductSearch);
    const product = pickedProduct && pickedProduct.name === lineProductSearch ? pickedProduct : sameName.length === 1 ? sameName[0] : undefined;
    if (!product || !lineQty || !lineCost) return;
    if (draftLines.some((l) => l.productId === product.id)) {
      setError(duplicateWarning(product));
      return;
    }
    setError(null);
    setDraftLines((prev) => [...prev, { productId: product.id, productSku: product.sku, productName: product.name, quantity: lineQty, unitCostBase: lineCost }]);
    setLineProductSearch('');
    setPickedProduct(null);
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
  const productSku = (id: string) => products.find((p) => p.id === id)?.sku ?? '';

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.purchase_orders')}</h1>
      </div>

      {can('procurement.purchase_order.create', 'editable') && (
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
                <select
                  value={warehouseId}
                  onChange={(e) => {
                    setWarehouseId(e.target.value);
                    setLineProductSearch('');
                    setPickedProduct(null);
                    setError(null);
                  }}
                  required
                >
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
                <ProductCombobox products={pickerProducts} excludedIds={usedProductIds} value={lineProductSearch} onValueChange={onSearchTextChange} onSelect={onPickProduct} placeholder={t('field.product')} />
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
                    <th>{t('field.code')}</th>
                    <th>{t('field.product')}</th>
                    <th>{t('field.quantity')}</th>
                    <th>{t('field.on_hand')} / {t('field.reserved')} / {t('field.available')}</th>
                    <th>{t('field.unit_cost')}</th>
                    <th>{t('field.line_total')}</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {draftLines.map((l, i) => (
                    <tr key={i}>
                      <td>{l.productSku}</td>
                      <td>{l.productName}</td>
                      <td>{l.quantity}</td>
                      <StockCell stock={draftStock[l.productId]} />
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
                    <td colSpan={5} style={{ textAlign: 'end', fontWeight: 600 }}>
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

            {can('procurement.purchase_order.edit', 'editable') && (
              <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
                {detail.state === 'draft' && (
                  <button className="btn btn-secondary" disabled={busyAction === 'submit'} onClick={() => doTransition('submit')}>
                    {t('action.submit')}
                  </button>
                )}
                {detail.state === 'submitted' && (
                  <>
                    <button className="btn btn-primary" disabled={busyAction === 'approve' || (!!user && detail.purchaseOrder.createdByUserId === user.id)} onClick={() => doTransition('approve')}>
                      {t('action.approve')}
                    </button>
                    {(!!user && detail.purchaseOrder.createdByUserId === user.id) && <span style={{ fontSize: 12, opacity: 0.8 }} data-testid="maker-cannot-approve">{t('panel.maker_cannot_decide')}</span>}
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
                  <th>{t('field.code')}</th>
                  <th>{t('field.product')}</th>
                  <th>{t('field.quantity_ordered')}</th>
                  <th>{t('field.quantity_received')}</th>
                  <th>{t('field.on_hand')} / {t('field.reserved')} / {t('field.available')}</th>
                  {(detail.state === 'approved' || detail.state === 'partially_received') && <th>{t('action.post_goods_receipt')}</th>}
                </tr>
              </thead>
              <tbody>
                {detail.lines.map((l) => {
                  const remaining = Number(l.quantity) - Number(l.quantityReceived);
                  return (
                    <tr key={l.id}>
                      <td>{productSku(l.productId)}</td>
                      <td>{productName(l.productId)}</td>
                      <td>{l.quantity}</td>
                      <td>{l.quantityReceived}</td>
                      <StockCell stock={detailStock[l.productId]} />
                      {(detail.state === 'approved' || detail.state === 'partially_received') && (
                        <td>
                          {remaining > 0 && canReceiveGoods && (
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

            {(detail.state === 'approved' || detail.state === 'partially_received') && canReceiveGoods && (
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
                    {r.grNumber} — {fmtDateTime(r.createdAt)} <FinancialStatusCell id={r.id} />
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
