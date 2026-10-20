import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { StatusBadge } from '../../components/StatusBadge';
import { ErrorState } from '../../components/ErrorState';
import { fmtDate } from '../../lib/formatDateTime';
import { loadingLabel } from '../../lib/displayNames';

interface Transaction {
  id: string;
  transactionNumber: string;
  type: string;
  warehouseId: string;
  destinationWarehouseId: string | null;
  reference: string | null;
  reason: string | null;
  reasonCode?: string | null;
  notes: string | null;
  reversalOfTransactionId: string | null;
  state: string;
  movementDate: string;
  createdAt: string;
}
interface Line {
  id: string;
  productId: string;
  quantity: number;
  systemQuantity: number | null;
  physicalQuantity: number | null;
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

/** Actions available per state — mirrors WAREHOUSE_TRANSACTION_ACTION_ROLES server-side, re-checked there regardless. */
const STATE_ACTIONS: Record<string, string[]> = {
  draft: ['submit'],
  submitted: ['recall', 'approve'],
  // 'approved' is normally a transient pass-through state (approve
  // auto-chains to post) — a transaction only ever visibly SITS here if
  // a previous posting attempt failed (e.g. stock became unavailable
  // between approval and posting); 'post' is the retry action.
  approved: ['post'],
  posted: ['reverse'],
};

export function WarehouseTransactionDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can } = useAuth();
  const { t, preload } = useLanguage();
  const [txn, setTxn] = useState<Transaction | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoadError(null);
    try {
      const [t2, l, wh, prod] = await Promise.all([
        api.get<Transaction>(`/warehouse-transactions/${id}`),
        api.get<Line[]>(`/warehouse-transactions/${id}/lines`),
        api.get<Warehouse[]>('/inventory/warehouses'),
        api.get<Product[]>('/products/all'),
      ]);
      setTxn(t2);
      setLines(l);
      setWarehouses(wh);
      setProducts(prod);
    } catch (err) {
      // Foundation fix: this load had no error handling — a failure left
      // the page stuck on "Loading…" forever with no explanation.
      setLoadError(err);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const availableActions = txn ? STATE_ACTIONS[txn.state] ?? [] : [];
  preload([
    'field.transaction_number',
    'field.warehouse',
    'field.destination_warehouse',
    'field.status',
    'field.product',
    'field.quantity',
    'field.type',
    'field.reference',
    'field.reason',
    'field.reason_code',
    'field.movement_date',
    'field.lines',
    'field.system_quantity',
    'field.physical_quantity',
    'field.variance',
    'action.print',
    'action.back',
    ...availableActions.map((a) => `warehouse_txn_action.${a}`),
    ...(txn ? [`warehouse_txn_type.${txn.type}`, `warehouse_txn_state.${txn.state}`] : []),
  ]);

  async function runAction(action: string) {
    if (!id) return;
    setBusy(action);
    setError(null);
    try {
      await api.post(`/warehouse-transactions/${id}/transition`, { action });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Failed to run "${action}".`);
    } finally {
      setBusy(null);
    }
  }

  if (loadError) return <ErrorState error={loadError} onRetry={load} />;
  if (!txn) return <div className="empty-state">{loadingLabel()}</div>;

  const warehouseName = (whId: string | null) => {
    if (!whId) return '—';
    const w = warehouses.find((x) => x.id === whId);
    return w ? `${w.code} — ${w.name}` : whId;
  };
  const productName = (pid: string) => {
    const p = products.find((x) => x.id === pid);
    return p ? `${p.sku} — ${p.name}` : pid;
  };

  return (
    <div>
      <div className="page-header">
        <h1>{txn.transactionNumber}</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary" onClick={() => window.open(`/print/warehouse-transaction/${txn.id}`, '_blank')}>
            {t('action.print')}
          </button>
          <button className="btn btn-secondary" onClick={() => navigate('/movement-center')}>
            {t('action.back')}
          </button>
        </div>
      </div>

      {error && <div className="error-text">{error}</div>}

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="detail-grid">
          <div className="detail-field">
            <div className="label">{t('field.type')}</div>
            <div className="value">{t(`warehouse_txn_type.${txn.type}`)}</div>
          </div>
          <div className="detail-field">
            <div className="label">{t('field.status')}</div>
            <div className="value">
              <StatusBadge code={`warehouse_txn_state.${txn.state}`} />
            </div>
          </div>
          <div className="detail-field">
            <div className="label">{t('field.warehouse')}</div>
            <div className="value">{warehouseName(txn.warehouseId)}</div>
          </div>
          <div className="detail-field">
            <div className="label">{t('field.movement_date')}</div>
            <div className="value">{fmtDate(txn.movementDate)}</div>
          </div>
          {txn.destinationWarehouseId && (
            <div className="detail-field">
              <div className="label">{t('field.destination_warehouse')}</div>
              <div className="value">{warehouseName(txn.destinationWarehouseId)}</div>
            </div>
          )}
          {txn.reference && (
            <div className="detail-field">
              <div className="label">{t('field.reference')}</div>
              <div className="value">{txn.reference}</div>
            </div>
          )}
          {txn.reasonCode && (
            <div className="detail-field">
              <div className="label">{t('field.reason_code')}</div>
              <div className="value">{txn.reasonCode}</div>
            </div>
          )}
          {txn.reason && (
            <div className="detail-field">
              <div className="label">{t('field.reason')}</div>
              <div className="value">{txn.reason}</div>
            </div>
          )}
        </div>

        <div className="action-row">
          {availableActions
            .filter((a) => a !== 'approve' || can('wf.inventory.warehouse_tx.approve', 'editable'))
            .filter((a) => a !== 'post' || can('wf.inventory.warehouse_tx.post', 'editable'))
            .filter((a) => a !== 'reverse' || can('wf.inventory.warehouse_tx.reverse', 'editable'))
            .map((a) => (
              <button
                key={a}
                className={a === 'reverse' ? 'btn btn-danger' : 'btn btn-primary'}
                disabled={busy !== null}
                onClick={() => runAction(a)}
              >
                {busy === a ? '...' : t(`warehouse_txn_action.${a}`)}
              </button>
            ))}
        </div>
      </div>

      <h3>{t('field.lines')}</h3>
      <table className="data-table">
        <thead>
          <tr>
            <th>{t('field.product')}</th>
            {txn.type === 'count' ? (
              <>
                <th>{t('field.system_quantity')}</th>
                <th>{t('field.physical_quantity')}</th>
                <th>{t('field.variance')}</th>
              </>
            ) : (
              <th>{t('field.quantity')}</th>
            )}
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.id}>
              <td>{productName(l.productId)}</td>
              {txn.type === 'count' ? (
                <>
                  <td>{l.systemQuantity}</td>
                  <td>{l.physicalQuantity ?? '—'}</td>
                  <td style={{ color: l.quantity !== 0 ? '#a3262d' : undefined }}>{l.quantity > 0 ? `+${l.quantity}` : l.quantity}</td>
                </>
              ) : (
                <td>{l.quantity}</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
