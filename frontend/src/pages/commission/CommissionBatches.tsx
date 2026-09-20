import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { StatusBadge } from '../../components/StatusBadge';
import { ApprovalsPanel } from '../../components/ApprovalsPanel';

interface CommissionApprovalBatch {
  id: string;
  periodStart: string;
  periodEnd: string;
  status: 'draft' | 'submitted' | 'approved' | 'rejected';
  createdAt: string;
}

const COMMISSION_REQUEST_TYPE_CODES = ['commission.batch_approval'];

/** ADR-071 §6 — the Commission Approval Batch queue, mirrors Attendance's own proven batch shape. Submitting a batch sweeps every un-batched CommissionResult in the period; FA-01 is the one human control point before Payroll's own read contract can see them. */
export function CommissionBatches() {
  const { t, preload } = useLanguage();
  const [batches, setBatches] = useState<CommissionApprovalBatch[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [busy, setBusy] = useState(false);

  preload([
    'nav.commission_batches',
    'field.period_start',
    'field.period_end',
    'field.status',
    'action.submit_batch',
    'panel.no_batches_yet',
    'value.commission_batch_status.draft',
    'value.commission_batch_status.submitted',
    'value.commission_batch_status.approved',
    'value.commission_batch_status.rejected',
  ]);

  async function loadBatches() {
    try {
      setBatches(await api.get<CommissionApprovalBatch[]>('/commission/batches'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load commission approval batches.');
    }
  }

  useEffect(() => {
    loadBatches();
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/commission/batches/submit', { periodStart, periodEnd });
      setPeriodStart('');
      setPeriodEnd('');
      await loadBatches();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to submit commission approval batch.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.commission_batches')}</h1>
      </div>

      {error && <div className="error-text">{error}</div>}

      <div className="card" style={{ marginBottom: 20 }}>
        <h3>{t('action.submit_batch')}</h3>
        <form onSubmit={onSubmit} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.period_start')}</label>
            <input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} required />
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.period_end')}</label>
            <input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} required />
          </div>
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {t('action.submit_batch')}
          </button>
        </form>
      </div>

      <ApprovalsPanel requestTypeCodes={COMMISSION_REQUEST_TYPE_CODES} decidePath={(reqId) => `/commission/approvals/${reqId}/decide`} onDecided={loadBatches} />

      {batches === null ? (
        <div className="empty-state">Loading…</div>
      ) : batches.length === 0 ? (
        <div className="empty-state">{t('panel.no_batches_yet')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.period_start')}</th>
              <th>{t('field.period_end')}</th>
              <th>{t('field.status')}</th>
            </tr>
          </thead>
          <tbody>
            {batches.map((b) => (
              <tr key={b.id}>
                <td>{b.periodStart}</td>
                <td>{b.periodEnd}</td>
                <td>
                  <StatusBadge code={`value.commission_batch_status.${b.status}`} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
