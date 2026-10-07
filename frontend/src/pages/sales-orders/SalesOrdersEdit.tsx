import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, uploadFile } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';

interface Product {
  id: string;
  sku: string;
  name: string;
  status: string;
  unitPrice: string;
}
interface OrderLineRow {
  id: string;
  productId: string;
  quantity: number;
  discountAmount: string;
  repPrice: string | null;
  managerPrice: string | null;
}
interface OrderDetail {
  id: string;
  orderNumber: string;
  customerId: string;
  customerName: string | null;
  warehouseId: string | null;
  warehouseName: string | null;
  status: string;
  salesRepUserId: string;
  lines: OrderLineRow[];
}
interface Deposit {
  id: string;
}

interface Line {
  lineId?: string;
  productId: string;
  quantity: number;
  discountAmount: string;
  repPrice: string;
  managerPrice: string;
  /** The quantity this line ALREADY holds a reservation for — subtracted back into the available-stock check, since increasing up to this + available is always safe (the backend releases-then-re-reserves). New lines have 0. */
  reservedBaseline: number;
}

const emptyLine = (): Line => ({ productId: '', quantity: 1, discountAmount: '0', repPrice: '', managerPrice: '', reservedBaseline: 0 });

/**
 * Order Edit at Draft (CTO directive — "لازم يرجع يفتح شاشة الاوردر
 * كلها ويكون فيه امكانية اضافة صنف حذف صنف اضافة العربون"): re-opens the
 * order's own line-editing screen — same add/remove-item UX as Create —
 * pre-filled with its current lines, reachable only while the order is
 * still in `draft` (before it's ever sent to a supervisor). Customer/
 * warehouse/rep are fixed once an order exists (changing any of them
 * would invalidate the reservations already made against them) — only
 * line items and the deposit are editable here.
 */
