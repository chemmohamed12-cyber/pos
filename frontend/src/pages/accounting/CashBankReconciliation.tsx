import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { StatusBadge } from '../../components/StatusBadge';
import { ApprovalsPanel } from '../../components/ApprovalsPanel';

const CASH_BANK_ADJUSTMENT_KINDS = ['bank_adjustment', 'opening_balance', 'unreconciled_write_off', 'reclassification'] as const;
const CASH_BANK_REQUEST_TYPE_CODES = CASH_BANK_ADJUSTMENT_KINDS.map((k) => `accounting.cash.${k}`);

interface TreasuryAccount {
  id: string;
  code: string;
  name: string;
}
interface ReconciliationRun {
  id: string;
  treasuryAccountId: string;
  asOfDate: string;
  treasuryLedgerTotalBase: string;
  glBalanceBase: string;
  driftBase: string;
  status: 'open' | 'matched' | 'drift_found' | 'closed';
}
interface StatementRow {
  date: string;
  description: string;
  debit: string;
  credit: string;
  balance: string;
}

const PRELOAD = [
  'nav.cash_bank_reconciliation',
  'field.as_of_date',
  'field.treasury_account',
  'field.treasury_ledger_total',
  'field.gl_balance',
  'field.gl_account_code',
  'field.drift',
  'field.reconciliation_status',
  'field.adjustment_kind',
  'field.amount',
  'field.reason',
  'field.counter_account_code',
  'field.contra_account_code',
  'field.actions',
  'field.from_date',
  'field.to_date',
  'value.reconciliation_status.open',
  'value.reconciliation_status.matched',
  'value.reconciliation_status.drift_found',
  'value.reconciliation_status.closed',
  ...CASH_BANK_ADJUSTMENT_KINDS.map((k) => `value.cash_bank_adjustment_kind.${k}`),
  'action.run_reconciliation',
  'action.close_reconciliation',
  'action.submit_cash_bank_adjustment',
  'action.load_cash_bank_statement',
  'panel.no_cash_bank_reconciliations_yet',
  'panel.cash_bank_reconciliation_matched',
  'panel.cash_bank_reconciliation_drift',
  'panel.cash_bank_position_statement',
  'panel.cash_bank_adjustment_submitted_approval',
  'panel.cash_bank_adjustment_posted',
  'panel.cash_bank_not_gl_mapped',
];

