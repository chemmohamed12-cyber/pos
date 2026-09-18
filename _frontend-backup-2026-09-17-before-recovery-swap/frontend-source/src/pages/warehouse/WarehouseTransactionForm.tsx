import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';

type TxnType = 'receipt' | 'issue' | 'transfer' | 'adjustment';

interface Warehouse {
  id: string;
  code: string;
  name: string;
  status: 'active' | 'inactive';
}

function todayDateInputValue(): string {
  return new Date().toISOString().slice(0, 10);
}
interface Product {
  id: string;
  sku: string;
  name: string;
}
interface Line {
  productId: string;
  quantity: number;
  available?: number;
}

const OUTBOUND_TYPES: TxnType[] = ['issue', 'transfer'];

/**
 * Warehouse & Inventory Control UX/UI V1 (CTO directive §8/§9) — ONE
 * reusable full-workspace form (not a modal) for creating any of
 * Receipt/Issue/Transfer/Adjustment, parameterized by `type`. Handles
 * 1 → 100+ lines: search-to-add, inline quantity edit, remove line,
 * duplicate-product detection, and live "requested > available"
 * validation for outbound types — before Submit, not after (directive §10).
 */
export function WarehouseTransactionForm({ type }: { type: TxnType }) {
  const navigate = useNavigate();
  const { t, preload } = useLanguage();
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [warehouseId, setWarehouseId] = useState('');
  const [destinationWarehouseId, setDestinationWarehouseId] = useState('');
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [movementDate, setMovementDate] = useState(todayDateInputValue());
  const [lines, setLines] = useState<Line[]>([]);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  preload([
    `action.create_${type}`,
    'field.warehouse',
    'field.destination_warehouse',
    'field.product',
    'field.quantity',
    'field.reason',
    'action.add_line',
    'action.save',
    'action.cancel',
    'field.reference',
    'field.notes',
    'field.movement_date',
    'field.available',
    'field.search_product_placeholder',
    'panel.no_lines_yet',
    'error.product_already_on_transaction',
    'error.add_at_least_one_line',
    'error.lines_exceed_available',
    'error.quantity_exceeds_available',
    `warehouse_txn_action.submit`,
  ]);

  useEffect(() => {
    (async () => {
      const [whAll, prod] = await Promise.all([
        api.get<Warehouse[]>('/inventory/warehouses'),
        api.get<Product[]>('/products/all'),
      ]);
      // Only active warehouses can receive new documents (server-enforced too) — don't offer an inactive one at all.
      const wh = whAll.filter((w) => w.status === 'active');
      setWarehouses(wh);
      setProducts(prod);
      if (wh[0]) setWarehouseId(wh[0].id);
    })();
  }, []);

  const isOutbound = OUTBOUND_TYPES.includes(type);

  useEffect(() => {
    if (!isOutbound || !warehouseId || lines.length === 0) return;
    (async () => {
      const withAvailability = await Promise.all(
        lines.map(async (l) => {
          const stock = await api.get<{ available: number }>(`/inventory/stock?warehouseId=${warehouseId}&productId=${l.productId}`);
          return { ...l, available: stock.available };
        }),
      );
      setLines(withAvailability);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [warehouseId]);

  const searchResults = useMemo(() => {
    if (!search.trim()) return [];
    const q = search.trim().toLowerCase();
    return products.filter((p) => p.sku.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)).slice(0, 8);
  }, [search, products]);

  async function addLine(product: Product) {
    if (lines.some((l) => l.productId === product.id)) {
      setError(`"${product.sku}" — ${t('error.product_already_on_transaction')}`);
      return;
    }
    setError(null);
    let available: number | undefined;
    if (isOutbound && warehouseId) {
      const stock = await api.get<{ available: number }>(`/inventory/stock?warehouseId=${warehouseId}&productId=${product.id}`);
      available = stock.available;
    }
    setLines((prev) => [...prev, { productId: product.id, quantity: 1, available }]);
    setSearch('');
  }

  function updateQuantity(productId: string, quantity: number) {
    setLines((prev) => prev.map((l) => (l.productId === productId ? { ...l, quantity } : l)));
  }

  function removeLine(productId: string) {
    setLines((prev) => prev.filter((l) => l.productId !== productId));
  }

  const overCapacityLines = lines.filter((l) => isOutbound && l.available !== undefined && l.quantity > l.available);

  async function save(alsoSubmit: boolean) {
    if (lines.length === 0) {
      setError(t('error.add_at_least_one_line'));
      return;
    }
    if (overCapacityLines.length > 0) {
      setError(t('error.lines_exceed_available'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await api.post<{ id: string }>('/warehouse-transactions', {
        type,
        warehouseId,
        destinationWarehouseId: type === 'transfer' ? destinationWarehouseId : undefined,
        lines: lines.map((l) => ({ productId: l.productId, quantity: l.quantity })),
        reference: reference || undefined,
        reason: reason || undefined,
        notes: notes || undefined,
        movementDate: movementDate ? new Date(movementDate).toISOString() : undefined,
      });
      if (alsoSubmit) {
        await api.post(`/warehouse-transactions/${created.id}/transition`, { action: 'submit' });
      }
      navigate(`/movement-center/${created.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save the transaction.');
    } finally {
      setBusy(false);
    }
  }

  const productName = (id: string) => {
    const p = products.find((x) => x.id === id);
    return p ? `${p.sku} — ${p.name}` : id;
  };

  return (
    <div>
      <div className="page-header">
        <h1>{t(`action.create_${type}`)}</h1>
        <button className="btn btn-secondary" onClick={() => navigate('/movement-center')}>
          {t('action.cancel')}
        </button>
      </div>

      {error && <div className="error-text">{error}</div>}

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="detail-grid">
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.warehouse')}</label>
            <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.code} — {w.name}
                </option>
              ))}
            </select>
          </div>
          {type === 'transfer' && (
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{t('field.destination_warehouse')}</label>
              <select value={destinationWarehouseId} onChange={(e) => setDestinationWarehouseId(e.target.value)}>
                <option value="">—</option>
                {warehouses.filter((w) => w.id !== warehouseId).map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.code} — {w.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.movement_date')}</label>
            <input type="date" value={movementDate} onChange={(e) => setMovementDate(e.target.value)} max={todayDateInputValue()} />
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.reference')}</label>
            <input value={reference} onChange={(e) => setReference(e.target.value)} />
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.reason')}</label>
            <input value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.notes')}</label>
            <input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ position: 'relative', maxWidth: 420, marginBottom: 14 }}>
          <input
            placeholder={t('field.search_product_placeholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {searchResults.length > 0 && (
            <div className="card" style={{ position: 'absolute', top: '100%', insetInlineStart: 0, right: 0, zIndex: 10, padding: 6, marginTop: 4 }}>
              {searchResults.map((p) => (
                <div
                  key={p.id}
                  style={{ padding: '6px 10px', cursor: 'pointer', borderRadius: 4 }}
                  onMouseDown={() => addLine(p)}
                  onMouseOver={(e) => (e.currentTarget.style.background = '#f3f4f6')}
                  onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  {p.sku} — {p.name}
                </div>
              ))}
            </div>
          )}
        </div>

        {lines.length === 0 ? (
          <div className="empty-state">{t('panel.no_lines_yet')}</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('field.product')}</th>
                {isOutbound && <th>{t('field.available')}</th>}
                <th>{t('field.quantity')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const over = isOutbound && l.available !== undefined && l.quantity > l.available;
                return (
                  <tr key={l.productId} style={over ? { background: '#fef2f2' } : undefined}>
                    <td>{productName(l.productId)}</td>
                    {isOutbound && <td>{l.available ?? '—'}</td>}
                    <td style={{ width: 120 }}>
                      <input
                        type="number"
                        min={1}
                        value={l.quantity}
                        onChange={(e) => updateQuantity(l.productId, Number(e.target.value))}
                        style={{ width: 90 }}
                      />
                      {over && (
                        <div style={{ color: '#a3262d', fontSize: '0.78rem', marginTop: 2 }}>
                          {t('error.quantity_exceeds_available')}
                        </div>
                      )}
                    </td>
                    <td>
                      <button className="btn btn-secondary" onClick={() => removeLine(l.productId)}>
                        ×
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="action-row">
        <button className="btn btn-secondary" disabled={busy} onClick={() => save(false)}>
          {t('action.save')}
        </button>
        <button className="btn btn-primary" disabled={busy} onClick={() => save(true)}>
          {t('action.save')} + {t('warehouse_txn_action.submit')}
        </button>
      </div>
    </div>
  );
}
