import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { StatusBadge } from '../../components/StatusBadge';
import { ApprovalsPanel } from '../../components/ApprovalsPanel';

interface Employee {
  id: string;
  code: string;
  fullName: string;
}
interface AttendanceDay {
  id: string;
  employeeId: string;
  calendarDate: string;
  checkIn: string | null;
  checkOut: string | null;
  hoursWorked: string | null;
  status: 'present' | 'absent' | 'on_leave' | 'missing_punch';
  batchId: string | null;
}
interface ApprovalBatch {
  id: string;
  periodStart: string;
  periodEnd: string;
  status: 'draft' | 'submitted' | 'approved' | 'rejected';
}

const ATTENDANCE_REQUEST_TYPE_CODES = ['attendance.approval_batch', 'attendance.correction'];

/** ADR-065 §5/§8 — days table, split-authority correction, and the FA-01 approval batch workflow. `<ApprovalsPanel>` reused as-is for both request types this module registers. */
export function AttendanceDays() {
  const { t, preload } = useLanguage();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [days, setDays] = useState<AttendanceDay[] | null>(null);
  const [batches, setBatches] = useState<ApprovalBatch[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [correctingId, setCorrectingId] = useState<string | null>(null);
  const [correctCheckIn, setCorrectCheckIn] = useState('');
  const [correctCheckOut, setCorrectCheckOut] = useState('');
  const [correctReason, setCorrectReason] = useState('');

  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [submittingBatch, setSubmittingBatch] = useState(false);

  preload([
    'nav.attendance_days',
    'field.employee',
    'field.calendar_date',
    'field.check_in',
    'field.check_out',
    'field.hours_worked',
    'field.status',
    'field.actions',
    'field.period_start',
    'field.period_end',
    'field.reason',
    'action.correct_day',
    'action.submit_batch',
    'action.confirm',
    'action.cancel',
    'panel.no_days_yet',
    'panel.no_batches_yet',
    'value.attendance_day_status.present',
    'value.attendance_day_status.absent',
    'value.attendance_day_status.on_leave',
    'value.attendance_day_status.missing_punch',
    'value.attendance_batch_status.draft',
    'value.attendance_batch_status.submitted',
    'value.attendance_batch_status.approved',
    'value.attendance_batch_status.rejected',
  ]);

  async function loadEmployees() {
    setEmployees(await api.get<Employee[]>('/hr/employees'));
  }
  async function loadDays() {
    try {
      setDays(await api.get<AttendanceDay[]>('/attendance/days'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load attendance days.');
    }
  }
  async function loadBatches() {
    try {
      setBatches(await api.get<ApprovalBatch[]>('/attendance/approval-batches'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load approval batches.');
    }
  }

  useEffect(() => {
    loadEmployees();
    loadDays();
    loadBatches();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function confirmCorrect(day: AttendanceDay) {
    setBusyId(day.id);
    setError(null);
    try {
      await api.post(`/attendance/days/${day.id}/correct`, {
        checkIn: correctCheckIn || undefined,
        checkOut: correctCheckOut || undefined,
        reason: correctReason,
      });
      setCorrectingId(null);
      setCorrectReason('');
      await loadDays();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to correct day.');
    } finally {
      setBusyId(null);
    }
  }

  async function onSubmitBatch(e: FormEvent) {
    e.preventDefault();
    setSubmittingBatch(true);
    setError(null);
    try {
      await api.post('/attendance/approval-batches', { periodStart, periodEnd });
      setPeriodStart('');
      setPeriodEnd('');
      await Promise.all([loadDays(), loadBatches()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to submit approval batch.');
    } finally {
      setSubmittingBatch(false);
    }
  }

  const employeeLabel = (id: string) => {
    const emp = employees.find((e) => e.id === id);
    return emp ? `${emp.code} — ${emp.fullName}` : id.slice(0, 8);
  };

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.attendance_days')}</h1>
      </div>

      {error && <div className="error-text">{error}</div>}

      <div className="card" style={{ marginBottom: 20 }}>
        <h3>{t('action.submit_batch')}</h3>
        <form onSubmit={onSubmitBatch} style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.period_start')}</label>
            <input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} required />
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.period_end')}</label>
            <input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} required />
          </div>
          <button className="btn btn-primary" type="submit" disabled={submittingBatch}>
            {t('action.submit_batch')}
          </button>
        </form>
      </div>

      <ApprovalsPanel requestTypeCodes={ATTENDANCE_REQUEST_TYPE_CODES} decidePath={(id) => `/attendance/approvals/${id}/decide`} onDecided={() => { loadDays(); loadBatches(); }} />

      {batches === null ? (
        <div className="empty-state">Loading…</div>
      ) : batches.length === 0 ? (
        <div className="empty-state">{t('panel.no_batches_yet')}</div>
      ) : (
        <table className="data-table" style={{ marginBottom: 20 }}>
          <thead>
            <tr>
              <th>{t('field.period_start')}</th>
              <th>{t('field.period_end')}</th>
              <th>{t('field.status')}</th>
            </tr>
          </thead>
          <tbody>
            {batches.map((b) => (
              <tr key={b.id}>
                <td>{b.periodStart}</td>
                <td>{b.periodEnd}</td>
                <td>
                  <StatusBadge code={`value.attendance_batch_status.${b.status}`} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {days === null ? (
        <div className="empty-state">Loading…</div>
      ) : days.length === 0 ? (
        <div className="empty-state">{t('panel.no_days_yet')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.employee')}</th>
              <th>{t('field.calendar_date')}</th>
              <th>{t('field.check_in')}</th>
              <th>{t('field.check_out')}</th>
              <th>{t('field.hours_worked')}</th>
              <th>{t('field.status')}</th>
              <th>{t('field.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {days.map((d) =>
              correctingId === d.id ? (
                <tr key={d.id}>
                  <td>{employeeLabel(d.employeeId)}</td>
                  <td>{d.calendarDate}</td>
                  <td>
                    <input type="datetime-local" value={correctCheckIn} onChange={(e) => setCorrectCheckIn(e.target.value)} style={{ width: 160 }} />
                  </td>
                  <td>
                    <input type="datetime-local" value={correctCheckOut} onChange={(e) => setCorrectCheckOut(e.target.value)} style={{ width: 160 }} />
                  </td>
                  <td>{d.hoursWorked ?? '—'}</td>
                  <td>
                    <StatusBadge code={`value.attendance_day_status.${d.status}`} />
                  </td>
                  <td style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <input placeholder={t('field.reason')} value={correctReason} onChange={(e) => setCorrectReason(e.target.value)} style={{ width: 140 }} />
                    <button className="btn btn-primary" disabled={busyId === d.id || !correctReason} onClick={() => confirmCorrect(d)}>
                      {t('action.confirm')}
                    </button>
                    <button className="btn btn-secondary" onClick={() => setCorrectingId(null)}>
                      {t('action.cancel')}
                    </button>
                  </td>
                </tr>
              ) : (
                <tr key={d.id}>
                  <td>{employeeLabel(d.employeeId)}</td>
                  <td>{d.calendarDate}</td>
                  <td>{d.checkIn ? new Date(d.checkIn).toLocaleTimeString() : '—'}</td>
                  <td>{d.checkOut ? new Date(d.checkOut).toLocaleTimeString() : '—'}</td>
                  <td>{d.hoursWorked ?? '—'}</td>
                  <td>
                    <StatusBadge code={`value.attendance_day_status.${d.status}`} />
                  </td>
                  <td>
                    <button
                      className="btn btn-secondary"
                      onClick={() => {
                        setCorrectingId(d.id);
                        setCorrectCheckIn(d.checkIn ? d.checkIn.slice(0, 16) : '');
                        setCorrectCheckOut(d.checkOut ? d.checkOut.slice(0, 16) : '');
                        setCorrectReason('');
                      }}
                    >
                      {t('action.correct_day')}
                    </button>
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
