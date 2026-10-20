import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, newIdempotencyKey } from '../../lib/api';
import { ErrorState } from '../../components/ErrorState';
import { useAuth } from '../../context/AuthContext';
import { fmtDateTime } from '../../lib/formatDateTime';
import { loadingLabel } from '../../lib/displayNames';
import { DocStatusBadge, kindLabel, money, useTr, type TreasuryDocumentRow } from './treasuryUi';

interface Effect {
  lines: Array<{ side: 'debit' | 'credit'; role: string; glAccountCode: string | null }>;
  note: string;
}

/** T4 — one Treasury Document: what it is, who did what and when, the accounting effect it WILL have, and only the actions its status and the caller's permissions allow. */
export function TreasuryDocumentDetail() {
  const tr = useTr();
  const { id } = useParams();
  const { can, user } = useAuth();
  const [doc, setDoc] = useState<TreasuryDocumentRow | null>(null);
  const [effect, setEffect] = useState<Effect | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [executeKey, setExecuteKey] = useState(newIdempotencyKey());

  function load() {
    setError(null);
    api.get<TreasuryDocumentRow>(`/treasury/documents/${id}`).then(setDoc).catch(setError);
    api.get<Effect>(`/treasury/documents/${id}/effect`).then(setEffect).catch(() => setEffect(null));
  }
  useEffect(load, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(path: string, payload: Record<string, unknown> = {}, opts?: { idempotencyKey?: string }) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/treasury/documents/${id}/${path}`, { expectedVersion: doc?.version, ...payload }, opts);
      setReason('');
      setNote('');
      setExecuteKey(newIdempotencyKey());
      load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (error && !doc) return <ErrorState error={error} onRetry={load} />;
  if (!doc) return <div className="empty-state">{loadingLabel()}</div>;

  const isPreparer = user?.id === doc.createdByUserId;
  const row = (label: string, value: React.ReactNode) => (
    <tr>
      <th style={{ textAlign: 'start', width: 220 }}>{label}</th>
      <td>{value}</td>
    </tr>
  );

  return (
    <div>
      <div className="page-header">
        <h1>
          {doc.documentNumber} <DocStatusBadge status={doc.status} />
        </h1>
        <Link className="btn btn-secondary" to="/treasury/documents">
          {tr('كل المستندات', 'All documents')}
        </Link>
      </div>

      {error ? <ErrorState error={error} /> : null}

      <div className="card" style={{ marginBottom: 16 }}>
        <table className="data-table">
          <tbody>
            {row(tr('الغرض', 'Purpose'), kindLabel(tr, doc.kind, doc.subtype))}
            {row(tr('المبلغ', 'Amount'), <strong>{money(doc.amount)}</strong>)}
            {row(tr('تاريخ المستند', 'Document date'), doc.businessDate)}
            {row(tr('المرجع', 'Reference'), doc.reference ?? '—')}
            {row(tr('الوصف', 'Description'), doc.purpose ?? '—')}
            {doc.reasonCode && row(tr('السبب', 'Reason'), doc.reasonCode)}
            {Number(doc.unappliedAmount) > 0 && row(tr('جزء غير مخصَّص', 'Unapplied part'), money(doc.unappliedAmount))}
            {row(tr('أُعدّ', 'Prepared'), fmtDateTime(doc.createdAt))}
            {doc.submittedAt && row(tr('أُرسل للاعتماد', 'Submitted'), fmtDateTime(doc.submittedAt))}
            {doc.approvedAt && row(tr('اعتُمد', 'Approved'), `${fmtDateTime(doc.approvedAt)}${doc.autoApproved ? ` — ${tr('اعتماد تلقائي (تحت حد الاعتماد)', 'automatic (below the approval limit)')}` : ''}`)}
            {doc.rejectionNote && row(tr('سبب الرفض', 'Rejection note'), doc.rejectionNote)}
            {doc.executedAt && row(tr('نُفّذ', 'Executed'), fmtDateTime(doc.executedAt))}
            {doc.reversedAt && row(tr('عُكس', 'Reversed'), `${fmtDateTime(doc.reversedAt)} — ${doc.reversalReason ?? ''}`)}
            {doc.cancelReason && row(tr('سبب الإلغاء', 'Cancel reason'), doc.cancelReason)}
            {doc.executedTransactionId && row(tr('حركة الخزينة', 'Treasury movement'), <Link to={`/treasury/ledger?accountId=${doc.treasuryAccountId}`}>{tr('عرض في سجل الخزينة', 'Open in the treasury ledger')}</Link>)}
          </tbody>
        </table>
      </div>

      {doc.allocations && doc.allocations.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginTop: 0 }}>{tr('توزيع التحصيل على الفواتير', 'Allocation to invoices')}</h3>
          <table className="data-table">
            <tbody>
              {doc.allocations.map((a) => (
                <tr key={a.id}>
                  <td>{a.invoiceId}</td>
                  <td style={{ textAlign: 'end' }}>{money(a.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {effect && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginTop: 0 }}>{tr('الأثر المحاسبي المتوقع', 'Expected accounting effect')}</h3>
          <table className="data-table">
            <tbody>
              {effect.lines.map((l, i) => (
                <tr key={i}>
                  <td>{l.side === 'debit' ? tr('مدين', 'Debit') : tr('دائن', 'Credit')}</td>
                  <td>{l.role}</td>
                  <td>{l.glAccountCode ?? '—'}</td>
                  <td style={{ textAlign: 'end' }}>{money(doc.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ opacity: 0.75, marginTop: 8 }}>{effect.note}</div>
        </div>
      )}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>{tr('الإجراءات', 'Actions')}</h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          {doc.status === 'draft' && isPreparer && (
            <>
              <Link className="btn btn-secondary" to={`/treasury/documents/${doc.id}/edit`}>{tr('تعديل', 'Edit')}</Link>
              <button className="btn btn-primary" type="button" disabled={busy || !can('finance.cash_document.submit', 'editable')} onClick={() => act('submit')}>
                {tr('إرسال للاعتماد', 'Submit for approval')}
              </button>
            </>
          )}
          {doc.status === 'submitted' && (
            <>
              {can('finance.cash_document.approve', 'editable') && !isPreparer ? (
                <>
                  <input placeholder={tr('ملاحظة (اختياري)', 'Note (optional)')} value={note} onChange={(e) => setNote(e.target.value)} />
                  <button className="btn btn-primary" type="button" disabled={busy} onClick={() => act('decide', { decision: 'approved', note: note || undefined, expectedVersion: undefined })}>
                    {tr('اعتماد', 'Approve')}
                  </button>
                  <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => act('decide', { decision: 'rejected', note: note || undefined, expectedVersion: undefined })}>
                    {tr('رفض', 'Reject')}
                  </button>
                </>
              ) : (
                <span style={{ opacity: 0.75 }}>{isPreparer ? tr('بانتظار اعتماد شخص آخر — لا يمكنك اعتماد مستندك.', 'Waiting for someone else to approve — you cannot approve your own document.') : tr('بانتظار الاعتماد.', 'Waiting for approval.')}</span>
              )}
            </>
          )}
          {doc.status === 'approved' && can('finance.cash_document.execute', 'editable') && (
            <button className="btn btn-primary" type="button" disabled={busy} onClick={() => act('execute', {}, { idempotencyKey: executeKey })}>
              {tr('تنفيذ الآن (يحرّك المبلغ)', 'Execute now (moves the money)')}
            </button>
          )}
          {doc.status === 'executed' && can('finance.cash_document.reverse', 'editable') && (
            <>
              <input placeholder={tr('سبب العكس', 'Reason for reversal')} value={reason} onChange={(e) => setReason(e.target.value)} />
              <button className="btn btn-secondary" type="button" disabled={busy || reason.trim().length < 3} onClick={() => act('reverse', { reason })}>
                {tr('عكس المستند', 'Reverse document')}
              </button>
            </>
          )}
          {['draft', 'submitted', 'approved', 'rejected'].includes(doc.status) && can('finance.cash_document.cancel', 'editable') && (
            <>
              <input placeholder={tr('سبب الإلغاء', 'Reason for cancelling')} value={reason} onChange={(e) => setReason(e.target.value)} />
              <button className="btn btn-secondary" type="button" disabled={busy || reason.trim().length < 3} onClick={() => act('cancel', { reason })}>
                {tr('إلغاء', 'Cancel')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
