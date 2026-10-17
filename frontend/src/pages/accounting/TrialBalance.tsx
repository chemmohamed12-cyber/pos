import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { useAutoRefresh } from '../../lib/useAutoRefresh';
import { RefreshStamp, PostingStatusChip } from '../../components/RefreshStamp';

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
/** C1 (ADR-INV-11) - `mode=periodic`: opening, period movement and closing per account, parents rolled up from the chart. */
interface PeriodicRow {
  accountId: string;
  code: string;
  name: string;
  accountType: string;
  isGroup: boolean;
  openingDebitBase: string;
  openingCreditBase: string;
  periodDebitBase: string;
  periodCreditBase: string;
  closingDebitBase: string;
  closingCreditBase: string;
}
interface PeriodicTrialBalance {
  rows: PeriodicRow[];
  totals: {
    openingDebitBase: string;
    openingCreditBase: string;
    periodDebitBase: string;
    periodCreditBase: string;
    closingDebitBase: string;
    closingCreditBase: string;
  };
  balanced: { opening: boolean; period: boolean; closing: boolean };
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
  'panel.tb_mode_periodic',
  'panel.tb_mode_standard',
  'field.tb_opening',
  'field.tb_period_debit',
  'field.tb_period_credit',
  'field.tb_closing',
  'panel.tb_balanced_opening',
  'panel.tb_balanced_period',
  'panel.tb_balanced_closing',
  ...['asset', 'liability', 'equity', 'revenue', 'expense'].map((v) => `value.account_type.${v}`),
];

const show = (v: string) => (Number(v) > 0 ? v : '');

/** F03 — General Ledger read model. Reuses `getTrialBalance` (same source as `AccountingCover`'s own KPI); C1 adds the periodic view and a drill-down that keeps the account AND the period. */
export function TrialBalance() {
  const { t, preload } = useLanguage();
  preload(PRELOAD);
  const navigate = useNavigate();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [periodic, setPeriodic] = useState(false);
  const [tb, setTb] = useState<TrialBalance | null>(null);
  const [ptb, setPtb] = useState<PeriodicTrialBalance | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useAutoRefresh(
    async (isCurrent) => {
      const qs = new URLSearchParams();
      if (from) qs.set('from', from);
      if (to) qs.set('to', to);
      if (periodic) qs.set('mode', 'periodic');
      try {
        const data = await api.get<TrialBalance | PeriodicTrialBalance>(`/accounting/trial-balance${qs.toString() ? `?${qs}` : ''}`);
        if (!isCurrent()) return;
        if (periodic) {
          setPtb(data as PeriodicTrialBalance);
          setTb(null);
        } else {
          setTb(data as TrialBalance);
          setPtb(null);
        }
        setError(null);
      } catch (err) {
        if (isCurrent()) setError(err instanceof ApiError ? err.message : 'Failed to load trial balance.');
        throw err;
      }
    },
    [from, to, periodic],
  );

  const drill = (accountId: string) => {
    const qs = new URLSearchParams({ accountId });
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    navigate(`/accounting/ledger?${qs}`);
  };

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>{t('nav.trial_balance')}</h1>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <PostingStatusChip />
          <RefreshStamp refresh={refresh} />
        </div>
      </div>

      <div className="card" style={{ marginBottom: 20, display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div className="form-field" style={{ marginBottom: 0 }}>
          <label>{t('field.from_date')}</label>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="form-field" style={{ marginBottom: 0 }}>
          <label>{t('field.to_date')}</label>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={periodic} onChange={(e) => setPeriodic(e.target.checked)} />
          {t(periodic ? 'panel.tb_mode_periodic' : 'panel.tb_mode_standard')}
        </label>
      </div>

      {error && <div className="error-text">{error}</div>}

      {tb && !periodic && (
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
                <tr key={r.accountId} style={{ cursor: 'pointer' }} onClick={() => drill(r.accountId)}>
                  <td>{r.code}</td>
                  <td>{r.name}</td>
                  <td>{t(`value.account_type.${r.accountType}`)}</td>
                  <td>{show(r.debitBase)}</td>
                  <td>{show(r.creditBase)}</td>
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

      {ptb && periodic && (
        <>
          <p style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {(['opening', 'period', 'closing'] as const).map((k) => (
              <span key={k} className={ptb.balanced[k] ? 'status-badge positive' : 'status-badge negative'}>
                {t(`panel.tb_balanced_${k}`)}
              </span>
            ))}
          </p>
          <table className="data-table">
            <thead>
              <tr>
                <th rowSpan={2}>{t('field.account_code')}</th>
                <th rowSpan={2}>{t('field.account_name')}</th>
                <th colSpan={2}>{t('field.tb_opening')}</th>
                <th colSpan={2}>{t('field.tb_period_debit')} / {t('field.tb_period_credit')}</th>
                <th colSpan={2}>{t('field.tb_closing')}</th>
              </tr>
              <tr>
                <th>{t('field.debit_base')}</th>
                <th>{t('field.credit_base')}</th>
                <th>{t('field.debit_base')}</th>
                <th>{t('field.credit_base')}</th>
                <th>{t('field.debit_base')}</th>
                <th>{t('field.credit_base')}</th>
              </tr>
            </thead>
            <tbody>
              {ptb.rows.map((r) => (
                <tr key={r.accountId} style={{ cursor: r.isGroup ? undefined : 'pointer', fontWeight: r.isGroup ? 600 : undefined }} onClick={() => !r.isGroup && drill(r.accountId)}>
                  <td>{r.code}</td>
                  <td>{r.name}</td>
                  <td>{show(r.openingDebitBase)}</td>
                  <td>{show(r.openingCreditBase)}</td>
                  <td>{show(r.periodDebitBase)}</td>
                  <td>{show(r.periodCreditBase)}</td>
                  <td>{show(r.closingDebitBase)}</td>
                  <td>{show(r.closingCreditBase)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 600 }}>
                <td colSpan={2}>{t('panel.trial_balance_footer')}</td>
                <td>{ptb.totals.openingDebitBase}</td>
                <td>{ptb.totals.openingCreditBase}</td>
                <td>{ptb.totals.periodDebitBase}</td>
                <td>{ptb.totals.periodCreditBase}</td>
                <td>{ptb.totals.closingDebitBase}</td>
                <td>{ptb.totals.closingCreditBase}</td>
              </tr>
            </tfoot>
          </table>
        </>
      )}
    </div>
  );
}
