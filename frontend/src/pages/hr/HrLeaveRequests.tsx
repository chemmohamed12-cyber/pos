import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { StatusBadge } from '../../components/StatusBadge';
import { ApprovalsPanel } from '../../components/ApprovalsPanel';

interface Employee {
  id: string;
  code: string;
  fullName: string;
  status: 'active' | 'on_leave' | 'terminated';
}
interface LeaveRequest {
  id: string;
  employeeId: string;
  leaveType: string;
  startDate: string;
  endDate: string;
  reason: string | null;
  status: 'submitted' | 'approved';
  createdAt: string;
}

const LEAVE_TYPES = ['annual', 'sick', 'unpaid', 'other'] as const;
const LEAVE_REQUEST_TYPE_CODES = ['hr.leave_request'];

/** ADR-059 (HR Phase 1) — HR's first FA-01 (`ApprovalEngineService`) consumer. `<ApprovalsPanel>` is reused as-is, exactly like every other Wave 1 approval consumer — zero new approval UI. */
export function HrLeaveRequests() {
  const { t, preload } = useLanguage();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [requests, setRequests] = useState<LeaveRequest[] | null>(null);
  const [employeeId, setEmployeeId] = useState('');
  const [leaveType, setLeaveType] = useState<(typeof LEAVE_TYPES)[number]>('annual');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  preload([
    'nav.hr_leave_requests',
    'field.employee',
    'field.leave_type',
    'field.start_date',
    'field.end_date',
    'field.reason',
    'field.status',
    'field.created_at',
    'action.submit_leave_request',
    'panel.no_leave_requests_yet',
    'value.leave_request_status.submitted',
    'value.leave_request_status.approved',
    ...LEAVE_TYPES.map((lt) => `value.leave_type.${lt}`),
  ]);

  async function loadEmployees() {
    setEmployees(await api.get<Employee[]>('/hr/employees'));
  }

  async function loadRequests() {
    try {
      setRequests(await api.get<LeaveRequest[]>('/hr/leave-requests'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load leave requests.');
    }
  }

  useEffect(() => {
    loadEmployees();
    loadRequests();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.post('/hr/leave-requests', { employeeId, leaveType, startDate, endDate, reason: reason || undefined });
      setStartDate('');
      setEndDate('');
      setReason('');
      await loadRequests();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to submit leave request.');
    } finally {
      setSubmitting(false);
    }
  }

  const employeeLabel = (id: string) => {
    const emp = employees.find((e) => e.id === id);
    return emp ? `${emp.code} — ${emp.fullName}` : id.slice(0, 8);
  };

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.hr_leave_requests')}</h1>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <form onSubmit={onSubmit} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="form-field" style={{ marginBottom: 0, minWidth: 200 }}>
            <label>{t('field.employee')}</label>
            <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} required>
              <option value="">—</option>
              {employees
                .filter((e) => e.status === 'active')
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.code} — {e.fullName}
                  </option>
                ))}
            </select>
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.leave_type')}</label>
            <select value={leaveType} onChange={(e) => setLeaveType(e.target.value as never)}>
              {LEAVE_TYPES.map((lt) => (
                <option key={lt} value={lt}>
                  {t(`value.leave_type.${lt}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.start_date')}</label>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.end_date')}</label>
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} required />
          </div>
          <div className="form-field" style={{ marginBottom: 0, minWidth: 160 }}>
            <label>{t('field.reason')}</label>
            <input value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <button className="btn btn-primary" type="submit" disabled={submitting}>
            {t('action.submit_leave_request')}
          </button>
        </form>
      </div>

      {error && <div className="error-text">{error}</div>}

      <ApprovalsPanel requestTypeCodes={LEAVE_REQUEST_TYPE_CODES} decidePath={(id) => `/hr/leave-requests/${id}/decide`} onDecided={loadRequests} />

      {requests === null ? (
        <div className="empty-state">Loading…</div>
      ) : requests.length === 0 ? (
        <div className="empty-state">{t('panel.no_leave_requests_yet')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.employee')}</th>
              <th>{t('field.leave_type')}</th>
              <th>{t('field.start_date')}</th>
              <th>{t('field.end_date')}</th>
              <th>{t('field.reason')}</th>
              <th>{t('field.status')}</th>
              <th>{t('field.created_at')}</th>
            </tr>
          </thead>
          <tbody>
            {requests.map((r) => (
              <tr key={r.id}>
                <td>{employeeLabel(r.employeeId)}</td>
                <td>{t(`value.leave_type.${r.leaveType}`)}</td>
                <td>{r.startDate}</td>
                <td>{r.endDate}</td>
                <td>{r.reason ?? '—'}</td>
                <td>
                  <StatusBadge code={`value.leave_request_status.${r.status}`} />
                </td>
                <td>{new Date(r.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
