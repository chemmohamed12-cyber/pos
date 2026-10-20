import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useLanguage } from '../context/LanguageContext';
import { FinancialStatusCell } from '../components/FinancialTrace';
import { nameOf, currentLang, PAYMENT_METHODS } from '../lib/displayNames';
import { fmtDateTime } from '../lib/formatDateTime';

interface PaymentRow {
  id: string;
  paymentNumber: string;
  customerId: string;
  customerCode: string;
  customerName: string;
  invoiceId: string | null; // null = on-account / advance payment (CUS-01)
  invoiceNumber: string | null;
  amount: string;
  method: string;
  treasuryAccountId: string;
  reference: string | null;
  recordedByUserId: string;
  occurredAt: string;
}

/**
 * ERP UI Integration (CTO directive) — "التحصيلات والمدفوعات": every
 * payment across every customer the caller may see, reading the SAME
 * `GET /payments` (Scope-filtered) the Customer Account page's own
 * per-customer payment list uses. The Treasury link (`treasuryAccountId`)
 * stays exactly as recorded — this screen never posts a second one.
 */
export function Payments() {
  const { t, preload } = useLanguage();
  const navigate = useNavigate();
  const [rows, setRows] = useState<PaymentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  preload([
    'nav.payments',
    'field.payment_number',
    'field.customer',
    'field.invoice',
    'field.total_amount',
    'field.payment_method',
    'field.reference',
    'field.date',
    'field.actions',
    'action.print',
    'panel.no_payments_yet',
    'panel.customer_advance_unapplied',
  ]);

  useEffect(() => {
    api
      .get<PaymentRow[]>('/payments')
      .then(setRows)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load payments.'));
  }, []);

  const filtered = rows?.filter((r) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (
      r.paymentNumber.toLowerCase().includes(q) ||
      r.customerCode.toLowerCase().includes(q) ||
      r.customerName.toLowerCase().includes(q) ||
      (r.invoiceNumber ?? '').toLowerCase().includes(q)
    );
  });

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.payments')}</h1>
      </div>

      {error && <div className="error-text">{error}</div>}

      <div className="card" style={{ marginBottom: 20 }}>
        <input placeholder={`${t('field.payment_number')} / ${t('field.customer')} / ${t('field.invoice')}`} value={search} onChange={(e) => setSearch(e.target.value)} style={{ minWidth: 280 }} />
      </div>

      {rows === null ? (
        <div className="empty-state">Loading…</div>
      ) : filtered && filtered.length === 0 ? (
        <div className="empty-state">{t('panel.no_payments_yet')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.payment_number')}</th>
              <th>{t('field.customer')}</th>
              <th>{t('field.invoice')}</th>
              <th>{t('field.total_amount')}</th>
              <th>{t('field.payment_method')}</th>
              <th>{t('field.date')}</th>
              <th>{t('field.financial_status')}</th>
              <th>{t('field.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {filtered!.map((r) => (
              <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => navigate(r.invoiceId ? `/invoices/${r.invoiceId}` : `/customers/${r.customerId}/account`)}>
                <td>{r.paymentNumber}</td>
                <td>
                  <a onClick={(e) => { e.stopPropagation(); navigate(`/customers/${r.customerId}/account`); }} style={{ cursor: 'pointer' }}>
                    {r.customerCode} — {r.customerName}
                  </a>
                </td>
                <td>{r.invoiceId ? (r.invoiceNumber ?? '—') : t('panel.customer_advance_unapplied')}</td>
                <td>{r.amount}</td>
                <td>{nameOf(PAYMENT_METHODS, r.method, currentLang())}</td>
                <td>{fmtDateTime(r.occurredAt)}</td>
                <td onClick={(e) => e.stopPropagation()}>
                  <FinancialStatusCell id={r.id} />
                </td>
                <td>
                  <button className="btn btn-secondary" onClick={(e) => { e.stopPropagation(); window.open(`/print/payment/${r.id}`, '_blank'); }}>
                    {t('action.print')}
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
