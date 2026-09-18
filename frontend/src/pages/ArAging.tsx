import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useLanguage } from '../context/LanguageContext';

interface ArAgingRow {
  invoiceId: string;
  invoiceNumber: string;
  customerId: string;
  customerCode: string;
  customerName: string;
  dueDate: string | null;
  originalAmount: string;
  paidAmount: string;
  remaining: string;
  daysOverdue: number;
  bucket: 'current' | '1-30' | '31-60' | '61-90' | '90+';
}

const BUCKETS = ['current', '1-30', '31-60', '61-90', '90+'] as const;

/**
 * ERP UI Integration (CTO directive) — "أعمار الديون": every outstanding
 * invoice across every customer, bucketed Current/1-30/31-60/61-90/90+.
 * Reads `GET /ar-aging`, which reuses the SAME `computeAgingRow` formula
 * as the single-customer AR tab on Customer Account — never a second,
 * independently-derived calculation that could drift from it.
 */
export function ArAging() {
  const { t, preload } = useLanguage();
  const navigate = useNavigate();
  const [rows, setRows] = useState<ArAgingRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bucketFilter, setBucketFilter] = useState('');

  preload([
    'nav.ar_aging',
    'field.customer',
    'field.invoice_number',
    'field.due_date',
    'field.total_amount',
    'field.remaining',
    'field.days_overdue',
    'field.aging_bucket',
    'aging_bucket.current',
    'panel.no_invoices_yet',
  ]);

  useEffect(() => {
    api
      .get<ArAgingRow[]>('/ar-aging')
      .then(setRows)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load AR aging.'));
  }, []);

  const filtered = rows?.filter((r) => !bucketFilter || r.bucket === bucketFilter);
  const totalsByBucket = BUCKETS.map((b) => ({
    bucket: b,
    total: (rows ?? []).filter((r) => r.bucket === b).reduce((sum, r) => sum + Number(r.remaining), 0),
  }));

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.ar_aging')}</h1>
      </div>

      {error && <div className="error-text">{error}</div>}

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
        {totalsByBucket.map((t2) => (
          <button
            key={t2.bucket}
            className={bucketFilter === t2.bucket ? 'card kpi-tile tone-warning' : 'card kpi-tile'}
            style={{ minWidth: 130, textAlign: 'center', cursor: 'pointer', border: 'none' }}
            onClick={() => setBucketFilter(bucketFilter === t2.bucket ? '' : t2.bucket)}
          >
            <div className="value">{t2.total.toFixed(2)}</div>
            <div className="label">{t2.bucket === 'current' ? t('aging_bucket.current') : t2.bucket}</div>
          </button>
        ))}
      </div>

      {rows === null ? (
        <div className="empty-state">Loading…</div>
      ) : filtered && filtered.length === 0 ? (
        <div className="empty-state">{t('panel.no_invoices_yet')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.customer')}</th>
              <th>{t('field.invoice_number')}</th>
              <th>{t('field.due_date')}</th>
              <th>{t('field.total_amount')}</th>
              <th>{t('field.remaining')}</th>
              <th>{t('field.days_overdue')}</th>
              <th>{t('field.aging_bucket')}</th>
            </tr>
          </thead>
          <tbody>
            {filtered!.map((r) => (
              <tr key={r.invoiceId} style={{ cursor: 'pointer' }} onClick={() => navigate(`/invoices/${r.invoiceId}`)}>
                <td>
                  <a onClick={(e) => { e.stopPropagation(); navigate(`/customers/${r.customerId}/account`); }} style={{ cursor: 'pointer' }}>
                    {r.customerCode} — {r.customerName}
                  </a>
                </td>
                <td>{r.invoiceNumber}</td>
                <td>{r.dueDate ? new Date(r.dueDate).toLocaleDateString() : '—'}</td>
                <td>{r.originalAmount}</td>
                <td>{r.remaining}</td>
                <td>{r.daysOverdue}</td>
                <td>{r.bucket === 'current' ? t('aging_bucket.current') : r.bucket}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
