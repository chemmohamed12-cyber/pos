import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { StatusBadge } from '../../components/StatusBadge';

interface ClosingAuditRun {
  id: string;
  asOfDate: string;
  status: 'clean' | 'exceptions_found';
  createdAt: string;
}
interface ClosingWorkflowRun {
  id: string;
  entryState: 'soft_close' | 'reopened';
  status: 'audit_run' | 'exceptions_open' | 'final_reconciliation_passed' | 'approval_submitted' | 'approved' | 'period_locked' | 'failed';
  approvalRequestId: string | null;
  createdAt: string;
  completedAt: string | null;
}

const PRELOAD = [
  'nav.closing_audit',
  'nav.closing_exceptions',
  'field.as_of_date',
  'field.closing_audit_status',
  'field.closing_workflow_entry_state',
  'field.closing_workflow_status',
  'field.approval_request_id',
  'field.created_at',
  'field.completed_at',
  'value.closing_audit_status.clean',
  'value.closing_audit_status.exceptions_found',
  'value.closing_workflow_entry_state.soft_close',
  'value.closing_workflow_entry_state.reopened',
  'value.closing_workflow_status.audit_run',
  'value.closing_workflow_status.exceptions_open',
  'value.closing_workflow_status.final_reconciliation_passed',
  'value.closing_workflow_status.approval_submitted',
  'value.closing_workflow_status.approved',
  'value.closing_workflow_status.period_locked',
  'value.closing_workflow_status.failed',
  'action.run_closing_audit',
  'panel.no_closing_audit_runs_yet',
  'panel.no_closing_workflow_runs_yet',
];

/**
 * ADR-058 (Wave 1 Frontend Completion) — Closing Audit dashboard. A read/preview surface only:
 * "Run Closing Audit" calls the SAME `POST .../closing-audit` endpoint `submitPeriodClose`
 * calls server-side (a preview before committing, never a parallel computation). No
 * approve/resolve control lives here — those are on Closing Exceptions and the Fiscal Period
 * row respectively (ADR-051's own lifecycle is never reproduced by this UI).
 */
export function ClosingAudit() {
  const { t, preload } = useLanguage();
  preload(PRELOAD);
  const { periodId } = useParams<{ periodId: string }>();

  const [auditRuns, setAuditRuns] = useState<ClosingAuditRun[] | null>(null);
  const [workflowRuns, setWorkflowRuns] = useState<ClosingWorkflowRun[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadAuditRuns() {
    if (!periodId) return;
    try {
      setAuditRuns(await api.get<ClosingAuditRun[]>(`/accounting/fiscal-periods/${periodId}/closing-audit`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load closing audit runs.');
    }
  }

  async function loadWorkflowRuns() {
    if (!periodId) return;
    try {
      setWorkflowRuns(await api.get<ClosingWorkflowRun[]>(`/accounting/fiscal-periods/${periodId}/closing-workflow-runs`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load closing workflow runs.');
    }
  }

  useEffect(() => {
    loadAuditRuns();
    loadWorkflowRuns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodId]);

  async function runClosingAudit() {
    if (!periodId) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/accounting/fiscal-periods/${periodId}/closing-audit`);
      await loadAuditRuns();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to run closing audit.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.closing_audit')}</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link to={`/accounting/fiscal-periods/${periodId}/closing-exceptions`} className="btn btn-secondary">
            {t('nav.closing_exceptions')}
          </Link>
          <button className="btn btn-primary" disabled={busy} onClick={runClosingAudit}>
            {t('action.run_closing_audit')}
          </button>
        </div>
      </div>

      {error && <div className="error-text">{error}</div>}

      {auditRuns === null ? (
        <div className="empty-state">Loading…</div>
      ) : auditRuns.length === 0 ? (
        <div className="empty-state">{t('panel.no_closing_audit_runs_yet')}</div>
      ) : (
        <table className="data-table" style={{ marginBottom: 20 }}>
          <thead>
            <tr>
              <th>{t('field.as_of_date')}</th>
              <th>{t('field.closing_audit_status')}</th>
              <th>{t('field.created_at')}</th>
            </tr>
          </thead>
          <tbody>
            {auditRuns.map((r) => (
              <tr key={r.id}>
                <td>{r.asOfDate}</td>
                <td>
                  <StatusBadge code={`value.closing_audit_status.${r.status}`} />
                </td>
                <td>{new Date(r.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {workflowRuns === null ? (
        <div className="empty-state">Loading…</div>
      ) : workflowRuns.length === 0 ? (
        <div className="empty-state">{t('panel.no_closing_workflow_runs_yet')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.closing_workflow_entry_state')}</th>
              <th>{t('field.closing_workflow_status')}</th>
              <th>{t('field.approval_request_id')}</th>
              <th>{t('field.created_at')}</th>
              <th>{t('field.completed_at')}</th>
            </tr>
          </thead>
          <tbody>
            {workflowRuns.map((w) => (
              <tr key={w.id}>
                <td>
                  <StatusBadge code={`value.closing_workflow_entry_state.${w.entryState}`} />
                </td>
                <td>
                  <StatusBadge code={`value.closing_workflow_status.${w.status}`} />
                </td>
                <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{w.approvalRequestId ? w.approvalRequestId.slice(0, 8) : '—'}</td>
                <td>{new Date(w.createdAt).toLocaleString()}</td>
                <td>{w.completedAt ? new Date(w.completedAt).toLocaleString() : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
