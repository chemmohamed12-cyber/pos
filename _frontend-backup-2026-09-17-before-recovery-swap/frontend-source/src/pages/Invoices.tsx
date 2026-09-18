import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useLanguage } from '../context/LanguageContext';
import { StatusBadge } from '../components/StatusBadge';

interface InvoiceRow {
  id: string;
  invoiceNumber: string;
  customerId: string;
  customerCode: string;
  customerName: string;
  salesOrderId: string;
  totalAmount: string;
  remaining: string;
  dueDate: string | null;
  state: string;
  createdAt: string;
}

/**
 * ERP UI Integration (CTO directive) — "الفواتير": every invoice across
 * every customer the caller may see, reading the SAME `GET /invoices`
 * (Scope-filtered, one source of truth) the Customer Account page's own
 * per-customer invoice tab uses. Clicking a row opens the Invoice Detail.
 */
export function Invoices() {
  const { t, preload } = useLanguage();
  const navigate = useNavigate();
  const [rows, setRows] = useState<InvoiceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState('');

  preload([
    'nav.invoices',
    'field.invoice_number',
    'field.customer',
    'field.sales_order',
    'field.total_amount',
    'field.remaining',
    'field.due_date',
    'field.status',
    'field.created_at',
    'panel.no_invoices_yet',
  ]);

  useEffect(() => {
    api
      .get<InvoiceRow[]>('/invoices')
      .then(setRows)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load invoices.'));
  }, []);

  const filtered = rows?.filter((r) => {
    if (stateFilter && r.state !== stateFilter) return false;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return r.invoiceNumber.toLowerCase().includes(q) || r.customerCode.toLowerCase().includes(q) || r.customerName.toLowerCase().includes(q);
  });

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.invoices')}</h1>
      </div>

      {error && <div className="error-text">{error}</div>}

      <div className="card" style={{ marginBottom: 20, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <input placeholder={`${t('field.invoice_number')} / ${t('field.customer')}`} value={search} onChange={(e) => setSearch(e.target.value)} style={{ minWidth: 240 }} />
        <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
          <option value="">{t('field.all_document_types')}</option>
          {['draft', 'posted', 'partially_paid', 'paid', 'void'].map((s) => (
            <option key={s} value={s}>
              {t(`sales_invoice_lifecycle.state.${s}`)}
            </option>
          ))}
        </select>
      </div>

      {rows === null ? (
        <div className="empty-state">Loading…</div>
      ) : filtered && filtered.length === 0 ? (
        <div className="empty-state">{t('panel.no_invoices_yet')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.invoice_number')}</th>
              <th>{t('field.customer')}</th>
              <th>{t('field.total_amount')}</th>
              <th>{t('field.remaining')}</th>
              <th>{t('field.due_date')}</th>
              <th>{t('field.status')}</th>
            </tr>
          </thead>
          <tbody>
            {filtered!.map((r) => (
              <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/invoices/${r.id}`)}>
                <td>{r.invoiceNumber}</td>
                <td>{r.customerCode} — {r.customerName}</td>
                <td>{r.totalAmount}</td>
                <td>{r.remaining}</td>
                <td>{r.dueDate ? new Date(r.dueDate).toLocaleDateString() : '—'}</td>
                <td>
                  <StatusBadge code={`sales_invoice_lifecycle.state.${r.state}`} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