/** F06 — Cash & Bank (ADR-038). Mirror of AR/AP reconciliation, scoped per Treasury account. */
export function CashBankReconciliation() {
  const { t, preload } = useLanguage();
  preload(PRELOAD);

  const [accounts, setAccounts] = useState<TreasuryAccount[]>([]);
  const [filterAccountId, setFilterAccountId] = useState('');
  const [runs, setRuns] = useState<ReconciliationRun[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [adjAccountId, setAdjAccountId] = useState('');
  const [adjKind, setAdjKind] = useState<(typeof CASH_BANK_ADJUSTMENT_KINDS)[number]>('bank_adjustment');
  const [adjAmount, setAdjAmount] = useState('');
  const [adjReason, setAdjReason] = useState('');
  const [adjCounterAccount, setAdjCounterAccount] = useState('');

  const [stmtAccountId, setStmtAccountId] = useState('');
  const [statement, setStatement] = useState<StatementRow[] | null>(null);

  async function loadRuns() {
    try {
      const qs = filterAccountId ? `?treasuryAccountId=${filterAccountId}` : '';
      setRuns(await api.get<ReconciliationRun[]>(`/accounting/cash-bank/reconciliations${qs}`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load Cash/Bank reconciliations.');
    }
  }

  useEffect(() => {
    api.get<TreasuryAccount[]>('/treasury/accounts').then(setAccounts).catch(() => setAccounts([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadRuns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterAccountId]);

  async function runReconciliation() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/accounting/cash-bank/reconciliations', { treasuryAccountId: filterAccountId || undefined });
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
      await api.post(`/accounting/cash-bank/reconciliations/${id}/close`);
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
      const result = await api.post<{ mode: string }>('/accounting/cash-bank/adjustments', {
        treasuryAccountId: adjAccountId || undefined,
        kind: adjKind,
        amount: adjAmount,
        reason: adjReason,
        counterAccountCode: adjCounterAccount || undefined,
      });
      setNotice(result.mode === 'approval' ? t('panel.cash_bank_adjustment_submitted_approval') : t('panel.cash_bank_adjustment_posted'));
      setAdjAmount('');
      setAdjReason('');
      setAdjCounterAccount('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to submit Cash/Bank adjustment.');
    } finally {
      setBusy(false);
    }
  }

  async function loadStatement() {
    if (!stmtAccountId) return;
    setError(null);
    try {
      setStatement((await api.get<{ rows: StatementRow[] }>(`/accounting/cash-bank/statement?treasuryAccountId=${stmtAccountId}`)).rows ?? []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load Cash/Bank statement.');
    }
  }

  const accountLabel = (id: string) => {
    const a = accounts.find((x) => x.id === id);
    return a ? `${a.code} — ${a.name}` : id;
  };

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.cash_bank_reconciliation')}</h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select value={filterAccountId} onChange={(e) => setFilterAccountId(e.target.value)}>
            <option value="">{t('field.treasury_account')}</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.name}
              </option>
            ))}
          </select>
          <button className="btn btn-primary" disabled={busy} onClick={runReconciliation}>
            {t('action.run_reconciliation')}
          </button>
        </div>
      </div>

      {error && <div className="error-text">{error}</div>}
      {notice && <div className="empty-state">{notice}</div>}

      <ApprovalsPanel requestTypeCodes={CASH_BANK_REQUEST_TYPE_CODES} decidePath={(id) => `/accounting/cash-bank/approvals/${id}/decide`} onDecided={loadRuns} />

      {runs === null ? (
        <div className="empty-state">Loading…</div>
      ) : runs.length === 0 ? (
        <div className="empty-state">{t('panel.no_cash_bank_reconciliations_yet')}</div>
      ) : (
        <table className="data-table" style={{ marginBottom: 20 }}>
          <thead>
            <tr>
              <th>{t('field.treasury_account')}</th>
              <th>{t('field.as_of_date')}</th>
              <th>{t('field.treasury_ledger_total')}</th>
              <th>{t('field.gl_balance')}</th>
              <th>{t('field.drift')}</th>
              <th>{t('field.reconciliation_status')}</th>
              <th>{t('field.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td>{accountLabel(r.treasuryAccountId)}</td>
                <td>{r.asOfDate}</td>
                <td>{r.treasuryLedgerTotalBase}</td>
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
        <h3 style={{ marginTop: 0 }}>{t('action.submit_cash_bank_adjustment')}</h3>
        <form onSubmit={submitAdjustment} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="form-field" style={{ marginBottom: 0, minWidth: 200 }}>
            <label>{t('field.treasury_account')}</label>
            <select value={adjAccountId} onChange={(e) => setAdjAccountId(e.target.value)}>
              <option value="">—</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} — {a.name}
                </option>
              ))}
            </select>
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.adjustment_kind')}</label>
            <select value={adjKind} onChange={(e) => setAdjKind(e.target.value as never)}>
              {CASH_BANK_ADJUSTMENT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`value.cash_bank_adjustment_kind.${k}`)}
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
          {adjKind === 'reclassification' && (
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{t('field.counter_account_code')}</label>
              <input value={adjCounterAccount} onChange={(e) => setAdjCounterAccount(e.target.value)} required />
            </div>
          )}
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {t('action.submit_cash_bank_adjustment')}
          </button>
        </form>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>{t('panel.cash_bank_position_statement')}</h3>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginBottom: 12 }}>
          <div className="form-field" style={{ marginBottom: 0, minWidth: 220 }}>
            <label>{t('field.treasury_account')}</label>
            <select value={stmtAccountId} onChange={(e) => setStmtAccountId(e.target.value)}>
              <option value="">—</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} — {a.name}
                </option>
              ))}
            </select>
          </div>
          <button className="btn btn-secondary" disabled={!stmtAccountId} onClick={loadStatement}>
            {t('action.load_cash_bank_statement')}
          </button>
        </div>
        {statement && (
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
        )}
      </div>
    </div>
  );
}
