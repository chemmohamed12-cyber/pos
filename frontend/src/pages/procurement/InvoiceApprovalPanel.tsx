import { useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';

export interface ApprovalInvoice {
  id: string;
  state: string;
  matchStatus?: string | null;
  matchDetail?: Array<{ invoiceLineId: string; variancePct: number | null; varianceAmount: number; exceeded: string[] }> | null;
  holdReason?: string | null;
  exceptionReason?: string | null;
  rejectedReason?: string | null;
}

/**
 * Phase C-1 - the approval workflow controls of one supplier invoice: Submit (draft), Approve / Reject (submitted), Approve as exception with a reason (on hold), Reopen (rejected),
 * plus the matching result. The server decides what is allowed (permission, state, independent approver); a refusal is shown as the server's message.
 */
export function InvoiceApprovalPanel({ invoice, approvalRequired, onChanged, onError }: { invoice: ApprovalInvoice; approvalRequired: boolean; onChanged: () => Promise<void>; onError: (m: string | null) => void }) {
  const { can } = useAuth();
  const { lang } = useLanguage();
  const L = (a: string, e: string) => (lang === 'ar' ? a : e);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  async function run(action: string, body?: Record<string, string>) {
    setBusy(action);
    onError(null);
    try {
      await api.post(`/procurement/supplier-invoices/${invoice.id}/${action}`, body);
      setReason('');
      await onChanged();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'The action failed.');
    } finally {
      setBusy(null);
    }
  }

  const s = invoice.state;
  const canSubmit = can('procurement.supplier_invoice.submit', 'editable');
  const canApprove = can('procurement.supplier_invoice.approve', 'editable');
  const canOverride = can('procurement.supplier_invoice.override', 'editable');
  const canCreate = can('procurement.supplier_invoice.create', 'editable');
  const exceeded = (invoice.matchDetail ?? []).filter((d) => d.exceeded.length > 0);
  const inWorkflow = ['submitted', 'on_hold', 'approved', 'rejected'].includes(s);
  if (!approvalRequired && !inWorkflow) return null;

  return (
    <div style={{ border: '1px solid var(--border, #ddd)', borderRadius: 6, padding: 10, marginBottom: 14 }}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>{L('اعتماد الفاتورة', 'Invoice approval')}</div>
      {invoice.matchStatus && (
        <div style={{ fontSize: 13, marginBottom: 6 }}>
          {L('نتيجة المطابقة', 'Matching result')}: <strong>{invoice.matchStatus === 'within_tolerance' ? L('ضمن الحدود', 'Within tolerance') : L('تتجاوز الحدود', 'Exceeds tolerance')}</strong>
        </div>
      )}
      {exceeded.length > 0 && (
        <ul style={{ fontSize: 12, margin: '0 0 6px', paddingInlineStart: 18 }}>
          {exceeded.map((d) => (
            <li key={d.invoiceLineId}>
              {L('فرق السعر', 'Price difference')}: {d.variancePct == null ? '—' : `${d.variancePct}%`} / {d.varianceAmount.toFixed(2)}
            </li>
          ))}
        </ul>
      )}
      {invoice.holdReason && s === 'on_hold' && <div style={{ fontSize: 12, marginBottom: 6 }}>{invoice.holdReason}</div>}
      {invoice.exceptionReason && <div style={{ fontSize: 12, marginBottom: 6 }}>{L('سبب الاستثناء', 'Exception reason')}: {invoice.exceptionReason}</div>}
      {invoice.rejectedReason && s === 'rejected' && <div style={{ fontSize: 12, marginBottom: 6 }}>{L('سبب الرفض', 'Rejection reason')}: {invoice.rejectedReason}</div>}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {s === 'draft' && approvalRequired && canSubmit && (
          <button className="btn btn-primary" disabled={busy === 'submit'} onClick={() => run('submit')}>
            {L('إرسال للاعتماد', 'Submit for approval')}
          </button>
        )}
        {s === 'submitted' && canApprove && (
          <button className="btn btn-primary" disabled={busy === 'approve'} onClick={() => run('approve')}>
            {L('اعتماد', 'Approve')}
          </button>
        )}
        {s === 'rejected' && canCreate && (
          <button className="btn btn-secondary" disabled={busy === 'reopen'} onClick={() => run('reopen')}>
            {L('إعادة فتح كمسودة', 'Reopen as draft')}
          </button>
        )}
      </div>

      {(s === 'submitted' || s === 'on_hold') && (canApprove || canOverride) && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={s === 'on_hold' ? L('سبب الاستثناء / الرفض', 'Exception / rejection reason') : L('سبب الرفض', 'Rejection reason')} maxLength={500} />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {s === 'on_hold' && canOverride && (
              <button className="btn btn-primary" disabled={busy === 'approve-exception' || reason.trim().length < 3} onClick={() => run('approve-exception', { reason })}>
                {L('اعتماد استثنائي', 'Approve as exception')}
              </button>
            )}
            {canApprove && (
              <button className="btn btn-danger" disabled={busy === 'reject' || reason.trim().length < 3} onClick={() => run('reject', { reason })}>
                {L('رفض', 'Reject')}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
