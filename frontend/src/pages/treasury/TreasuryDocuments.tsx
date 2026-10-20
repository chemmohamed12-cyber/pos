import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { ErrorState } from '../../components/ErrorState';
import { useAuth } from '../../context/AuthContext';
import { fmtDateTime } from '../../lib/formatDateTime';
import { loadingLabel } from '../../lib/displayNames';
import { DocStatusBadge, kindLabel, money, useTr, type DocStatus, type TreasuryDocumentRow } from './treasuryUi';

const TABS: Array<{ status: '' | DocStatus; ar: string; en: string }> = [
  { status: '', ar: 'الكل', en: 'All' },
  { status: 'draft', ar: 'مسودات', en: 'Drafts' },
  { status: 'submitted', ar: 'بانتظار الاعتماد', en: 'Awaiting approval' },
  { status: 'approved', ar: 'جاهزة للتنفيذ', en: 'Ready to execute' },
  { status: 'executed', ar: 'منفّذة', en: 'Executed' },
  { status: 'rejected', ar: 'مرفوضة', en: 'Rejected' },
];

/** T4 — every Treasury Document with its lifecycle status; the entry point to prepare, approve, execute and trace a financial movement. */
export function TreasuryDocuments() {
  const tr = useTr();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const status = (params.get('status') ?? '') as '' | DocStatus;
  const [rows, setRows] = useState<TreasuryDocumentRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  function load() {
    setRows(null);
    setError(null);
    api
      .get<TreasuryDocumentRow[]>(`/treasury/documents${status ? `?status=${status}` : ''}`)
      .then(setRows)
      .catch(setError);
  }
  useEffect(load, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <div className="page-header">
        <h1>{tr('مستندات الخزينة', 'Treasury documents')}</h1>
        {can('finance.cash_document.create', 'editable') && (
          <Link className="btn btn-primary" to="/treasury/documents/new">
            {tr('مستند جديد', 'New document')}
          </Link>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        {TABS.map((t) => (
          <button key={t.status} type="button" className={`btn ${status === t.status ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setParams(t.status ? { status: t.status } : {})}>
            {tr(t.ar, t.en)}
          </button>
        ))}
      </div>

      {error ? (
        <ErrorState error={error} onRetry={load} />
      ) : rows === null ? (
        <div className="empty-state">{loadingLabel()}</div>
      ) : rows.length === 0 ? (
        <div className="empty-state">{tr('لا توجد مستندات في هذه الحالة.', 'No documents in this state.')}</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>{tr('الرقم', 'Number')}</th>
                <th>{tr('الغرض', 'Purpose')}</th>
                <th>{tr('المبلغ', 'Amount')}</th>
                <th>{tr('التاريخ', 'Date')}</th>
                <th>{tr('المرجع', 'Reference')}</th>
                <th>{tr('الحالة', 'Status')}</th>
                <th>{tr('أُنشئ', 'Created')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id}>
                  <td>
                    <Link to={`/treasury/documents/${d.id}`}>{d.documentNumber}</Link>
                  </td>
                  <td>{kindLabel(tr, d.kind, d.subtype)}</td>
                  <td style={{ textAlign: 'end' }}>{money(d.amount)}</td>
                  <td>{d.businessDate}</td>
                  <td>{d.reference ?? '—'}</td>
                  <td>
                    <DocStatusBadge status={d.status} />
                  </td>
                  <td>{fmtDateTime(d.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
