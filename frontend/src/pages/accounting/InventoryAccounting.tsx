import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { StatusBadge } from '../../components/StatusBadge';
import { ApprovalsPanel } from '../../components/ApprovalsPanel';

const INVENTORY_ADJUSTMENT_KINDS = ['physical_count_variance', 'valuation_write_down'] as const;
const INVENTORY_REQUEST_TYPE_CODES = INVENTORY_ADJUSTMENT_KINDS.map((k) => `accounting.inventory.${k}`);

interface Product {
  id: string;
  code: string;
  name: string;
}
interface Warehouse {
  id: string;
  code: string;
  name: string;
}
interface ReconciliationRun {
  id: string;
  asOfDate: string;
  status: 'open' | 'matched' | 'drift_found' | 'closed' | 'no_valuation_source';
  createdAt: string;
}

const PRELOAD = [
  'nav.inventory_accounting',
  'field.as_of_date',
  'field.reconciliation_status',
  'field.adjustment_kind',
  'field.amount',
  'field.reason',
  'field.product',
  'field.warehouse',
  'field.counter_account_code',
  'field.actions',
  'value.reconciliation_status.open',
  'value.reconciliation_status.matched',
  'value.reconciliation_status.drift_found',
  'value.reconciliation_status.closed',
  ...INVENTORY_ADJUSTMENT_KINDS.map((k) => `value.inventory_adjustment_kind.${k}`),
  'action.run_reconciliation',
  'action.close_reconciliation',
  'action.submit_inventory_adjustment',
  'field.current_unit_cost',
  'action.lookup_current_cost',
  'panel.no_inventory_reconciliations_yet',
  'panel.inventory_adjustment_submitted_approval',
  'panel.no_valuation_source',
];

