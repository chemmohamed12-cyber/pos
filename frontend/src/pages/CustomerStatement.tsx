import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useLanguage } from '../context/LanguageContext';
import { nameOf, currentLang, STATUS_NAMES } from '../lib/displayNames';
import { fmtDateTime } from '../lib/formatDateTime';

interface Customer {
  id: string;
  code: string;
  name: string;
}
interface LedgerEntry {
  id: string;
  entryNumber: string;
  entryType: string;
  direction: 'debit' | 'credit';
  amount: string;
  entryDate: string;
  salesOrderId: string | null;
  invoiceId: string | null;
  reference: string | null;
  reason: string | null;
  status: 'posted' | 'reversed';
  createdByUserId: string;
}

const ENTRY_TYPES = [
  'sales_invoice',
  'deposit',
  'payment',
  'cod_collection',
  'return_credit_note',
  'debit_note',
  'adjustment',
  'opening_balance',
  'refund',
];

/**
 * ERP UI Integration (CTO directive) — "كشف حساب العميل": a dedicated
 * statement screen, separate from the Customer Account dashboard's own
 * ledger tab, with real Date From/To + Document Type filters, Search,
 * Print, and Export. Reads the SAME `GET /customer-finance/ledger/:id`
 * the Customer Account page uses — one source of truth, computed running
 * balance client-side from that same ordered feed.
 */
export function CustomerStatement() {
  const { t, preload } = useLanguage();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  preload([
    'nav.customer_statement',
    'field.customer',
    'field.document_type',
    'field.all_document_types',
    'field.date_from',
    'field.date_to',
    'field.date',
    'field.type',
    'field.reference',
    'field.debit',
    'field.credit',
    'field.running_balance',
    'field.status',
    'field.recorded_by',
    'action.search',
    'action.print',
    'action.export',
    'panel.select_customer_to_view_statement',
    'panel.no_ledger_entries_yet',
    'customer_ledger_entry_type.sales_invoice',
    'customer_ledger_entry_type.deposit',
    'customer_ledger_entry_type.payment',
    'customer_ledger_entry_type.cod_collection',
    'customer_ledger_entry_type.return_credit_note',
    'customer_ledger_entry_type.debit_note',
    'customer_ledger_entry_type.adjustment',
    'customer_ledger_entry_type.opening_balance',
    'customer_ledger_entry_type.refund',
  ]);

  const [customers, setCustomers] = useState<Customer[]>([]);
  const customerId = searchParams.get('customerId') ?? '';
  const entryType = searchParams.get('entryType') ?? '';
  const [dateFrom, setDateFrom] = useState(searchParams.get('from') ?? '');
  const [dateTo, setDateTo] = useState(searchParams.get('to') ?? '');
  const [entries, setEntries] = useState<LedgerEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<Customer[]>('/customers').then(setCustomers).catch(() => undefined);
  }, []);

  async function search() {
    if (!customerId) return;
    setError(null);
    try {
      const params = new URLSearchParams();
      if (entryType) params.set('entryType', entryType);
      if (dateFrom) params.set('from', dateFrom);
      if (dateTo) params.set('to', dateTo);
      const qs = params.toString();
      const data = await api.get<LedgerEntry[]>(`/customer-finance/ledger/${customerId}${qs ? `?${qs}` : ''}`);
      setEntries(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load statement.');
    }
  }

  useEffect(() => {
    if (customerId) search();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next);
  }

  let running = 0;
  const rows = (entries ?? []).map((e) => {
    running += e.direction === 'debit' ? Number(e.amount) : -Number(e.amount);
    return { ...e, runningBalance: running.toFixed(2) };
  });

  function exportCsv() {
    const header = ['Date', 'Type', 'Reference', 'Debit', 'Credit', 'Running Balance', 'Status'];
    const lines = rows.map((r) => [
      new Date(r.entryDate).toISOString(),
      t(`customer_ledger_entry_type.${r.entryType}`),
      r.entryNumber,
      r.direction === 'debit' ? r.amount : '',
      r.direction === 'credit' ? r.amount : '',
      r.runningBalance,
      r.status,
    ]);
    const csv = [header, ...lines].map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `customer-statement-${customerId}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const selectedCustomer = customers.find((c) => c.id === customerId);

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.customer_statement')}</h1>
      </div>

      {error && <div className="error-text">{error}</div>}

      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.customer')}</label>
            <select value={customerId} onChange={(e) => setParam('customerId', e.target.value)} style={{ minWidth: 220 }}>
              <option value="">—</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} — {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.document_type')}</label>
            <select value={entryType} onChange={(e) => setParam('entryType', e.target.value)}>
              <option value="">{t('field.all_document_types')}</option>
              {ENTRY_TYPES.map((et) => (
                <option key={et} value={et}>
                  {t(`customer_ledger_entry_type.${et}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.date_from')}</label>
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.date_to')}</label>
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          </div>
          <button className="btn btn-primary" disabled={!customerId} onClick={search}>
            {t('action.search')}
          </button>
          <button className="btn btn-secondary" disabled={!customerId} onClick={() => window.open(`/print/customer-statement/${customerId}?entryType=${entryType}&from=${dateFrom}&to=${dateTo}`, '_blank')}>
            {t('action.print')}
          </button>
          <button className="btn btn-secondary" disabled={!customerId || rows.length === 0} onClick={exportCsv}>
            {t('action.export')}
          </button>
        </div>
      </div>

      {!customerId ? (
        <div className="empty-state">{t('panel.select_customer_to_view_statement')}</div>
      ) : entries === null ? (
        <div className="empty-state">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="empty-state">{t('panel.no_ledger_entries_yet')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.date')}</th>
              <th>{t('field.type')}</th>
              <th>{t('field.reference')}</th>
              <th>{t('field.debit')}</th>
              <th>{t('field.credit')}</th>
              <th>{t('field.running_balance')}</th>
              <th>{t('field.status')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                style={{ cursor: r.invoiceId || r.salesOrderId ? 'pointer' : 'default', opacity: r.status === 'reversed' ? 0.5 : 1 }}
                onClick={() => {
                  if (r.invoiceId) navigate(`/invoices/${r.invoiceId}`);
                  else if (r.salesOrderId) navigate(`/sales-orders/${r.salesOrderId}`);
                }}
              >
                <td>{fmtDateTime(r.entryDate)}</td>
                <td>{t(`customer_ledger_entry_type.${r.entryType}`)}</td>
                <td>{r.entryNumber}</td>
                <td>{r.direction === 'debit' ? r.amount : '—'}</td>
                <td>{r.direction === 'credit' ? r.amount : '—'}</td>
                <td>{r.runningBalance}</td>
                <td>{nameOf(STATUS_NAMES, r.status, currentLang())}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {selectedCustomer && (
        <div style={{ marginTop: 16 }}>
          <button className="btn btn-secondary" onClick={() => navigate(`/customers/${customerId}/account`)}>
            {t('action.view_customer_account')}
          </button>
        </div>
      )}
    </div>
  );
}
