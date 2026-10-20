import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { STATUS_NAMES, currentLang, loadingLabel, nameOf } from '../../lib/displayNames';
import { fmtDateTime } from '../../lib/formatDateTime';

interface Supplier {
  id: string;
  code: string;
  legalName: string;
}
interface LedgerEntry {
  id: string;
  entryNumber: string;
  entryType: string;
  direction: 'debit' | 'credit';
  amount: string;
  entryDate: string;
  reference: string | null;
  reason: string | null;
  status: 'posted' | 'reversed';
}

const ENTRY_TYPES = ['supplier_invoice', 'payment', 'debit_note', 'credit_note', 'adjustment', 'opening_balance'];

/**
 * ADR-048 — "كشف حساب المورد": the exact mirror of `CustomerStatement.tsx`
 * for the payable side. Reads `GET /procurement/suppliers/:id/ledger`
 * (the same endpoint the Supplier detail panel's own ledger tab could use)
 * and computes the running balance client-side from that ordered feed —
 * one source of truth, never a second independent calculation.
 */
export function SupplierStatement() {
  const { t, preload } = useLanguage();
  const [searchParams, setSearchParams] = useSearchParams();

  preload([
    'nav.supplier_statement',
    'field.supplier',
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
    'action.search',
    'action.export',
    'panel.select_supplier_to_view_statement',
    'panel.no_ledger_entries',
  ]);

  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const supplierId = searchParams.get('supplierId') ?? '';
  const entryType = searchParams.get('entryType') ?? '';
  const [dateFrom, setDateFrom] = useState(searchParams.get('from') ?? '');
  const [dateTo, setDateTo] = useState(searchParams.get('to') ?? '');
  const [entries, setEntries] = useState<LedgerEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<Supplier[]>('/procurement/suppliers/all').then(setSuppliers).catch(() => undefined);
  }, []);

  async function search() {
    if (!supplierId) return;
    setError(null);
    try {
      const params = new URLSearchParams();
      if (dateFrom) params.set('from', dateFrom);
      if (dateTo) params.set('to', dateTo);
      const qs = params.toString();
      const data = await api.get<{ entries: LedgerEntry[]; balance: string }>(`/procurement/suppliers/${supplierId}/ledger${qs ? `?${qs}` : ''}`);
      setEntries(data.entries);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load statement.');
    }
  }

  useEffect(() => {
    if (supplierId) search();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supplierId]);

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next);
  }

  let running = 0;
  const rows = (entries ?? [])
    .filter((e) => !entryType || e.entryType === entryType)
    .map((e) => {
      running += e.direction === 'credit' ? Number(e.amount) : -Number(e.amount);
      return { ...e, runningBalance: running.toFixed(2) };
    });

  function exportCsv() {
    const header = ['Date', 'Type', 'Reference', 'Debit', 'Credit', 'Running Balance', 'Status'];
    const lines = rows.map((r) => [
      new Date(r.entryDate).toISOString(),
      r.entryType,
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
    a.download = `supplier-statement-${supplierId}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.supplier_statement')}</h1>
      </div>

      {error && <div className="error-text">{error}</div>}

      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.supplier')}</label>
            <select value={supplierId} onChange={(e) => setParam('supplierId', e.target.value)} style={{ minWidth: 220 }}>
              <option value="">—</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code} — {s.legalName}
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
                  {et}
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
          <button className="btn btn-primary" disabled={!supplierId} onClick={search}>
            {t('action.search')}
          </button>
          <button className="btn btn-secondary" disabled={!supplierId || rows.length === 0} onClick={exportCsv}>
            {t('action.export')}
          </button>
        </div>
      </div>

      {!supplierId ? (
        <div className="empty-state">{t('panel.select_supplier_to_view_statement')}</div>
      ) : entries === null ? (
        <div className="empty-state">{loadingLabel()}</div>
      ) : rows.length === 0 ? (
        <div className="empty-state">{t('panel.no_ledger_entries')}</div>
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
              <tr key={r.id} style={{ opacity: r.status === 'reversed' ? 0.5 : 1 }}>
                <td>{fmtDateTime(r.entryDate)}</td>
                <td>{r.entryType}</td>
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
    </div>
  );
}
