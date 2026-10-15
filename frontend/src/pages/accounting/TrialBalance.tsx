import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';

interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  accountType: string;
  normalBalance: string;
  debitBase: string;
  creditBase: string;
}
interface TrialBalance {
  rows: TrialBalanceRow[];
  totalDebitBase: string;
  totalCreditBase: string;
  /** CR-2026-10-15 — sums of the displayed (net) row figures; the footer shows these so it always equals the columns. */
  balanceTotalDebitBase: string;
  balanceTotalCreditBase: string;
  balanced: boolean;
}

const PRELOAD = [
  'nav.trial_balance',
  'field.account_code',
  'field.account_name',
  'field.account_type',
  'field.debit_base',
  'field.credit_base',
  'field.from_date',
  'field.to_date',
  'panel.trial_balance_footer',
  'panel.balanced',
  'panel.not_balanced',
  ...['asset', 'liability', 'equity', 'revenue', 'expense'].map((v) => `value.account_type.${v}`),
];

/** F03 — General Ledger read model. Reuses `getTrialBalance` (same source as `AccountingCover`'s own KPI). */
export function TrialBalance() {
  const { t, preload } = useLanguage();
  preload(PRELOAD);
  const navigate = useNavigate();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [tb, setTb] = useState<TrialBalance | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const qs = new URLSearchParams();
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    api
      .get<TrialBalance>(`/accounting/trial-balance${qs.toString() ? `?${qs}` : ''}`)
      .then(setTb)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load trial balance.'));
  }, [from, to]);

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.trial_balance')}</h1>
      </div>

      <div className="card" style={{ marginBottom: 20, display: 'flex', gap: 12, alignItems: 'flex-end' }}>
        <div className="form-field" style={{ marginBottom: 0 }}>
          <label>{t('field.from_date')}</label>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="form-field" style={{ marginBottom: 0 }}>
          <label>{t('field.to_date')}</label>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>

      {error && <div className="error-text">{error}</div>}

      {tb && (
        <>
          <p>
            <span className={tb.balanced ? 'status-badge positive' : 'status-badge negative'}>{t(tb.balanced ? 'panel.balanced' : 'panel.not_balanced')}</span>
          </p>
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('field.account_code')}</th>
                <th>{t('field.account_name')}</th>
                <th>{t('field.account_type')}</th>
                <th>{t('field.debit_base')}</th>
                <th>{t('field.credit_base')}</th>
              </tr>
            </thead>
            <tbody>
              {tb.rows.map((r) => (
                <tr key={r.accountId} style={{ cursor: 'pointer' }} onClick={() => navigate(`/accounting/ledger?accountId=${r.accountId}`)}>
                  <td>{r.code}</td>
                  <td>{r.name}</td>
                  <td>{t(`value.account_type.${r.accountType}`)}</td>
                  <td>{Number(r.debitBase) > 0 ? r.debitBase : ''}</td>
                  <td>{Number(r.creditBase) > 0 ? r.creditBase : ''}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 600 }}>
                <td colSpan={3}>{t('panel.trial_balance_footer')}</td>
                <td>{tb.balanceTotalDebitBase}</td>
                <td>{tb.balanceTotalCreditBase}</td>
              </tr>
            </tfoot>
          </table>
        </>
      )}
    </div>
  );
}
