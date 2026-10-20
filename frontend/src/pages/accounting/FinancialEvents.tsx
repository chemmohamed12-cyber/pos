import { useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { StatusBadge } from '../../components/StatusBadge';
import { useAutoRefresh } from '../../lib/useAutoRefresh';
import { RefreshStamp, PostingStatusChip } from '../../components/RefreshStamp';
import { FINANCIAL_EVENT_TYPES, SOURCE_DOMAINS, loadingLabel, nameOf, sourceDomainOf } from '../../lib/displayNames';
import { translateRejectionReason } from '../../lib/financialReason';

interface FinancialEvent {
  id: string;
  eventType: string;
  sourceDomain: string;
  sourceEntityType: string;
  sourceEntityId: string;
  businessDate: string;
  status: 'RECEIVED' | 'MAPPED' | 'POSTED' | 'REJECTED' | 'IGNORED';
  journalEntryId: string | null;
  rejectionReason: string | null;
  receivedAt: string;
}

const PRELOAD = [
  'nav.financial_events',
  'field.business_date',
  'field.rejection_reason',
  'field.actions',
  'value.financial_event_status.received',
  'value.financial_event_status.mapped',
  'value.financial_event_status.posted',
  'value.financial_event_status.rejected',
  'value.financial_event_status.ignored',
  'action.redrive_financial_event',
  'panel.no_financial_events_yet',
];

/** F03 — Financial Event Engine (ADR-035). List + redrive for a REJECTED event. */
export function FinancialEvents() {
  const { t, preload, lang } = useLanguage();
  preload(PRELOAD);
  const [status, setStatus] = useState('');
  const [events, setEvents] = useState<FinancialEvent[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useAutoRefresh(
    async (isCurrent) => {
      try {
        const qs = status ? `?status=${status}` : '';
        const list = await api.get<FinancialEvent[]>(`/accounting/financial-events${qs}`);
        if (!isCurrent()) return;
        setEvents(list);
        setError(null);
      } catch (err) {
        if (isCurrent()) setError(err instanceof ApiError ? err.message : 'Failed to load financial events.');
        throw err;
      }
    },
    [status],
  );

  async function redrive(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await api.post(`/accounting/financial-events/${id}/redrive`);
      refresh.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to redrive event.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.financial_events')}</h1>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <PostingStatusChip />
          <RefreshStamp refresh={refresh} />
        </div>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="form-field" style={{ marginBottom: 0, maxWidth: 220 }}>
          <label>{t('field.journal_status')}</label>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">—</option>
            {['RECEIVED', 'MAPPED', 'POSTED', 'REJECTED', 'IGNORED'].map((s) => (
              <option key={s} value={s}>
                {t(`value.financial_event_status.${s.toLowerCase()}`)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && <div className="error-text">{error}</div>}

      {events === null ? (
        <div className="empty-state">{loadingLabel()}</div>
      ) : events.length === 0 ? (
        <div className="empty-state">{t('panel.no_financial_events_yet')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.source_type')}</th>
              <th>{t('field.business_date')}</th>
              <th>{t('field.journal_status')}</th>
              <th>{t('field.rejection_reason')}</th>
              <th>{t('field.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {events.map((ev) => (
              <tr key={ev.id}>
                <td>
                  {nameOf(SOURCE_DOMAINS, sourceDomainOf(ev.sourceDomain, ev.eventType), lang)} / {nameOf(FINANCIAL_EVENT_TYPES, ev.eventType, lang)}
                </td>
                <td>{ev.businessDate}</td>
                <td>
                  <StatusBadge code={`value.financial_event_status.${ev.status.toLowerCase()}`} />
                </td>
                <td>{translateRejectionReason(ev.rejectionReason, lang)}</td>
                <td>
                  {ev.status === 'REJECTED' && (
                    <button className="btn btn-secondary" disabled={busyId === ev.id} onClick={() => redrive(ev.id)}>
                      {t('action.redrive_financial_event')}
                    </button>
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