/** F07 — Inventory Accounting (ADR-040). No prior frontend spec existed for this domain (confirmed absent from every terminology seed and from the recovered production bundle's own route list) — built directly against `inventory-accounting.controller.ts`. */
export function InventoryAccounting() {
  const { t, preload } = useLanguage();
  preload(PRELOAD);

  const [runs, setRuns] = useState<ReconciliationRun[] | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [adjProductId, setAdjProductId] = useState('');
  const [adjWarehouseId, setAdjWarehouseId] = useState('');
  const [adjKind, setAdjKind] = useState<(typeof INVENTORY_ADJUSTMENT_KINDS)[number]>('physical_count_variance');
  const [adjAmount, setAdjAmount] = useState('');
  const [adjReason, setAdjReason] = useState('');
  const [adjCounterAccount, setAdjCounterAccount] = useState('');
  const [currentCost, setCurrentCost] = useState<string | null>(null);
  const [costLookupBusy, setCostLookupBusy] = useState(false);

  async function lookupCurrentCost() {
    if (!adjProductId || !adjWarehouseId) return;
    setCostLookupBusy(true);
    setCurrentCost(null);
    setError(null);
    try {
      const result = await api.get<{ unitCostBase: string }>(`/inventory/valuation/current-cost?productId=${adjProductId}&warehouseId=${adjWarehouseId}`);
      setCurrentCost(result.unitCostBase);
    } catch {
      setCurrentCost(t('panel.no_valuation_source'));
    } finally {
      setCostLookupBusy(false);
    }
  }

  async function loadRuns() {
    try {
      setRuns(await api.get<ReconciliationRun[]>('/accounting/inventory/reconciliations'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load inventory reconciliations.');
    }
  }

  useEffect(() => {
    loadRuns();
    api.get<Product[]>('/products').then(setProducts).catch(() => setProducts([]));
    api.get<Warehouse[]>('/inventory/warehouses').then(setWarehouses).catch(() => setWarehouses([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runReconciliation() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/accounting/inventory/reconciliations', {});
      await loadRuns();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to run reconciliation.');
    } finally {
      setBusy(false);
    }
  }

  async function closeRun(id: string) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/accounting/inventory/reconciliations/${id}/close`);
      await loadRuns();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to close reconciliation.');
    } finally {
      setBusy(false);
    }
  }

  async function submitAdjustment(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.post<{ mode: string }>('/accounting/inventory/adjustments', {
        productId: adjProductId || undefined,
        warehouseId: adjWarehouseId || undefined,
        kind: adjKind,
        amount: adjAmount,
        reason: adjReason,
        counterAccountCode: adjCounterAccount,
      });
      setNotice(result.mode === 'approval' ? t('panel.inventory_adjustment_submitted_approval') : t('panel.cash_bank_adjustment_posted'));
      setAdjAmount('');
      setAdjReason('');
      setAdjCounterAccount('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to submit inventory adjustment.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.inventory_accounting')}</h1>
        <button className="btn btn-primary" disabled={busy} onClick={runReconciliation}>
          {t('action.run_reconciliation')}
        </button>
      </div>

      {error && <div className="error-text">{error}</div>}
      {notice && <div className="empty-state">{notice}</div>}

      <ApprovalsPanel requestTypeCodes={INVENTORY_REQUEST_TYPE_CODES} decidePath={(id) => `/accounting/inventory/approvals/${id}/decide`} onDecided={loadRuns} />

      {runs === null ? (
        <div className="empty-state">Loading…</div>
      ) : runs.length === 0 ? (
        <div className="empty-state">{t('panel.no_inventory_reconciliations_yet')}</div>
      ) : (
        <table className="data-table" style={{ marginBottom: 20 }}>
          <thead>
            <tr>
              <th>{t('field.as_of_date')}</th>
              <th>{t('field.reconciliation_status')}</th>
              <th>{t('field.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td>{r.asOfDate}</td>
                <td>
                  <StatusBadge code={`value.reconciliation_status.${r.status}`} />
                </td>
                <td>
                  {r.status !== 'closed' && (
                    <button className="btn btn-secondary" disabled={busy} onClick={() => closeRun(r.id)}>
                      {t('action.close_reconciliation')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>{t('action.submit_inventory_adjustment')}</h3>
        <form onSubmit={submitAdjustment} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="form-field" style={{ marginBottom: 0, minWidth: 180 }}>
            <label>{t('field.product')}</label>
            <select value={adjProductId} onChange={(e) => setAdjProductId(e.target.value)}>
              <option value="">—</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.code} — {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="form-field" style={{ marginBottom: 0, minWidth: 180 }}>
            <label>{t('field.warehouse')}</label>
            <select value={adjWarehouseId} onChange={(e) => setAdjWarehouseId(e.target.value)}>
              <option value="">—</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.code} — {w.name}
                </option>
              ))}
            </select>
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.current_unit_cost')}</label>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={!adjProductId || !adjWarehouseId || costLookupBusy}
                onClick={lookupCurrentCost}
              >
                {t('action.lookup_current_cost')}
              </button>
              {currentCost && <span>{currentCost}</span>}
            </div>
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.adjustment_kind')}</label>
            <select value={adjKind} onChange={(e) => setAdjKind(e.target.value as never)}>
              {INVENTORY_ADJUSTMENT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`value.inventory_adjustment_kind.${k}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.amount')}</label>
            <input type="number" min="0.01" step="0.01" value={adjAmount} onChange={(e) => setAdjAmount(e.target.value)} required />
          </div>
          <div className="form-field" style={{ marginBottom: 0, minWidth: 200 }}>
            <label>{t('field.reason')}</label>
            <input value={adjReason} onChange={(e) => setAdjReason(e.target.value)} required />
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.counter_account_code')}</label>
            <input value={adjCounterAccount} onChange={(e) => setAdjCounterAccount(e.target.value)} required />
          </div>
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {t('action.submit_inventory_adjustment')}
          </button>
        </form>
      </div>
    </div>
  );
}
