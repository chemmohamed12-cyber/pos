import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';

interface ApAgingRow {
  invoiceId: string;
  invoiceNumber: string;
  supplierId: string;
  supplierCode: string;
  supplierLegalName: string;
  dueDate: string | null;
  originalAmount: string;
  paidAmount: string;
  remaining: string;
  daysOverdue: number;
  bucket: 'current' | '1-30' | '31-60' | '61-90' | '90+';
}

const BUCKETS = ['current', '1-30', '31-60', '61-90', '90+'] as const;

/** ADR-048 — the "أعمار ذمم الموردين" screen, the exact mirror of `ArAging.tsx`. Reads `GET /procurement/supplier-invoices/ap-aging`, which reuses the SAME `computeAgingRow` formula as the per-supplier AP tab. */
export function ApAging() {
  const { t, preload } = useLanguage();
  const navigate = useNavigate();
  const [rows, setRows] = useState<ApAgingRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bucketFilter, setBucketFilter] = useState('');

  preload([
    'nav.ap_aging',
    'field.supplier',
    'field.invoice_number',
    'field.due_date',
    'field.total_amount',
    'field.remaining',
    'field.days_overdue',
    'field.bucket',
    'value.aging_bucket.current',
    'value.aging_bucket.1-30',
    'value.aging_bucket.31-60',
    'value.aging_bucket.61-90',
    'value.aging_bucket.90+',
    'panel.no_ap_aging_rows',
  ]);

  useEffect(() => {
    api
      .get<ApAgingRow[]>('/procurement/supplier-invoices/ap-aging')
      .then(setRows)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load AP aging.'));
  }, []);

  const filtered = rows?.filter((r) => !bucketFilter || r.bucket === bucketFilter);
  const totalsByBucket = BUCKETS.map((b) => ({
    bucket: b,
    total: (rows ?? []).filter((r) => r.bucket === b).reduce((sum, r) => sum + Number(r.remaining), 0),
  }));

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.ap_aging')}</h1>
      </div>

      {error && <div className="error-text">{error}</div>}

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
        {totalsByBucket.map((row) => (
          <button
            key={row.bucket}
            className={bucketFilter === row.bucket ? 'card kpi-tile tone-warning' : 'card kpi-tile'}
            style={{ minWidth: 130, textAlign: 'center', cursor: 'pointer', border: 'none' }}
            onClick={() => setBucketFilter(bucketFilter === row.bucket ? '' : row.bucket)}
          >
            <div className="value">{row.total.toFixed(2)}</div>
            <div className="label">{t(`value.aging_bucket.${row.bucket}`)}</div>
          </button>
        ))}
      </div>

      {rows === null ? (
        <div className="empty-state">Loading…</div>
      ) : filtered && filtered.length === 0 ? (
        <div className="empty-state">{t('panel.no_ap_aging_rows')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.supplier')}</th>
              <th>{t('field.invoice_number')}</th>
              <th>{t('field.due_date')}</th>
              <th>{t('field.total_amount')}</th>
              <th>{t('field.remaining')}</th>
              <th>{t('field.days_overdue')}</th>
              <th>{t('field.bucket')}</th>
            </tr>
          </thead>
          <tbody>
            {filtered!.map((r) => (
              <tr key={r.invoiceId} style={{ cursor: 'pointer' }} onClick={() => navigate('/supplier-invoices')}>
                <td>
                  {r.supplierCode} — {r.supplierLegalName}
                </td>
                <td>{r.invoiceNumber}</td>
                <td>{r.dueDate ? new Date(r.dueDate).toLocaleDateString() : '—'}</td>
                <td>{r.originalAmount}</td>
                <td>{r.remaining}</td>
                <td>{r.daysOverdue}</td>
                <td>{t(`value.aging_bucket.${r.bucket}`)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
