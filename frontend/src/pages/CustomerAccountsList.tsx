import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useLanguage } from '../context/LanguageContext';

interface Customer {
  id: string;
  code: string;
  name: string;
  phone: string | null;
  governorate: string | null;
  creditLimit: string | null;
  financialStatus: 'active' | 'on_hold' | 'suspended';
}
interface BalanceRow {
  customerId: string;
  balance: string;
}

/**
 * ERP UI Integration (CTO directive) — "حسابات العملاء": the customer-facing
 * financial roll-up (balance / credit limit / available credit), reading
 * balances from the SAME `GET /customer-finance/balances` aggregate every
 * other new screen uses — never a second balance computation.
 */
export function CustomerAccountsList() {
  const { t, preload } = useLanguage();
  const navigate = useNavigate();
  const [rows, setRows] = useState<Array<Customer & { balance: string; availableCredit: string | null }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  preload([
    'nav.customer_accounts',
    'field.code',
    'field.name',
    'field.phone',
    'field.governorate',
    'field.balance',
    'field.credit_limit',
    'field.available_credit',
    'field.financial_status',
    'field.actions',
    'financial_status.active',
    'financial_status.on_hold',
    'financial_status.suspended',
    'action.view_customer_account',
    'panel.no_customer_accounts_yet',
  ]);

  useEffect(() => {
    (async () => {
      try {
        const [customers, balances] = await Promise.all([
          api.get<Customer[]>('/customers'),
          api.get<BalanceRow[]>('/customer-finance/balances'),
        ]);
        const balanceById = new Map(balances.map((b) => [b.customerId, b.balance]));
        setRows(
          customers.map((c) => {
            const balance = balanceById.get(c.id) ?? '0.00';
            const availableCredit = c.creditLimit != null ? (Number(c.creditLimit) - Number(balance)).toFixed(2) : null;
            return { ...c, balance, availableCredit };
          }),
        );
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Failed to load customer accounts.');
      }
    })();
  }, []);

  const filtered = rows?.filter((r) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return r.code.toLowerCase().includes(q) || r.name.toLowerCase().includes(q) || (r.phone ?? '').toLowerCase().includes(q);
  });

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.customer_accounts')}</h1>
      </div>

      {error && <div className="error-text">{error}</div>}

      <div className="card" style={{ marginBottom: 20 }}>
        <input placeholder={`${t('field.code')} / ${t('field.name')} / ${t('field.phone')}`} value={search} onChange={(e) => setSearch(e.target.value)} style={{ minWidth: 260 }} />
      </div>

      {rows === null ? (
        <div className="empty-state">Loading…</div>
      ) : filtered && filtered.length === 0 ? (
        <div className="empty-state">{t('panel.no_customer_accounts_yet')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.code')}</th>
              <th>{t('field.name')}</th>
              <th>{t('field.phone')}</th>
              <th>{t('field.governorate')}</th>
              <th>{t('field.balance')}</th>
              <th>{t('field.credit_limit')}</th>
              <th>{t('field.available_credit')}</th>
              <th>{t('field.financial_status')}</th>
              <th>{t('field.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {filtered!.map((r) => (
              <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/customers/${r.id}/account`)}>
                <td>{r.code}</td>
                <td>{r.name}</td>
                <td>{r.phone ?? '—'}</td>
                <td>{r.governorate ?? '—'}</td>
                <td>{r.balance}</td>
                <td>{r.creditLimit ?? '—'}</td>
                <td>{r.availableCredit ?? '—'}</td>
                <td>{t(`financial_status.${r.financialStatus}`)}</td>
                <td>
                  <button className="btn btn-secondary" onClick={(e) => { e.stopPropagation(); navigate(`/customers/${r.id}/account`); }}>
                    {t('action.view_customer_account')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
