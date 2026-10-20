import { Link } from 'react-router-dom';
import { useLanguage } from '../context/LanguageContext';
import { overallState, traceStateOf, useTraceEvents } from '../lib/financialTrace';
import { nameOf, currentLang, FINANCIAL_EVENT_TYPES } from '../lib/displayNames';
import { translateRejectionReason } from '../lib/financialReason';

/**
 * NAV-07 — the financial consequence of an operational document, shown where the document lives:
 * Document → Financial status (Pending / Posted / Rejected) → Financial event → Journal (Open Journal). Read-only.
 */
export function FinancialTrace({ ids }: { ids: string[] }) {
  const { t, preload } = useLanguage();
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
                    {t(`value.financial_trace.${traceStateOf(e)}`)}
                  </span>
                  {e.rejectionReason && <div className="error-text">{translateRejectionReason(e.rejectionReason, currentLang())}</div>}
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
  const { t, preload } = useLanguage();
  const events = useTraceEvents([id]);
  preload(['value.financial_trace.pending', 'value.financial_trace.posted', 'value.financial_trace.rejected']);
  if (!events || events.length === 0) return <span style={{ opacity: 0.5 }}>—</span>;
  const state = overallState(events);
  if (state === 'none' || state === 'ignored') return <span style={{ opacity: 0.5 }}>—</span>;
  const journal = events.find((e) => e.journalEntryId)?.journalEntryId;
  const badge = (
    <span className={`status-badge${state === 'posted' ? '' : state === 'rejected' ? ' negative' : ''}`} data-testid={`trace-${state}`}>
      {t(`value.financial_trace.${state}`)}
    </span>
  );
  return journal && state === 'posted' ? <Link to={`/accounting/journals/${journal}`}>{badge}</Link> : badge;
}
