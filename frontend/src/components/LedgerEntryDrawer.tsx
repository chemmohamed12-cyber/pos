import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useLanguage } from '../context/LanguageContext';
import { fmtDateTime } from '../lib/formatDateTime';

interface Bi {
  ar: string;
  en: string;
}
interface Details {
  entryId: string;
  entryNumber: string;
  date: string;
  typeLabel: Bi;
  description: Bi;
  direction: 'debit' | 'credit';
  amount: string;
  status: 'posted' | 'reversed';
  recordedReason: string | null;
  document: { type: string | null; number: string | null; link: string | null };
  invoice: { number: string; id: string | null; dueDate: string | null; link: string } | null;
  payment: { number: string; id: string | null; reversed: boolean } | null;
  treasury: { number: string; status: string | null } | null;
  createdBy: string | null;
  createdAt: string;
  technicalId: string;
  flags: string[];
  related: Array<{ id: string; entryNumber: string; typeLabel: Bi; direction: string; amount: string; status: string; date: string }>;
}

/** The side panel of ONE customer-ledger movement: what it is, why, which documents it belongs to, who recorded it and its reversal chain. Read-only. */
export function LedgerEntryDrawer({ entryId, onClose, onOpen, onChanged }: { entryId: string; onClose: () => void; onOpen?: (id: string) => void; onChanged?: () => void }) {
  const { lang } = useLanguage();
  const ar = lang === 'ar';
  const [d, setD] = useState<Details | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fixReason, setFixReason] = useState('');
  const [fixBusy, setFixBusy] = useState(false);

  const load = () =>
    api
      .get<Details>(`/customer-finance/entries/${entryId}/details`)
      .then(setD)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load the movement.'));

  useEffect(() => {
    setD(null);
    setError(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryId]);

  /** Completes the DOCUMENT side of a payment whose Treasury movement was already reversed (no second Treasury movement is created; refused if the GL booked the raw reversal). */
  async function completeReversal() {
    if (!d?.payment?.id || fixReason.trim().length < 3) return;
    setFixBusy(true);
    setError(null);
    try {
      await api.post(`/payments/${d.payment.id}/complete-reversal`, { reason: fixReason.trim() });
      setFixReason('');
      await load();
      onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to complete the reversal.');
    } finally {
      setFixBusy(false);
    }
  }

  const nf = ar ? 'غير محدد' : 'Not specified';
  const row = (label: string, value: React.ReactNode) => (
    <div className="detail-field" key={label}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );

  return (
    <div
      role="dialog"
      aria-label="ledger-entry-details"
      style={{ position: 'fixed', top: 0, bottom: 0, insetInlineEnd: 0, width: 'min(460px, 100%)', background: 'var(--card-bg, #fff)', boxShadow: '-4px 0 16px rgba(0,0,0,.2)', padding: 20, overflowY: 'auto', zIndex: 60 }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>{ar ? 'تفاصيل الحركة المالية' : 'Movement details'}</h3>
        <button className="btn btn-secondary" onClick={onClose}>
          {ar ? 'إغلاق' : 'Close'}
        </button>
      </div>
      {error && <div className="error-text">{error}</div>}
      {!d && !error && <div className="empty-state">…</div>}
      {d && (
        <>
          {d.flags.includes('cash_reversed_not_in_ledger') && (
            <div className="error-text" style={{ marginTop: 12 }}>
              {ar ? 'حركة الخزينة لهذه الدفعة معكوسة بينما حساب العميل لم يُعكس — يلزم إكمال العكس عبر مستند الدفعة.' : 'The Treasury movement of this payment was reversed but the customer ledger was not — complete the reversal through the payment document.'}
              {d.payment?.id && (
                <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                  <input placeholder={ar ? 'سبب إكمال العكس' : 'Reason'} value={fixReason} onChange={(e) => setFixReason(e.target.value)} />
                  <button className="btn btn-danger" disabled={fixBusy || fixReason.trim().length < 3} onClick={completeReversal} data-testid="complete-reversal">
                    {ar ? 'إكمال العكس عبر المستند' : 'Complete reversal'}
                  </button>
                </div>
              )}
            </div>
          )}
          <div className="detail-grid" style={{ marginTop: 14 }}>
            {row(ar ? 'رقم الحركة' : 'Entry no.', d.entryNumber)}
            {row(ar ? 'التاريخ والوقت' : 'Date / time', fmtDateTime(d.date))}
            {row(ar ? 'نوع الحركة' : 'Type', d.typeLabel[lang])}
            {row(ar ? 'البيان' : 'Description', d.description[lang])}
            {row(ar ? 'المبلغ' : 'Amount', `${d.direction === 'debit' ? (ar ? 'مدين' : 'Debit') : ar ? 'دائن' : 'Credit'} ${d.amount}`)}
            {row(ar ? 'الحالة' : 'Status', d.status === 'reversed' ? (ar ? 'معكوس' : 'Reversed') : ar ? 'مرحّل' : 'Posted')}
            {row(ar ? 'السبب المسجل' : 'Recorded reason', d.recordedReason ?? nf)}
            {row(
              ar ? 'المستند المصدر' : 'Source document',
              d.document.number ? d.document.link ? <Link to={d.document.link}>{d.document.number}</Link> : d.document.number : nf,
            )}
            {d.invoice && row(ar ? 'الفاتورة' : 'Invoice', <><Link to={d.invoice.link}>{d.invoice.number}</Link>{d.invoice.dueDate ? ` — ${ar ? 'الاستحقاق' : 'due'} ${d.invoice.dueDate}` : ''}</>)}
            {d.payment && row(ar ? 'إيصال الدفعة' : 'Payment receipt', `${d.payment.number}${d.payment.reversed ? (ar ? ' — معكوس عبر المستند' : ' — reversed through the document') : ''}`)}
            {d.treasury && row(ar ? 'حركة الخزينة' : 'Treasury movement', `${d.treasury.number}${d.treasury.status === 'reversed' ? (ar ? ' (معكوسة)' : ' (reversed)') : ''}`)}
            {row(ar ? 'سجّلها' : 'Recorded by', `${d.createdBy ?? nf} — ${fmtDateTime(d.createdAt)}`)}
            {row(ar ? 'المرجع التقني (للتدقيق)' : 'Technical reference (audit)', <span style={{ fontSize: '0.75rem', wordBreak: 'break-all' }}>{d.technicalId}</span>)}
          </div>
          {d.related.length > 0 && (
            <>
              <h4>{ar ? 'حركات مرتبطة (عكس / تسوية)' : 'Related movements (reversal / settlement)'}</h4>
              <ul>
                {d.related.map((x) => (
                  <li key={x.id}>
                    <a
                      href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        onOpen?.(x.id);
                      }}
                    >
                      {x.entryNumber}
                    </a>{' '}
                    — {x.typeLabel[lang]} — {x.direction === 'debit' ? (ar ? 'مدين' : 'Dr') : ar ? 'دائن' : 'Cr'} {x.amount} ({x.status === 'reversed' ? (ar ? 'معكوس' : 'reversed') : ar ? 'مرحّل' : 'posted'})
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
}
