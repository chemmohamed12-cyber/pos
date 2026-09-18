import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';

interface GLAccount {
  id: string;
  code: string;
  name: string;
  nameAr: string | null;
}
interface LedgerLineRow {
  journalEntryId: string;
  entryNumber: string | null;
  businessDate: string;
  description: string | null;
  sourceType: string;
  lineDescription: string | null;
  debitBase: string;
  creditBase: string;
  runningBalanceBase: string;
}
interface AccountLedger {
  account: { id: string; code: string; name: string; accountType: string; normalBalance: string };
  openingBalanceBase: string;
  periodDebitBase: string;
  periodCreditBase: string;
  closingBalanceBase: string;
  lines: LedgerLineRow[];
}

const PRELOAD = [
  'nav.general_ledger',
  'field.account_code',
  'field.opening_balance',
  'field.period_movement',
  'field.closing_balance',
  'field.business_date',
  'field.debit_base',
  'field.credit_base',
  'field.description',
  'field.entry_number',
  'field.from_date',
  'field.to_date',
];

/** F03 — General Ledger read model. Account picker + date range, mirrors `TreasuryLedger.tsx`'s own filter shape. */
export function GeneralLedger() {
  const { t, preload } = useLanguage();
  preload(PRELOAD);
  const [searchParams] = useSearchParams();
  const [accounts, setAccounts] = useState<GLAccount[]>([]);
  const [accountId, setAccountId] = useState(searchParams.get('accountId') ?? '');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [ledger, setLedger] = useState<AccountLedger | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<GLAccount[]>('/accounting/accounts?postableOnly=true').then((a) => {
      setAccounts(a);
      if (!accountId && a[0]) setAccountId(a[0].id);
    }).catch(() => setAccounts([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!accountId) return;
    const qs = new URLSearchParams();
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    setError(null);
    api
      .get<AccountLedger>(`/accounting/ledger/${accountId}${qs.toString() ? `?${qs}` : ''}`)
      .then(setLedger)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load ledger.'));
  }, [accountId, from, to]);

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.general_ledger')}</h1>
      </div>

      <div className="card" style={{ marginBottom: 20, display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div className="form-field" style={{ marginBottom: 0, minWidth: 240 }}>
          <label>{t('field.account_code')}</label>
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.nameAr ?? a.name}
              </option>
            ))}
          </select>
        </div>
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

      {ledger && (
        <>
          <div className="detail-grid" style={{ marginBottom: 20 }}>
            <div className="kpi-tile">
              <div className="label">{t('field.opening_balance')}</div>
              <div className="value">{ledger.openingBalanceBase}</div>
            </div>
            <div className="kpi-tile">
              <div className="label">{t('field.debit_base')}</div>
              <div className="value">{ledger.periodDebitBase}</div>
            </div>
            <div className="kpi-tile">
              <div className="label">{t('field.credit_base')}</div>
              <div className="value">{ledger.periodCreditBase}</div>
            </div>
            <div className="kpi-tile">
              <div className="label">{t('field.closing_balance')}</div>
              <div className="value">{ledger.closingBalanceBase}</div>
            </div>
          </div>

          <table className="data-table">
            <thead>
              <tr>
                <th>{t('field.entry_number')}</th>
                <th>{t('field.business_date')}</th>
                <th>{t('field.description')}</th>
                <th>{t('field.debit_base')}</th>
                <th>{t('field.credit_base')}</th>
                <th>{t('field.closing_balance')}</th>
              </tr>
            </thead>
            <tbody>
              {ledger.lines.map((l, idx) => (
                <tr key={`${l.journalEntryId}-${idx}`}>
                  <td>{l.entryNumber ?? '—'}</td>
                  <td>{l.businessDate}</td>
                  <td>{l.lineDescription ?? l.description ?? '—'}</td>
                  <td>{Number(l.debitBase) > 0 ? l.debitBase : ''}</td>
                  <td>{Number(l.creditBase) > 0 ? l.creditBase : ''}</td>
                  <td>{l.runningBalanceBase}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
