import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { StatusBadge } from '../../components/StatusBadge';

interface Employee {
  id: string;
  code: string;
  fullName: string;
}
interface BiometricFact {
  id: string;
  deviceUserRef: string;
  sourceName: string | null;
  calendarDate: string;
  resolvedEmployeeId: string | null;
  onDuty: string | null;
  offDuty: string | null;
  clockIn: string | null;
  clockOut: string | null;
  lateValue: string | null;
  earlyValue: string | null;
  otTimeValue: string | null;
  sourceAbsent: boolean | null;
}
interface AttendanceDay {
  employeeId: string;
  calendarDate: string;
  status: 'present' | 'absent' | 'on_leave' | 'missing_punch';
}

/**
 * CTO directive (2026-09-20) — the "Attendance facts" + "Approved Leave
 * reconciliation visibility" screen. Shows the biometric device's own
 * source facts (`AttendanceBiometricDailyFact`) side by side with the
 * *reconciled* `AttendanceDay.status` for the same (employee, date) — so
 * a viewer can see, e.g., a device `Absent = True` fact next to a
 * `Reconciled Status = On Leave` badge, proving the reconciliation
 * happened, without either column being able to be mistaken for the
 * other. Read-only: this page performs no writes.
 */
export function AttendanceFacts() {
  const { t, preload } = useLanguage();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [facts, setFacts] = useState<BiometricFact[] | null>(null);
  const [days, setDays] = useState<AttendanceDay[]>([]);
  const [error, setError] = useState<string | null>(null);

  preload([
    'nav.attendance_facts',
    'field.employee',
    'field.ac_no',
    'field.source_name',
    'field.calendar_date',
    'field.on_duty',
    'field.off_duty',
    'field.check_in',
    'field.check_out',
    'field.late',
    'field.early',
    'field.absent_flag',
    'field.ot_time',
    'field.reconciled_status',
    'panel.no_biometric_facts_yet',
    'panel.biometric_facts_not_payroll_notice',
    'panel.biometric_schedule_vs_actual_notice',
    'value.attendance_day_status.present',
    'value.attendance_day_status.absent',
    'value.attendance_day_status.on_leave',
    'value.attendance_day_status.missing_punch',
  ]);

  useEffect(() => {
    (async () => {
      try {
        const [emps, factRows, dayRows] = await Promise.all([
          api.get<Employee[]>('/hr/employees'),
          api.get<BiometricFact[]>('/attendance/biometric-facts'),
          api.get<AttendanceDay[]>('/attendance/days'),
        ]);
        setEmployees(emps);
        setFacts(factRows);
        setDays(dayRows);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Failed to load attendance facts.');
      }
    })();
  }, []);

  const employeeLabel = (id: string | null) => {
    if (!id) return '—';
    const emp = employees.find((e) => e.id === id);
    return emp ? `${emp.code} — ${emp.fullName}` : id.slice(0, 8);
  };

  const reconciledStatus = (fact: BiometricFact) => {
    if (!fact.resolvedEmployeeId) return null;
    return days.find((d) => d.employeeId === fact.resolvedEmployeeId && d.calendarDate === fact.calendarDate)?.status ?? null;
  };

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.attendance_facts')}</h1>
      </div>

      {error && <div className="error-text">{error}</div>}

      <div className="card" style={{ marginBottom: 20, background: 'var(--panel-info-bg, #eef4ff)' }}>
        <p style={{ margin: 0 }}>{t('panel.biometric_schedule_vs_actual_notice')}</p>
        <p style={{ margin: '8px 0 0' }}>{t('panel.biometric_facts_not_payroll_notice')}</p>
      </div>

      {facts === null ? (
        <div className="empty-state">Loading…</div>
      ) : facts.length === 0 ? (
        <div className="empty-state">{t('panel.no_biometric_facts_yet')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.employee')}</th>
              <th>{t('field.ac_no')}</th>
              <th>{t('field.calendar_date')}</th>
              <th colSpan={2} style={{ textAlign: 'center' }}>
                Scheduled
              </th>
              <th colSpan={2} style={{ textAlign: 'center' }}>
                Actual
              </th>
              <th colSpan={4} style={{ textAlign: 'center' }}>
                Device Facts
              </th>
              <th>{t('field.reconciled_status')}</th>
            </tr>
            <tr>
              <th></th>
              <th></th>
              <th></th>
              <th>{t('field.on_duty')}</th>
              <th>{t('field.off_duty')}</th>
              <th>{t('field.check_in')}</th>
              <th>{t('field.check_out')}</th>
              <th>{t('field.late')}</th>
              <th>{t('field.early')}</th>
              <th>{t('field.absent_flag')}</th>
              <th>{t('field.ot_time')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {facts.map((f) => {
              const status = reconciledStatus(f);
              return (
                <tr key={f.id}>
                  <td>{employeeLabel(f.resolvedEmployeeId)}</td>
                  <td>{f.deviceUserRef}</td>
                  <td>{f.calendarDate}</td>
                  <td>{f.onDuty ?? '—'}</td>
                  <td>{f.offDuty ?? '—'}</td>
                  <td>{f.clockIn ?? '—'}</td>
                  <td>{f.clockOut ?? '—'}</td>
                  <td>{f.lateValue ?? '—'}</td>
                  <td>{f.earlyValue ?? '—'}</td>
                  <td>{f.sourceAbsent === null ? '—' : f.sourceAbsent ? 'True' : 'False'}</td>
                  <td>{f.otTimeValue ?? '—'}</td>
                  <td>{status ? <StatusBadge code={`value.attendance_day_status.${status}`} /> : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
