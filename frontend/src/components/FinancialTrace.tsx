import { Link } from 'react-router-dom';
import { useLanguage } from '../context/LanguageContext';
import { overallState, traceStateOf, useTraceEvents } from '../lib/financialTrace';
import { nameOf, currentLang, FINANCIAL_EVENT_TYPES } from '../lib/displayNames';

/**
 * A rejected financial event means the ACCOUNTING entry was not created - the operational document itself (stock movement, receipt ...) is unaffected. These helpers say that in plain
 * language and translate the engine's known reasons; an unknown reason is shown as it is.
 */
function rejectedLabel(ar: boolean): string {
  return ar ? 'لم يُرحَّل محاسبيًا' : 'Not posted to accounts';
}
function friendlyReason(reason: string | null | undefined, ar: boolean): string | null {
  if (!reason) return null;
  const fiscal = /No fiscal year covers business date "?(\d{4}-\d{2}-\d{2})"?/i.exec(reason);
  if (fiscal) {
    return ar
      ? `لا توجد سنة مالية مفتوحة تغطي تاريخ ${fiscal[1]}، فلم يُنشأ القيد المحاسبي. أنشئ السنة المالية للشركة وفعّلها ثم أعد ترحيل الحدث.`
      : `No open fiscal year covers ${fiscal[1]}, so no accounting entry was created. Create and activate the Company's fiscal year, then re-drive the event.`;
  }
  // both wordings: 'no inventory control account' (older) and 'no active postable inventory control account and GRNI control account' (current, may name both)
  const noInventory = /no .*`?inventory`? control account/i.test(reason);
  const noGrni = /no .*`?grni`? control account/i.test(reason);
  if (noInventory || noGrni) {
    const what = [noInventory ? (ar ? 'المخزون' : 'inventory') : null, noGrni ? (ar ? 'بضاعة مستلمة لم تُفوتر (GRNI)' : 'goods received not invoiced (GRNI)') : null].filter(Boolean).join(ar ? ' و' : ' and ');
    return ar
      ? `لا يوجد حساب رقابي نشط في دليل حسابات الشركة (${what}). البضاعة دخلت المخزن فعلًا، لكن القيد المحاسبي لم يُنشأ؛ استخدم «إكمال الحسابات الرقابية» في دليل الحسابات ثم أعد ترحيل الحدث.`
      : `There is no active control account for ${what} in this Company's chart of accounts. The goods did enter the warehouse, but no accounting entry was created - use "Complete control accounts" in the chart of accounts, then re-drive the event.`;
  }
  if (/no .*account.* in the chart/i.test(reason)) {
    return ar ? 'حساب مطلوب غير موجود في دليل الحسابات، فلم يُنشأ القيد المحاسبي. (' + reason + ')' : 'A required account is missing from the chart of accounts, so no accounting entry was created. (' + reason + ')';
  }
  return reason;
}

/**
 * NAV-07 — the financial consequence of an operational document, shown where the document lives:
 * Document → Financial status (Pending / Posted / Rejected) → Financial event → Journal (Open Journal). Read-only.
 */
export function FinancialTrace({ ids }: { ids: string[] }) {
  const { t, preload, lang } = useLanguage();
  const ar = lang === 'ar';
  const events = useTraceEvents(ids);
  preload([
    'panel.financial_trace_title',
    'panel.financial_trace_none',
    'field.financial_status',
    'field.financial_event',
    'field.rejection_reason',
    'action.open_journal',
    'value.financial_trace.pending',
    'value.financial_trace.posted',
    'value.financial_trace.rejected',
    'value.financial_trace.ignored',
  ]);
  if (events === null || events === undefined) return null; // no permission / still loading: leave the screen as it was
  return (
    <div className="card" style={{ marginBottom: 20 }} data-testid="financial-trace">
      <h3 style={{ marginTop: 0 }}>{t('panel.financial_trace_title')}</h3>
      {events.length === 0 ? (
        <div style={{ fontSize: 13, opacity: 0.75 }}>{t('panel.financial_trace_none')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.financial_event')}</th>
              <th>{t('field.financial_status')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}>
                <td>
                  {nameOf(FINANCIAL_EVENT_TYPES, e.eventType, currentLang())}
                </td>
                <td>
                  <span className={`status-badge${traceStateOf(e) === 'posted' ? '' : traceStateOf(e) === 'rejected' ? ' negative' : ''}`} data-testid={`trace-${traceStateOf(e)}`}>
                    {traceStateOf(e) === 'rejected' ? rejectedLabel(ar) : t(`value.financial_trace.${traceStateOf(e)}`)}
                  </span>
                  {e.rejectionReason && <div className="error-text">{friendlyReason(e.rejectionReason, ar)}</div>}
                </td>
                <td>
                  {e.journalEntryId && (
                    <Link className="btn btn-secondary" to={`/accounting/journals/${e.journalEntryId}`}>
                      {t('action.open_journal')}
                    </Link>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Compact one-cell variant for list tables (status badge only; the detail view carries the full trace). */
export function FinancialStatusCell({ id }: { id: string }) {
  const { t, preload, lang } = useLanguage();
  const ar = lang === 'ar';
  const events = useTraceEvents([id]);
  preload(['value.financial_trace.pending', 'value.financial_trace.posted', 'value.financial_trace.rejected']);
  if (!events || events.length === 0) return <span style={{ opacity: 0.5 }}>—</span>;
  const state = overallState(events);
  if (state === 'none' || state === 'ignored') return <span style={{ opacity: 0.5 }}>—</span>;
  const journal = events.find((e) => e.journalEntryId)?.journalEntryId;
  const reason = state === 'rejected' ? friendlyReason(events.find((e) => e.rejectionReason)?.rejectionReason, ar) : null;
  const badge = (
    <span className={`status-badge${state === 'posted' ? '' : state === 'rejected' ? ' negative' : ''}`} data-testid={`trace-${state}`} title={reason ?? undefined}>
      {state === 'rejected' ? rejectedLabel(ar) : t(`value.financial_trace.${state}`)}
    </span>
  );
  if (journal && state === 'posted') return <Link to={`/accounting/journals/${journal}`}>{badge}</Link>;
  return reason ? (
    <>
      {badge}
      <div style={{ fontSize: '0.75rem', opacity: 0.75, maxWidth: 360 }}>{reason}</div>
    </>
  ) : (
    badge
  );
}
