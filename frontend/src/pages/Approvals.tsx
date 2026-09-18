import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { useLanguage } from '../context/LanguageContext';

interface RequestType {
  requestTypeCode: string;
  titleCode: string;
  createdAt: string;
}
interface MatrixRule {
  id: string;
  requestTypeCode: string;
  minApprovers: number;
  requiredPermissionNode: string;
  valueThreshold: string | null;
  orgUnitId: string | null;
  isActive: boolean;
  updatedAt: string;
}

/**
 * Historical dev-data cruft, not a live bug: every domain's `onModuleInit`
 * self-registers its default rule with no `id`, and before a 2026-09-12 fix
 * (`ApprovalEngineService.upsertMatrixRule`'s own doc comment) each app
 * restart inserted a fresh, content-identical duplicate row. The fix is
 * already in place — this only collapses the ALREADY-DUPLICATED rows this
 * dev database accumulated before then, keying on the same
 * (requestTypeCode, orgUnitId, valueThreshold) triple the engine itself
 * uses to disambiguate a rule, keeping the most recently updated one.
 */
function dedupeMatrixRules(rules: MatrixRule[]): MatrixRule[] {
  const byKey = new Map<string, MatrixRule>();
  for (const r of rules) {
    const key = `${r.requestTypeCode}|${r.orgUnitId ?? ''}|${r.valueThreshold ?? ''}`;
    const existing = byKey.get(key);
    if (!existing || new Date(r.updatedAt) > new Date(existing.updatedAt)) byKey.set(key, r);
  }
  return [...byKey.values()];
}
interface ApprovalRequest {
  id: string;
  requestTypeCode: string;
  resourceType: string;
  resourceId: string;
  requestedAction: string;
  makerUserId: string;
  createdAt: string;
  decidedAt: string | null;
}

const PRELOAD = [
  'nav.approvals',
  'field.request_type',
  'field.request_type_code',
  'field.min_approvers',
  'field.required_permission_node',
  'field.value_threshold',
  'field.approval_decision',
  'field.status',
  'field.actions',
  'field.reason',
  'value.approval_decision.approved',
  'value.approval_decision.rejected',
  'action.approval_matrix_add',
  'action.approval_matrix_edit',
  'action.approval_withdraw',
  'action.approval_escalate',
  'action.save',
  'panel.no_approval_requests_pending',
  'panel.no_matrix_rules_yet',
];

/**
 * FA-01 — Generic Approval / Maker-Checker Engine admin surface
 * (`ApprovalController`). `nav.approvals` + every field/action label here
 * was seeded by FA-01's own migration (`CreateApprovalEngine`) but had no
 * frontend page anywhere in the workspace — built directly against
 * `approval.controller.ts`. Per-domain approval queues (AR/AP/Cash-Bank/
 * Fixed Asset/Inventory adjustments, Fiscal Closing) already have their
 * own inline `ApprovalsPanel` on their own pages; this is the
 * cross-cutting admin view: every request type, the matrix rules that
 * gate them, and a global pending queue with decide/withdraw/escalate.
 */
