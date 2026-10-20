import { Link } from 'react-router-dom';
import { useLanguage } from '../context/LanguageContext';
import { usePendingSources } from '../lib/pendingWork';
import { fmtDate } from '../lib/formatDateTime';
import { loadingLabel } from '../lib/displayNames';

/**
 * NAV-03 — "Pending work": everything waiting for a decision, across the Approval Engine AND the Process-Engine approvals that live inside their
 * own screens. The two mechanisms are NOT merged: this page only counts what each existing endpoint returns and links to the screen where the item
 * is decided. A source the user may not open is not shown.
 */
export function PendingWork() {
  const { t, preload } = useLanguage();
  const sources = usePendingSources();
  preload([
    'nav.pending_work',
    'panel.pending_work_intro',
    'panel.pending_work_none',
    'panel.pending_work_two_engines',
    'field.pending_count',
    'field.oldest_waiting',
    'action.open_resource',
    ...(sources ?? []).map((s) => s.labelCode),
  ]);

  const total = (sources ?? []).reduce((sum, s) => sum + s.count, 0);

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.pending_work')}</h1>
      </div>
      <div className="card" style={{ marginBottom: 20 }}>
        <p style={{ marginTop: 0 }}>{t('panel.pending_work_intro')}</p>
        <p style={{ marginBottom: 0, fontSize: 13, opacity: 0.8 }}>{t('panel.pending_work_two_engines')}</p>
      </div>
      {sources === null ? (
        <div className="empty-state">{loadingLabel()}</div>
      ) : (
        <div className="card">
          {total === 0 && <div className="empty-state">{t('panel.pending_work_none')}</div>}
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('field.type')}</th>
                <th>{t('field.pending_count')}</th>
                <th>{t('field.oldest_waiting')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.key} data-testid={`pending-${s.key}`}>
                  <td>{t(s.labelCode)}</td>
                  <td>
                    <strong>{s.count}</strong>
                  </td>
                  <td>{s.oldest ? fmtDate(s.oldest) : '—'}</td>
                  <td>
                    <Link className="btn btn-secondary" to={s.to}>
                      {t('action.open_resource')}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
