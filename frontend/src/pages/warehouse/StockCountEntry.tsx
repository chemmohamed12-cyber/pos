import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { StatusBadge } from '../../components/StatusBadge';
import { ErrorState } from '../../components/ErrorState';
import { loadingLabel } from '../../lib/displayNames';

interface Transaction {
  id: string;
  transactionNumber: string;
  state: string;
}
interface Line {
  id: string;
  productId: string;
  systemQuantity: number | null;
  physicalQuantity: number | null;
  quantity: number;
}
interface Product {
  id: string;
  sku: string;
  name: string;
}

/**
 * Directive §15: "Item | System Qty | Physical Qty | Variance" — entry
 * happens here while the count is still `draft`; submitting moves it to
 * `submitted`, and only a Warehouse Supervisor's `approve` actually
 * posts the variance as an Adjustment (directive §16: no direct stock edit).
 */
export function StockCountEntry() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can } = useAuth();
  const { t, preload } = useLanguage();
  const [txn, setTxn] = useState<Transaction | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [physical, setPhysical] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);

  preload([
    'action.back',
    'field.product',
    'field.system_quantity',
    'field.physical_quantity',
    'field.variance',
    'action.save_counts',
    'action.submit_count',
    'warehouse_txn_action.approve',
    ...(txn ? [`warehouse_txn_state.${txn.state}`] : []),
  ]);

  const load = useCallback(async () => {
    if (!id) return;
    setLoadError(null);
    try {
      const [t2, l, prod] = await Promise.all([
        api.get<Transaction>(`/warehouse-transactions/${id}`),
        api.get<Line[]>(`/warehouse-transactions/${id}/lines`),
        api.get<Product[]>('/products/all'),
      ]);
      setTxn(t2);
      setLines(l);
      setProducts(prod);
      setPhysical(Object.fromEntries(l.map((line) => [line.id, line.physicalQuantity !== null ? String(line.physicalQuantity) : ''])));
    } catch (err) {
      // Foundation fix: this load had no error handling — a failure left
      // the page stuck on "Loading…" forever with no explanation.
      setLoadError(err);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  if (loadError) return <ErrorState error={loadError} onRetry={load} />;
  if (!txn) return <div className="empty-state">{loadingLabel()}</div>;
  const productName = (pid: string) => {
    const p = products.find((x) => x.id === pid);
    return p ? `${p.sku} — ${p.name}` : pid;
  };

  async function saveCounts() {
    setBusy('save');
    setError(null);
    try {
      await api.post(`/warehouse-transactions/${id}/count-results`, {
        lines: lines.map((l) => ({ lineId: l.id, physicalQuantity: Number(physical[l.id] || 0) })),
      });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save counts.');
    } finally {
      setBusy(null);
    }
  }

  async function runAction(action: string) {
    setBusy(action);
    setError(null);
    try {
      await api.post(`/warehouse-transactions/${id}/transition`, { action });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Failed to ${action}.`);
    } finally {
      setBusy(null);
    }
  }

  const allEntered = lines.every((l) => physical[l.id] !== '' && physical[l.id] !== undefined);

  return (
    <div>
      <div className="page-header">
        <h1>{txn.transactionNumber}</h1>
        <button className="btn btn-secondary" onClick={() => navigate('/movement-center')}>
          {t('action.back')}
        </button>
      </div>

      {error && <div className="error-text">{error}</div>}

      <div className="card" style={{ marginBottom: 20 }}>
        <StatusBadge code={`warehouse_txn_state.${txn.state}`} />
      </div>

      <table className="data-table">
        <thead>
          <tr>
            <th>{t('field.product')}</th>
            <th>{t('field.system_quantity')}</th>
            <th>{t('field.physical_quantity')}</th>
            <th>{t('field.variance')}</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => {
            const entered = physical[l.id];
            const variance = entered !== '' && entered !== undefined ? Number(entered) - (l.systemQuantity ?? 0) : null;
            return (
              <tr key={l.id}>
                <td>{productName(l.productId)}</td>
                <td>{l.systemQuantity}</td>
                <td style={{ width: 120 }}>
                  {txn.state === 'draft' ? (
                    <input
                      type="number"
                      value={physical[l.id] ?? ''}
                      onChange={(e) => setPhysical((prev) => ({ ...prev, [l.id]: e.target.value }))}
                      style={{ width: 90 }}
                    />
                  ) : (
                    l.physicalQuantity
                  )}
                </td>
                <td style={{ color: variance ? '#a3262d' : undefined }}>{variance !== null ? (variance > 0 ? `+${variance}` : variance) : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="action-row">
        {txn.state === 'draft' && (
          <>
            <button className="btn btn-secondary" disabled={busy !== null} onClick={saveCounts}>
              {t('action.save_counts')}
            </button>
            <button className="btn btn-primary" disabled={busy !== null || !allEntered} onClick={() => runAction('submit')}>
              {t('action.submit_count')}
            </button>
          </>
        )}
        {txn.state === 'submitted' && can('wf.inventory.warehouse_tx.approve', 'editable') && (
          <button className="btn btn-primary" disabled={busy !== null} onClick={() => runAction('approve')}>
            {t('warehouse_txn_action.approve')}
          </button>
        )}
      </div>
    </div>
  );
}