export function Approvals() {
  const { t, preload } = useLanguage();
  preload(PRELOAD);

  const [requestTypes, setRequestTypes] = useState<RequestType[] | null>(null);
  const [rules, setRules] = useState<MatrixRule[] | null>(null);
  const [requests, setRequests] = useState<ApprovalRequest[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});

  const [ruleRequestType, setRuleRequestType] = useState('');
  const [ruleMinApprovers, setRuleMinApprovers] = useState('1');
  const [ruleRequiredNode, setRuleRequiredNode] = useState('');
  const [ruleValueThreshold, setRuleValueThreshold] = useState('');

  async function loadRequestTypes() {
    try {
      setRequestTypes(await api.get<RequestType[]>('/approvals/request-types'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load request types.');
    }
  }
  async function loadRules() {
    try {
      setRules(dedupeMatrixRules(await api.get<MatrixRule[]>('/approvals/matrix-rules')));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load matrix rules.');
    }
  }
  async function loadRequests() {
    try {
      const all = await api.get<ApprovalRequest[]>('/approvals/requests');
      setRequests(all.filter((r) => r.decidedAt === null));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load approval requests.');
    }
  }

  useEffect(() => {
    loadRequestTypes();
    loadRules();
    loadRequests();
  }, []);

  async function upsertRule(e: FormEvent) {
    e.preventDefault();
    setBusy('rule');
    setError(null);
    try {
      await api.post('/approvals/matrix-rules', {
        requestTypeCode: ruleRequestType,
        minApprovers: Number(ruleMinApprovers),
        requiredPermissionNode: ruleRequiredNode,
        valueThreshold: ruleValueThreshold || undefined,
      });
      setRuleRequestType('');
      setRuleMinApprovers('1');
      setRuleRequiredNode('');
      setRuleValueThreshold('');
      await loadRules();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save approval rule.');
    } finally {
      setBusy(null);
    }
  }

  async function decide(id: string, decision: 'approved' | 'rejected') {
    setBusy(id);
    setError(null);
    try {
      await api.post(`/approvals/requests/${id}/decide`, { decision, note: notes[id] || undefined });
      await loadRequests();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to decide request.');
    } finally {
      setBusy(null);
    }
  }

  async function withdraw(id: string) {
    setBusy(id);
    setError(null);
    try {
      await api.post(`/approvals/requests/${id}/withdraw`);
      await loadRequests();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to withdraw request.');
    } finally {
      setBusy(null);
    }
  }

  async function escalate(id: string) {
    setBusy(id);
    setError(null);
    try {
      await api.post(`/approvals/requests/${id}/escalate`);
      await loadRequests();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to escalate request.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.approvals')}</h1>
      </div>

      {error && <div className="error-text">{error}</div>}

      <div className="card" style={{ marginBottom: 20 }}>
        <h3 style={{ marginTop: 0 }}>{t('action.approval_matrix_add')}</h3>
        <form onSubmit={upsertRule} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 16 }}>
          <div className="form-field" style={{ marginBottom: 0, minWidth: 220 }}>
            <label>{t('field.request_type')}</label>
            <select value={ruleRequestType} onChange={(e) => setRuleRequestType(e.target.value)} required>
              <option value="">—</option>
              {(requestTypes ?? []).map((rt) => (
                <option key={rt.requestTypeCode} value={rt.requestTypeCode}>
                  {t(rt.titleCode)} ({rt.requestTypeCode})
                </option>
              ))}
            </select>
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.min_approvers')}</label>
            <input type="number" min="1" step="1" value={ruleMinApprovers} onChange={(e) => setRuleMinApprovers(e.target.value)} style={{ width: 80 }} required />
          </div>
          <div className="form-field" style={{ marginBottom: 0, minWidth: 220 }}>
            <label>{t('field.required_permission_node')}</label>
            <input value={ruleRequiredNode} onChange={(e) => setRuleRequiredNode(e.target.value)} placeholder="e.g. accounting.ar.approve" required />
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.value_threshold')}</label>
            <input type="number" min="0" step="0.01" value={ruleValueThreshold} onChange={(e) => setRuleValueThreshold(e.target.value)} style={{ width: 120 }} />
          </div>
          <button className="btn btn-primary" type="submit" disabled={busy === 'rule'}>
            {t('action.save')}
          </button>
        </form>

        {rules === null ? (
          <div className="empty-state">Loading…</div>
        ) : rules.length === 0 ? (
          <div className="empty-state">{t('panel.no_matrix_rules_yet')}</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('field.request_type_code')}</th>
                <th>{t('field.min_approvers')}</th>
                <th>{t('field.required_permission_node')}</th>
                <th>{t('field.value_threshold')}</th>
                <th>{t('field.status')}</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id} style={{ opacity: r.isActive ? 1 : 0.5 }}>
                  <td style={{ fontFamily: 'monospace' }}>{r.requestTypeCode}</td>
                  <td>{r.minApprovers}</td>
                  <td style={{ fontFamily: 'monospace' }}>{r.requiredPermissionNode}</td>
                  <td>{r.valueThreshold ?? '—'}</td>
                  <td>{r.isActive ? '✓' : '✗'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>{t('nav.approvals')}</h3>
        {requests === null ? (
          <div className="empty-state">Loading…</div>
        ) : requests.length === 0 ? (
          <div className="empty-state">{t('panel.no_approval_requests_pending')}</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('field.request_type_code')}</th>
                <th>{t('field.actions')}</th>
                <th>{t('field.reason')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id}>
                  <td style={{ fontFamily: 'monospace' }}>{r.requestTypeCode}</td>
                  <td>{r.requestedAction}</td>
                  <td>
                    <input
                      placeholder={t('field.reason')}
                      value={notes[r.id] ?? ''}
                      onChange={(e) => setNotes((prev) => ({ ...prev, [r.id]: e.target.value }))}
                      style={{ width: 140 }}
                    />
                  </td>
                  <td style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button className="btn btn-primary" disabled={busy === r.id} onClick={() => decide(r.id, 'approved')}>
                      {t('value.approval_decision.approved')}
                    </button>
                    <button className="btn btn-danger" disabled={busy === r.id} onClick={() => decide(r.id, 'rejected')}>
                      {t('value.approval_decision.rejected')}
                    </button>
                    <button className="btn btn-secondary" disabled={busy === r.id} onClick={() => withdraw(r.id)}>
                      {t('action.approval_withdraw')}
                    </button>
                    <button className="btn btn-secondary" disabled={busy === r.id} onClick={() => escalate(r.id)}>
                      {t('action.approval_escalate')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
