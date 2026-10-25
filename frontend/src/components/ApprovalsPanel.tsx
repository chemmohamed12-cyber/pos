import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { ErrorText, toUiError, type UiError } from './ErrorText';
import { useLanguage } from '../context/LanguageContext';

interface ApprovalRequest {
  id: string;
  requestTypeCode: string;
  resourceType: string;
  resourceId: string;
  requestedAction: string;
  payload: Record<string, unknown>;
  createdAt: string;
  decidedAt: string | null;
}

/**
 * FA-01 (generic Approval/Maker-Checker engine) — a reusable pending-requests
 * queue reused across every accounting sub-module that submits an FA-01
 * request (AR/AP/Cash-Bank adjustments, Fixed Asset disposals): fetches
 * `GET /approvals/requests?requestTypeCode=<code>` per code (the generic
 * list route carries no live `state`, so a still-`pending` request is one
 * whose `decidedAt` is null — `ApprovalRequest`'s own doc comment: "Set
 * when the request leaves pending") and decides via the CALLER's
 * domain-specific decide route (e.g. `accounting/ar/approvals/:id/decide`)
 * so the correct `accounting.<domain>.approve` permission node gates it,
 * not the generic `core.approval.view` one.
 */
export function ApprovalsPanel({ requestTypeCodes, decidePath, onDecided }: { requestTypeCodes: string[]; decidePath: (id: string) => string; onDecided?: () => void }) {
  const { t, preload } = useLanguage();
  preload(['error.sod_violation', 'field.approval_request_id', 'field.approval_decision', 'action.decide_approval', 'field.reason']);
  const [requests, setRequests] = useState<ApprovalRequest[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<UiError | null>(null);

  async function load() {
    try {
      const lists = await Promise.all(requestTypeCodes.map((code) => api.get<ApprovalRequest[]>(`/approvals/requests?requestTypeCode=${encodeURIComponent(code)}`)));
      setRequests(lists.flat().filter((r) => r.decidedAt === null));
    } catch (err) {
      setError(toUiError(err, t, 'msg.action_failed'));
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestTypeCodes.join(',')]);

  async function decide(id: string, decision: 'approved' | 'rejected') {
    setBusyId(id);
    setError(null);
    try {
      await api.post(decidePath(id), { decision, note: notes[id] || undefined });
      await load();
      onDecided?.();
    } catch (err) {
      setError(toUiError(err, t, 'msg.action_failed'));
    } finally {
      setBusyId(null);
    }
  }

  if (requests.length === 0) return null;

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <h3 style={{ marginTop: 0 }}>{t('value.approval_status.pending')}</h3>
      {error && (
        <div className="error-text">
          <ErrorText error={error} />
        </div>
      )}
      <table className="data-table">
        <thead>
          <tr>
            <th>{t('field.approval_request_id')}</th>
            <th>{t('field.amount')}</th>
            <th>{t('field.reason')}</th>
            <th>{t('field.actions')}</th>
          </tr>
        </thead>
        <tbody>
          {requests.map((r) => (
            <tr key={r.id}>
              <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{r.id.slice(0, 8)}</td>
              <td>{typeof r.payload.amount === 'string' || typeof r.payload.amount === 'number' ? String(r.payload.amount) : '—'}</td>
              <td>
                <input
                  placeholder={t('field.reason')}
                  value={notes[r.id] ?? ''}
                  onChange={(e) => setNotes((prev) => ({ ...prev, [r.id]: e.target.value }))}
                  style={{ width: 160 }}
                />
              </td>
              <td style={{ display: 'flex', gap: 6 }}>
                <button className="btn btn-primary" disabled={busyId === r.id} onClick={() => decide(r.id, 'approved')}>
                  {t('value.approval_status.approved')}
                </button>
                <button className="btn btn-danger" disabled={busyId === r.id} onClick={() => decide(r.id, 'rejected')}>
                  {t('value.approval_status.rejected')}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
