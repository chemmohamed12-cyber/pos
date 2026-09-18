import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { StatusBadge } from '../../components/StatusBadge';

interface ClosingException {
  id: string;
  module: 'ar' | 'ap' | 'cash_bank' | 'inventory' | 'fixed_asset' | 'grni' | 'financial_events';
  documentType: string | null;
  documentId: string | null;
  transactionRef: string | null;
  accountOrSubledgerRef: string | null;
  amount: string | null;
  category: 'LIVE_DISCREPANCY' | 'DORMANT_SOURCE' | 'EXPECTED_BUSINESS_REJECTION' | 'CONFIGURATION_EXCEPTION' | 'HISTORICAL_TEST_ARTIFACT' | 'UNCLASSIFIED_REJECTION';
  severity: 'blocking' | 'informational';
  problem: string;
  requiredAction: string;
  status: 'open' | 'acknowledged' | 'resolved' | 'waived';
  annotation: { byUserId: string; at: string; reason: string } | null;
  createdAt: string;
}

const PRELOAD = [
  'nav.closing_exceptions',
  'field.module',
  'field.category',
  'field.severity',
  'field.problem',
  'field.required_action',
  'field.status',
  'field.amount',
  'field.transaction_ref',
  'field.account_or_subledger_ref',
  'field.annotation',
  'field.reason',
  'field.actions',
  'value.closing_exception_severity.blocking',
  'value.closing_exception_severity.informational',
  'value.closing_exception_status.open',
  'value.closing_exception_status.acknowledged',
  'value.closing_exception_status.resolved',
  'value.closing_exception_status.waived',
  'value.closing_exception_category.LIVE_DISCREPANCY',
  'value.closing_exception_category.DORMANT_SOURCE',
  'value.closing_exception_category.EXPECTED_BUSINESS_REJECTION',
  'value.closing_exception_category.CONFIGURATION_EXCEPTION',
  'value.closing_exception_category.HISTORICAL_TEST_ARTIFACT',
  'value.closing_exception_category.UNCLASSIFIED_REJECTION',
  'action.acknowledge',
  'action.annotate_test_artifact',
  'panel.no_closing_exceptions',
];

/**
 * ADR-058 (Wave 1 Frontend Completion) — Closing Exceptions queue. Only the two human-settable
 * transitions ADR-051 §2/§3 defines are exposed: Acknowledge (open -> acknowledged) and Annotate
 * as test artifact (the ONE path to HISTORICAL_TEST_ARTIFACT, financial_events findings only).
 * No "resolve" control exists here by design — resolution is only ever proven by a fresh Closing
 * Audit run no longer reproducing the finding. `HISTORICAL_TEST_ARTIFACT` visibility itself is
 * already restricted server-side (CTO decision 2, ADR-058) to callers holding
 * `accounting.closing_exception.annotate_test_artifact` — this page just renders whatever the API
 * returns, unfiltered further.
 */
export function ClosingExceptions() {
  const { t, preload } = useLanguage();
  preload(PRELOAD);
  const { periodId } = useParams<{ periodId: string }>();

  const [exceptions, setExceptions] = useState<ClosingException[] | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (!periodId) return;
    try {
      setExceptions(await api.get<ClosingException[]>(`/accounting/fiscal-periods/${periodId}/closing-exceptions`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load closing exceptions.');
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodId]);

  async function acknowledge(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await api.post(`/accounting/closing-exceptions/${id}/acknowledge`, { note: notes[id] || '' });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to acknowledge exception.');
    } finally {
      setBusyId(null);
    }
  }

  async function annotateTestArtifact(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await api.post(`/accounting/closing-exceptions/${id}/annotate-test-artifact`, { reason: reasons[id] || '' });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to annotate exception as test artifact.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.closing_exceptions')}</h1>
      </div>

      {error && <div className="error-text">{error}</div>}

      {exceptions === null ? (
        <div className="empty-state">Loading…</div>
      ) : exceptions.length === 0 ? (
        <div className="empty-state">{t('panel.no_closing_exceptions')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.module')}</th>
              <th>{t('field.severity')}</th>
              <th>{t('field.category')}</th>
              <th>{t('field.problem')}</th>
              <th>{t('field.required_action')}</th>
              <th>{t('field.amount')}</th>
              <th>{t('field.status')}</th>
              <th>{t('field.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {exceptions.map((e) => {
              const canAnnotate = e.module === 'financial_events' && e.category !== 'HISTORICAL_TEST_ARTIFACT';
              return (
                <tr key={e.id}>
                  <td>{e.module}</td>
                  <td>
                    <StatusBadge code={`value.closing_exception_severity.${e.severity}`} />
                  </td>
                  <td>{t(`value.closing_exception_category.${e.category}`)}</td>
                  <td>{e.problem}</td>
                  <td>{e.requiredAction}</td>
                  <td>{e.amount ?? '—'}</td>
                  <td>
                    <StatusBadge code={`value.closing_exception_status.${e.status}`} />
                    {e.annotation && (
                      <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
                        {e.annotation.reason} — {new Date(e.annotation.at).toLocaleString()}
                      </div>
                    )}
                  </td>
                  <td style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 200 }}>
                    {e.status === 'open' && (
                      <div style={{ display: 'flex', gap: 6 }}>
                        <input
                          placeholder={t('field.reason')}
                          value={notes[e.id] ?? ''}
                          onChange={(ev) => setNotes((prev) => ({ ...prev, [e.id]: ev.target.value }))}
                          style={{ width: 120 }}
                        />
                        <button className="btn btn-secondary" disabled={busyId === e.id} onClick={() => acknowledge(e.id)}>
                          {t('action.acknowledge')}
                        </button>
                      </div>
                    )}
                    {canAnnotate && (
                      <div style={{ display: 'flex', gap: 6 }}>
                        <input
                          placeholder={t('field.reason')}
                          value={reasons[e.id] ?? ''}
                          onChange={(ev) => setReasons((prev) => ({ ...prev, [e.id]: ev.target.value }))}
                          style={{ width: 120 }}
                        />
                        <button className="btn btn-secondary" disabled={busyId === e.id} onClick={() => annotateTestArtifact(e.id)}>
                          {t('action.annotate_test_artifact')}
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
