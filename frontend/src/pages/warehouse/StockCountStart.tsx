import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { ErrorState } from '../../components/ErrorState';
import { loadingLabel } from '../../lib/displayNames';

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

/** Directive §15 — "Create Count" picks a warehouse + the items to count; the physical entry happens on the next screen, and NOTHING touches the ledger until a supervisor approves the resulting variance. */
export function StockCountStart() {
  const navigate = useNavigate();
  const { t, preload } = useLanguage();
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [warehouseId, setWarehouseId] = useState('');
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);

  preload(['action.start_count', 'field.warehouse', 'field.product', 'field.sku', 'field.name', 'error.select_at_least_one_product']);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const [wh, prod] = await Promise.all([api.get<Warehouse[]>('/inventory/warehouses'), api.get<Product[]>('/products/all')]);
        setWarehouses(wh);
        setProducts(prod);
        if (wh[0]) setWarehouseId(wh[0].id);
      } catch (err) {
        // Foundation fix: this load had no error handling.
        setLoadError(err);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  function toggle(productId: string) {
    setSelectedProductIds((prev) => (prev.includes(productId) ? prev.filter((id) => id !== productId) : [...prev, productId]));
  }

  async function start() {
    if (selectedProductIds.length === 0) {
      setError(t('error.select_at_least_one_product'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const txn = await api.post<{ id: string }>('/warehouse-transactions/count', { warehouseId, productIds: selectedProductIds });
      navigate(`/stock-count/${txn.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to start the count.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div>
        <div className="page-header">
          <h1>{t('action.start_count')}</h1>
        </div>
        <div className="empty-state">{loadingLabel()}</div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div>
        <div className="page-header">
          <h1>{t('action.start_count')}</h1>
        </div>
        <ErrorState error={loadError} onRetry={() => window.location.reload()} />
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t('action.start_count')}</h1>
      </div>

      {error && <div className="error-text">{error}</div>}

      <div className="card" style={{ marginBottom: 20, maxWidth: 320 }}>
        <div className="form-field">
          <label>{t('field.warehouse')}</label>
          <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.code} — {w.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <h3>{t('field.product')}</h3>
      <table className="data-table">
        <thead>
          <tr>
            <th></th>
            <th>{t('field.sku')}</th>
            <th>{t('field.name')}</th>
          </tr>
        </thead>
        <tbody>
          {products.map((p) => (
            <tr key={p.id} onClick={() => toggle(p.id)} style={{ cursor: 'pointer' }}>
              <td>
                <input type="checkbox" checked={selectedProductIds.includes(p.id)} readOnly />
              </td>
              <td>{p.sku}</td>
              <td>{p.name}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="action-row">
        <button className="btn btn-primary" disabled={busy} onClick={start}>
          {t('action.start_count')} ({selectedProductIds.length})
        </button>
      </div>
    </div>
  );
}
