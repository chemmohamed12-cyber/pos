import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { StatusBadge } from '../../components/StatusBadge';

interface GrniSubledgerBalance {
  purchaseOrderId: string;
  supplierId: string;
  balance: string;
  goodsReceiptId: string | null;
  goodsReceiptNumber: string | null;
}
interface GrniDriftBreakdown {
  note?: string;
  subledgerReceiptCount?: number;
  subledgerBalances?: GrniSubledgerBalance[];
  glClosingBalanceBase?: string;
  glLineCount?: number;
}
interface GrniReconciliationRun {
  id: string;
  asOfDate: string;
  subledgerTotalBase: string | null;
  glBalanceBase: string;
  driftBase: string | null;
  status: 'open' | 'matched' | 'drift_found' | 'closed' | 'no_subledger_source';
  driftBreakdown: GrniDriftBreakdown | null;
  createdAt: string;
}

const PRELOAD = [
  'nav.grni_reconciliation',
  'field.as_of_date',
  'field.subledger_total',
  'field.gl_balance',
  'field.drift',
  'field.reconciliation_status',
  'field.actions',
  'field.purchase_order',
  'field.gr_number',
  'field.supplier',
  'field.balance',
  'value.reconciliation_status.open',
  'value.reconciliation_status.matched',
  'value.reconciliation_status.drift_found',
  'value.reconciliation_status.closed',
  'value.reconciliation_status.no_subledger_source',
  'action.run_reconciliation',
  'action.close_reconciliation',
  'action.view_grni_detail',
  'panel.no_grni_reconciliations_yet',
  'panel.grni_drift_detail',
];

/** ADR-058 (Wave 1 Frontend Completion) — GRNI↔GL reconciliation. Mirrors `ApReconciliation.tsx`'s list/run/close shape; no adjustment mechanism exists for GRNI (ADR-057 §4), so none is offered here. */
export function GrniReconciliation() {
  const { t, preload } = useLanguage();
  preload(PRELOAD);

  const [runs, setRuns] = useState<GrniReconciliationRun[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailRun, setDetailRun] = useState<GrniReconciliationRun | null>(null);

  async function loadRuns() {
    try {
      setRuns(await api.get<GrniReconciliationRun[]>('/accounting/grni/reconciliations'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load GRNI reconciliations.');
    }
  }

  useEffect(() => {
    loadRuns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runReconciliation() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/accounting/grni/reconciliations', {});
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
      await api.post(`/accounting/grni/reconciliations/${id}/close`);
      await loadRuns();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to close reconciliation.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.grni_reconciliation')}</h1>
        <button className="btn btn-primary" disabled={busy} onClick={runReconciliation}>
          {t('action.run_reconciliation')}
        </button>
      </div>

      {error && <div className="error-text">{error}</div>}

      {runs === null ? (
        <div className="empty-state">Loading…</div>
      ) : runs.length === 0 ? (
        <div className="empty-state">{t('panel.no_grni_reconciliations_yet')}</div>
      ) : (
        <table className="data-table" style={{ marginBottom: 20 }}>
          <thead>
            <tr>
              <th>{t('field.as_of_date')}</th>
              <th>{t('field.subledger_total')}</th>
              <th>{t('field.gl_balance')}</th>
              <th>{t('field.drift')}</th>
              <th>{t('field.reconciliation_status')}</th>
              <th>{t('field.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td>{r.asOfDate}</td>
                <td>{r.subledgerTotalBase ?? '—'}</td>
                <td>{r.glBalanceBase}</td>
                <td>{r.driftBase ?? '—'}</td>
                <td>
                  <StatusBadge code={`value.reconciliation_status.${r.status}`} />
                </td>
                <td style={{ display: 'flex', gap: 6 }}>
                  {r.driftBreakdown && (
                    <button className="btn btn-secondary" onClick={() => setDetailRun(r)}>
                      {t('action.view_grni_detail')}
                    </button>
                  )}
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

      {detailRun?.driftBreakdown && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>{t('panel.grni_drift_detail')}</h3>
          {detailRun.driftBreakdown.note && <p>{detailRun.driftBreakdown.note}</p>}
          {detailRun.driftBreakdown.subledgerBalances && detailRun.driftBreakdown.subledgerBalances.length > 0 && (
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('field.purchase_order')}</th>
                  <th>{t('field.gr_number')}</th>
                  <th>{t('field.supplier')}</th>
                  <th>{t('field.balance')}</th>
                </tr>
              </thead>
              <tbody>
                {detailRun.driftBreakdown.subledgerBalances.map((b, idx) => (
                  <tr key={idx}>
                    <td>{b.purchaseOrderId}</td>
                    <td>{b.goodsReceiptNumber ?? '—'}</td>
                    <td>{b.supplierId}</td>
                    <td>{b.balance}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