export function SalesOrdersEdit() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can } = useAuth();
  const canSetManagerPrice = can('wf.sales.order.set_manager_price', 'editable');
  const { t, preload } = useLanguage();
  preload([
    'nav.sales_orders',
    'field.customer',
    'field.product',
    'field.quantity',
    'field.discount_amount',
    'field.list_price',
    'field.price_list_price',
    'field.rep_price',
    'field.manager_price',
    'field.line_total',
    'field.warehouse',
    'field.available_stock',
    'field.total_items',
    'field.total_discount',
    'field.total_price',
    'validation.insufficient_stock',
    'action.save',
    'action.cancel',
    'action.add_line',
    'action.remove_item',
    'panel.editing_draft_order',
    'panel.deposit_at_order_creation',
    'field.deposit_amount',
    'field.method',
    'method.bank_transfer',
    'method.cash',
    'method.wallet',
    'method.card',
    'field.reference',
    'field.deposit_receipt',
    'error.order_created_deposit_failed',
    'field.order_number',
  ]);

  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [priceListId, setPriceListId] = useState<string | null>(null);
  const [priceListItems, setPriceListItems] = useState<Map<string, string>>(new Map());
  const [stockByKey, setStockByKey] = useState<Map<string, number>>(new Map());
  const [lines, setLines] = useState<Line[]>([]);
  const [hasExistingDeposit, setHasExistingDeposit] = useState(false);
  const [depositAmount, setDepositAmount] = useState('');
  const [depositMethod, setDepositMethod] = useState('bank_transfer');
  const [depositReference, setDepositReference] = useState('');
  const [depositFile, setDepositFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!id) return;
    (async () => {
      try {
        const [detail, prods, deposit] = await Promise.all([
          api.get<OrderDetail>(`/sales-orders/${id}`),
          api.get<Product[]>('/products'),
          api.get<Deposit | null>(`/deposits?salesOrderId=${id}`),
        ]);
        setOrder(detail);
        setProducts(prods.filter((p) => p.status === 'active'));
        setHasExistingDeposit(!!deposit);
        setLines(
          detail.lines.map((l) => ({
            lineId: l.id,
            productId: l.productId,
            quantity: l.quantity,
            discountAmount: l.discountAmount,
            repPrice: l.repPrice ?? '',
            managerPrice: l.managerPrice ?? '',
            reservedBaseline: l.quantity,
          })),
        );
        const customer = await api.get<{ priceListId: string | null }>(`/customers/${detail.customerId}`).catch(() => null);
        setPriceListId(customer?.priceListId ?? null);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Failed to load order.');
      }
    })();
  }, [id]);

  useEffect(() => {
    if (!priceListId) {
      setPriceListItems(new Map());
      return;
    }
    api
      .get<Array<{ productId: string; price: string }>>(`/price-lists/${priceListId}/items`)
      .then((items) => setPriceListItems(new Map(items.map((i) => [i.productId, i.price]))));
  }, [priceListId]);

  useEffect(() => {
    if (!order?.warehouseId) return;
    const warehouseId = order.warehouseId;
    const productIds = [...new Set(lines.map((l) => l.productId).filter(Boolean))];
    const missing = productIds.filter((pid) => !stockByKey.has(`${warehouseId}:${pid}`));
    if (missing.length === 0) return;
    (async () => {
      const entries = await Promise.all(
        missing.map(async (pid) => {
          const res = await api.get<{ available: number }>(`/inventory/stock?warehouseId=${warehouseId}&productId=${pid}`);
          return [`${warehouseId}:${pid}`, res.available] as const;
        }),
      );
      setStockByKey((prev) => new Map([...prev, ...entries]));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.warehouseId, lines.map((l) => l.productId).join(',')]);

  function availableStockForLine(line: Line): number | null {
    if (!order?.warehouseId || !line.productId) return null;
    const raw = stockByKey.get(`${order.warehouseId}:${line.productId}`);
    if (raw === undefined) return null;
    return raw + line.reservedBaseline; // this line's own current hold is safe to keep/regrow into
  }

  function updateLine(index: number, patch: Partial<Line>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  function addLine() {
    setLines((prev) => [...prev, emptyLine()]);
  }

  function removeLine(index: number) {
    setLines((prev) => prev.filter((_, i) => i !== index));
  }

  function previewForLine(line: Line) {
    const product = products.find((p) => p.id === line.productId);
    const listPrice = product ? Number(product.unitPrice) : 0;
    const priceListPrice = priceListItems.has(line.productId) ? Number(priceListItems.get(line.productId)) : listPrice;
    const managerPrice = canSetManagerPrice && line.managerPrice ? Number(line.managerPrice) : null;
    const repPrice = line.repPrice ? Number(line.repPrice) : null;
    const appliedPrice = managerPrice ?? repPrice ?? priceListPrice;
    const discountAmount = Number(line.discountAmount || '0');
    const lineTotal = Math.max(0, appliedPrice * line.quantity - discountAmount);
    return { priceListPrice, lineTotal };
  }

  const validLines = lines.filter((l) => l.productId && l.quantity > 0);
  const totals = validLines.reduce(
    (acc, l) => {
      const p = previewForLine(l);
      acc.itemCount += l.quantity;
      acc.totalPrice += p.lineTotal;
      return acc;
    },
    { itemCount: 0, totalPrice: 0 },
  );

  const hasStockError = validLines.some((l) => {
    const available = availableStockForLine(l);
    return available !== null && l.quantity > available;
  });

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!id || hasStockError || validLines.length === 0) return;
    setError(null);
    setBusy(true);
    try {
      await api.post(`/sales-orders/${id}/draft-lines`, {
        lines: validLines.map((l) => ({
          ...(l.lineId ? { lineId: l.lineId } : {}),
          productId: l.productId,
          quantity: l.quantity,
          discountAmount: l.discountAmount || '0',
          ...(l.repPrice ? { repPrice: l.repPrice } : {}),
          ...(canSetManagerPrice && l.managerPrice ? { managerPrice: l.managerPrice } : {}),
        })),
      });

      if (!hasExistingDeposit && depositAmount.trim()) {
        try {
          let evidenceMediaAssetId: string | undefined;
          if (depositFile) {
            const asset = await uploadFile<{ id: string }>('/media/upload', depositFile);
            evidenceMediaAssetId = asset.id;
          }
          await api.post('/deposits', {
            salesOrderId: id,
            amount: depositAmount,
            method: depositMethod,
            ...(depositReference.trim() ? { reference: depositReference.trim() } : {}),
            ...(evidenceMediaAssetId ? { evidenceMediaAssetId } : {}),
          });
        } catch (depositErr) {
          setBusy(false);
          setError(`${t('error.order_created_deposit_failed')} ${depositErr instanceof ApiError ? depositErr.message : ''}`.trim());
          return;
        }
      }

      navigate(`/sales-orders/${id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save changes.');
    } finally {
      setBusy(false);
    }
  }

  if (!order) return <div className="empty-state">{error ?? 'Loading…'}</div>;

  return (
    <div>
      <div className="page-header">
        <h1>
          {t('nav.sales_orders')} — {order.orderNumber}
        </h1>
      </div>
      <div className="card" style={{ maxWidth: 960 }}>
        <p style={{ color: '#6b7280', fontSize: '0.85rem', marginTop: 0 }}>{t('panel.editing_draft_order')}</p>

        <form onSubmit={onSubmit}>
          <div className="detail-grid" style={{ marginBottom: 16 }}>
            <div className="detail-field">
              <div className="label">{t('field.customer')}</div>
              <div className="value">{order.customerName ?? '—'}</div>
            </div>
            <div className="detail-field">
              <div className="label">{t('field.warehouse')}</div>
              <div className="value">{order.warehouseName ?? '—'}</div>
            </div>
          </div>

          {lines.map((line, i) => {
            const preview = previewForLine(line);
            const available = availableStockForLine(line);
            const stockShort = available !== null && line.quantity > available;
            const isExisting = !!line.lineId;
            return (
              <div key={i} className="card" style={{ marginBottom: 10, padding: 12 }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <div className="form-field" style={{ flex: 1, minWidth: 220, marginBottom: 0 }}>
                    <label>{t('field.product')}</label>
                    <select
                      value={line.productId}
                      disabled={isExisting}
                      onChange={(e) => updateLine(i, { productId: e.target.value })}
                      required
                    >
                      <option value="" disabled>
                        —
                      </option>
                      {products.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.sku} — {p.name} ({p.unitPrice})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="form-field" style={{ width: 90, marginBottom: 0 }}>
                    <label>{t('field.quantity')}</label>
                    <input
                      type="number"
                      min={1}
                      value={line.quantity}
                      onChange={(e) => updateLine(i, { quantity: Number(e.target.value) })}
                      style={stockShort ? { borderColor: '#a3262d' } : undefined}
                      required
                    />
                  </div>
                  <div className="form-field" style={{ width: 100, marginBottom: 0 }}>
                    <label>{t('field.available_stock')}</label>
                    <input value={line.productId ? (available !== null ? available : '…') : '—'} readOnly disabled />
                  </div>
                  <div className="form-field" style={{ width: 100, marginBottom: 0 }}>
                    <label>{t('field.price_list_price')}</label>
                    <input value={line.productId ? preview.priceListPrice.toFixed(2) : '—'} readOnly disabled />
                  </div>
                  <div className="form-field" style={{ width: 100, marginBottom: 0 }}>
                    <label>{t('field.rep_price')}</label>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={line.repPrice}
                      onChange={(e) => updateLine(i, { repPrice: e.target.value })}
                    />
                  </div>
                  {canSetManagerPrice && (
                    <div className="form-field" style={{ width: 100, marginBottom: 0 }}>
                      <label>{t('field.manager_price')}</label>
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        value={line.managerPrice}
                        onChange={(e) => updateLine(i, { managerPrice: e.target.value })}
                      />
                    </div>
                  )}
                  <div className="form-field" style={{ width: 100, marginBottom: 0 }}>
                    <label>{t('field.discount_amount')}</label>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={line.discountAmount}
                      onChange={(e) => updateLine(i, { discountAmount: e.target.value })}
                    />
                  </div>
                  <div className="form-field" style={{ width: 100, marginBottom: 0 }}>
                    <label>{t('field.line_total')}</label>
                    <input value={line.productId ? preview.lineTotal.toFixed(2) : '—'} readOnly disabled />
                  </div>
                  {lines.length > 1 && (
                    <button type="button" className="btn btn-secondary" title={t('action.remove_item')} onClick={() => removeLine(i)}>
                      ×
                    </button>
                  )}
                </div>
                {stockShort && (
                  <div className="error-text" style={{ fontSize: '0.8rem', marginTop: 6 }}>
                    {t('validation.insufficient_stock')
                      .replace('{requested}', String(line.quantity))
                      .replace('{available}', String(available))
                      .replace('{shortfall}', String(line.quantity - (available ?? 0)))}
                  </div>
                )}
              </div>
            );
          })}

          <button type="button" className="btn btn-secondary" onClick={addLine} style={{ marginBottom: 16 }}>
            + {t('action.add_line')}
          </button>

          <div className="detail-grid" style={{ marginBottom: 16 }}>
            <div className="detail-field">
              <div className="label">{t('field.total_items')}</div>
              <div className="value">{totals.itemCount}</div>
            </div>
            <div className="detail-field">
              <div className="label">{t('field.total_price')}</div>
              <div className="value">{totals.totalPrice.toFixed(2)}</div>
            </div>
          </div>

          {!hasExistingDeposit && (
            <div className="card" style={{ marginBottom: 16, background: '#f9fafb' }}>
              <h3 style={{ marginTop: 0 }}>{t('panel.deposit_at_order_creation')}</h3>
              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <div className="form-field" style={{ marginBottom: 0 }}>
                  <label>{t('field.deposit_amount')}</label>
                  <input type="number" min="0" step="0.01" value={depositAmount} onChange={(e) => setDepositAmount(e.target.value)} />
                </div>
                <div className="form-field" style={{ marginBottom: 0 }}>
                  <label>{t('field.method')}</label>
                  <select value={depositMethod} onChange={(e) => setDepositMethod(e.target.value)}>
                    <option value="bank_transfer">{t('method.bank_transfer')}</option>
                    <option value="cash">{t('method.cash')}</option>
                    <option value="wallet">{t('method.wallet')}</option>
                    <option value="card">{t('method.card')}</option>
                  </select>
                </div>
                <div className="form-field" style={{ marginBottom: 0 }}>
                  <label>{t('field.reference')}</label>
                  <input value={depositReference} onChange={(e) => setDepositReference(e.target.value)} />
                </div>
                <div className="form-field" style={{ marginBottom: 0 }}>
                  <label>{t('field.deposit_receipt')}</label>
                  <input type="file" accept="image/*,.pdf" onChange={(e) => setDepositFile(e.target.files?.[0] ?? null)} />
                </div>
              </div>
            </div>
          )}

          {error && <div className="error-text">{error}</div>}

          <div className="action-row">
            <button className="btn btn-primary" type="submit" disabled={busy || hasStockError || validLines.length === 0}>
              {t('action.save')}
            </button>
            <button className="btn btn-secondary" type="button" onClick={() => navigate(`/sales-orders/${id}`)}>
              {t('action.cancel')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
