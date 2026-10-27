import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useLanguage } from '../context/LanguageContext';
import { StatusBadge } from '../components/StatusBadge';

interface TreasuryAccount {
  id: string;
  code: string;
  name: string;
  accountTypeName: string;
  status: 'active' | 'inactive';
  balance: string;
}

/** Treasury Hotfix — read-only current balances. Setup, GL mapping and status live in Treasury Settings; nothing here writes. */
export function TreasuryBalances() {
  const { t, lang, preload } = useLanguage();
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState<TreasuryAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ar = lang === 'ar';

  preload(['nav.treasury_balances', 'field.account_code', 'field.account_name', 'field.balance', 'field.status', 'field.actions', 'panel.treasury_ledger']);

  useEffect(() => {
    api
      .get<TreasuryAccount[]>('/treasury/accounts')
      .then(setAccounts)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load treasury balances.'));
  }, []);

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.treasury_balances') === 'nav.treasury_balances' ? (ar ? 'أرصدة حسابات الخزينة' : 'Treasury Account Balances') : t('nav.treasury_balances')}</h1>
      </div>
      {error && <div className="error-text">{error}</div>}
      {accounts === null ? (
        <div className="empty-state">Loading…</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('field.account_code')}</th>
                <th>{t('field.account_name')}</th>
                <th>{ar ? 'النوع' : 'Type'}</th>
                <th>{ar ? 'العملة' : 'Currency'}</th>
                <th>{t('field.status')}</th>
                <th>{t('field.balance')}</th>
                <th>{t('field.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id}>
                  <td>{a.code}</td>
                  <td>{a.name}</td>
                  <td>{a.accountTypeName || '—'}</td>
                  <td>{ar ? 'عملة الشركة الأساسية' : 'Company base currency'}</td>
                  <td>
                    <StatusBadge code={`warehouse_status.${a.status}`} />
                  </td>
                  <td style={{ fontWeight: 600 }}>{a.balance}</td>
                  <td>
                    <button className="btn btn-secondary" onClick={() => navigate(`/treasury/ledger?accountId=${a.id}`)}>
                      {t('panel.treasury_ledger')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
