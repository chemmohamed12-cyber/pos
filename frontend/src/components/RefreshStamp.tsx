import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useLanguage } from '../context/LanguageContext';
import type { AutoRefresh } from '../lib/useAutoRefresh';
import { fmtDateTime, fmtTime } from '../lib/formatDateTime';

/** "Updated hh:mm:ss" + a manual refresh button; a failed refresh says so and keeps the last good data on screen. */
export function RefreshStamp({ refresh }: { refresh: AutoRefresh }) {
  const { t, preload } = useLanguage();
  preload(['panel.updated_at', 'panel.refresh_now', 'panel.refresh_failed']);
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: '0.8rem', color: '#6b7280' }}>
      {refresh.updatedAt && (
        <span>
          {t('panel.updated_at')} {fmtTime(refresh.updatedAt)}
        </span>
      )}
      {refresh.stale && <span className="error-text" style={{ margin: 0 }}>{t('panel.refresh_failed')}</span>}
      <button type="button" className="btn btn-secondary" disabled={refresh.refreshing} onClick={refresh.refresh}>
        {t('panel.refresh_now')}
      </button>
    </div>
  );
}

interface PostingStatus {
  pendingEvents: number;
  rejectedEvents: number;
  failedOutbox: number;
  inFlightEvents: number;
  lastPostedAt: string | null;
  state: 'current' | 'pending' | 'attention';
}

/**
 * Whether the books on screen are complete: how many inventory postings are still travelling or were rejected. Read-only (`GET /accounting/posting-status`),
 * refreshed on its own 30 s cycle; it renders nothing when the caller may not read it (the status simply is not shown, never an error banner).
 */
export function PostingStatusChip() {
  const { t, preload } = useLanguage();
  preload(['panel.posting_current', 'panel.posting_pending', 'panel.posting_attention', 'panel.posting_counts', 'panel.posting_last']);
  const [status, setStatus] = useState<PostingStatus | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      if (document.visibilityState !== 'visible') return;
      api.get<PostingStatus>('/accounting/posting-status?domain=inventory').then((s) => alive && setStatus(s)).catch(() => alive && setStatus(null));
    };
    load();
    const timer = window.setInterval(load, 30_000);
    document.addEventListener('visibilitychange', load);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', load);
    };
  }, []);

  if (!status) return null;
  const tone = status.state === 'current' ? 'positive' : status.state === 'pending' ? 'warning' : 'negative';
  const label = status.state === 'current' ? 'panel.posting_current' : status.state === 'pending' ? 'panel.posting_pending' : 'panel.posting_attention';
  return (
    <span
      className={`status-badge ${tone}`}
      title={`${t('panel.posting_counts')}: ${status.pendingEvents + status.inFlightEvents} / ${status.rejectedEvents + status.failedOutbox}${status.lastPostedAt ? ` — ${t('panel.posting_last')}: ${fmtDateTime(status.lastPostedAt)}` : ''}`}
    >
      {status.state !== 'current' ? (
        <Link to="/accounting/financial-events" style={{ color: 'inherit', textDecoration: 'none' }}>
          {t(label)} ({status.pendingEvents + status.inFlightEvents} / {status.rejectedEvents + status.failedOutbox})
        </Link>
      ) : (
        t(label)
      )}
    </span>
  );
}
