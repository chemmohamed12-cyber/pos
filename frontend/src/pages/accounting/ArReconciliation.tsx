import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { StatusBadge } from '../../components/StatusBadge';
import { ApprovalsPanel } from '../../components/ApprovalsPanel';
import { loadingLabel } from '../../lib/displayNames';

const AR_ADJUSTMENT_KINDS = ['write_off', 'credit_note', 'debit_note', 'adjustment', 'opening_balance'] as const;
const AR_REQUEST_TYPE_CODES = AR_ADJUSTMENT_KINDS.map((k) => `accounting.ar.${k}`);

interface Customer {
  id: string;
  code: string;
  name: string;
}
interface ReconciliationRun {
  id: string;
  asOfDate: string;
  subledgerTotalBase: string;
  glBalanceBase: string;
  driftBase: string;
  status: 'open' | 'matched' | 'drift_found' | 'closed';
  createdAt: string;
}
interface StatementRow {
  date: string;
  description: string;
  debit: string;
  credit: string;
  balance: string;
}

const PRELOAD = [
  'nav.ar_reconciliation',
  'field.as_of_date',
  'field.subledger_total',
  'field.gl_balance',
  'field.drift',
  'field.reconciliation_status',
  'field.adjustment_kind',
  'field.amount',
  'field.reason',
  'field.contra_account_code',
  'field.customer',
  'field.actions',
  'value.reconciliation_status.open',
  'value.reconciliation_status.matched',
  'value.reconciliation_status.drift_found',
  'value.reconciliation_status.closed',
  ...AR_ADJUSTMENT_KINDS.map((k) => `value.ar_adjustment_kind.${k}`),
  'action.run_reconciliation',
  'action.close_reconciliation',
  'action.submit_ar_adjustment',
  'action.load_customer_statement',
  'action.save',
  'panel.no_reconciliations_yet',
  'panel.ar_reconciliation_matched',
  'panel.ar_reconciliation_drift',
  'panel.customer_ar_statement',
  'panel.ar_adjustment_submitted_approval',
  'panel.ar_adjustment_posted',
  'panel.ar_no_statement_rows',
];

/** F04 — Accounts Receivable (ADR-036). Reconciliation runs + adjustment submission + customer AR statement + pending-approvals queue. */
export function ArReconciliation() {
  const { t, preload } = useLanguage();
  preload(PRELOAD);

  const [runs, setRuns] = useState<ReconciliationRun[] | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [adjCustomerId, setAdjCustomerId] = useState('');
  const [adjKind, setAdjKind] = useState<(typeof AR_ADJUSTMENT_KINDS)[number]>('write_off');
  const [adjAmount, setAdjAmount] = useState('');
  const [adjReason, setAdjReason] = useState('');
  const [adjContraAccount, setAdjContraAccount] = useState('');

  const [stmtCustomerId, setStmtCustomerId] = useState('');
  const [statement, setStatement] = useState<StatementRow[] | null>(null);

  async function loadRuns() {
    try {
      setRuns(await api.get<ReconciliationRun[]>('/accounting/ar/reconciliations'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load AR reconciliations.');
    }
  }

  useEffect(() => {
    loadRuns();
    api.get<Customer[]>('/customers').then(setCustomers).catch(() => setCustomers([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runReconciliation() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/accounting/ar/reconciliations', {});
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
      await api.post(`/accounting/ar/reconciliations/${id}/close`);
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
      const result = await api.post<{ mode: string; approvalRequestId?: string; financialEventId?: string }>('/accounting/ar/adjustments', {
        customerId: adjCustomerId,
        kind: adjKind,
        amount: adjAmount,
        reason: adjReason,
        contraAccountCode: adjContraAccount || undefined,
      });
      setNotice(result.mode === 'approval' ? t('panel.ar_adjustment_submitted_approval') : t('panel.ar_adjustment_posted'));
      setAdjAmount('');
      setAdjReason('');
      setAdjContraAccount('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to submit AR adjustment.');
    } finally {
      setBusy(false);
    }
  }

  async function loadStatement() {
    if (!stmtCustomerId) return;
    setError(null);
    try {
      setStatement((await api.get<{ rows: StatementRow[] }>(`/accounting/ar/statement/${stmtCustomerId}`)).rows ?? []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load customer AR statement.');
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.ar_reconciliation')}</h1>
        <button className="btn btn-primary" disabled={busy} onClick={runReconciliation}>
          {t('action.run_reconciliation')}
        </button>
      </div>

      {error && <div className="error-text">{error}</div>}
      {notice && <div className="empty-state">{notice}</div>}

      <ApprovalsPanel requestTypeCodes={AR_REQUEST_TYPE_CODES} decidePath={(id) => `/accounting/ar/approvals/${id}/decide`} onDecided={loadRuns} />

      {runs === null ? (
        <div className="empty-state">{loadingLabel()}</div>
      ) : runs.length === 0 ? (
        <div className="empty-state">{t('panel.no_reconciliations_yet')}</div>
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
                <td>{r.subledgerTotalBase}</td>
                <td>{r.glBalanceBase}</td>
                <td>{r.driftBase}</td>
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

      <div className="card" style={{ marginBottom: 20 }}>
        <h3 style={{ marginTop: 0 }}>{t('action.submit_ar_adjustment')}</h3>
        <form onSubmit={submitAdjustment} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="form-field" style={{ marginBottom: 0, minWidth: 200 }}>
            <label>{t('field.customer')}</label>
            <select value={adjCustomerId} onChange={(e) => setAdjCustomerId(e.target.value)} required>
              <option value="">—</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} — {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.adjustment_kind')}</label>
            <select value={adjKind} onChange={(e) => setAdjKind(e.target.value as never)}>
              {AR_ADJUSTMENT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`value.ar_adjustment_kind.${k}`)}
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
          {adjKind === 'adjustment' && (
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{t('field.contra_account_code')}</label>
              <input value={adjContraAccount} onChange={(e) => setAdjContraAccount(e.target.value)} required />
            </div>
          )}
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {t('action.submit_ar_adjustment')}
          </button>
        </form>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>{t('panel.customer_ar_statement')}</h3>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginBottom: 12 }}>
          <div className="form-field" style={{ marginBottom: 0, minWidth: 220 }}>
            <label>{t('field.customer')}</label>
            <select value={stmtCustomerId} onChange={(e) => setStmtCustomerId(e.target.value)}>
              <option value="">—</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} — {c.name}
                </option>
              ))}
            </select>
          </div>
          <button className="btn btn-secondary" onClick={loadStatement} disabled={!stmtCustomerId}>
            {t('action.load_customer_statement')}
          </button>
        </div>
        {statement && (statement.length === 0 ? (
          <div className="empty-state">{t('panel.ar_no_statement_rows')}</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('field.business_date')}</th>
                <th>{t('field.description')}</th>
                <th>{t('field.debit')}</th>
                <th>{t('field.credit')}</th>
                <th>{t('field.closing_balance')}</th>
              </tr>
            </thead>
            <tbody>
              {statement.map((row, idx) => (
                <tr key={idx}>
                  <td>{row.date}</td>
                  <td>{row.description}</td>
                  <td>{row.debit}</td>
                  <td>{row.credit}</td>
                  <td>{row.balance}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      </div>
    </div>
  );
}
