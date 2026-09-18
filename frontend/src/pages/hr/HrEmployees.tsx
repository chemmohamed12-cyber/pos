import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { StatusBadge } from '../../components/StatusBadge';

interface Department {
  id: string;
  code: string;
  name: string;
}
interface Employee {
  id: string;
  code: string;
  fullName: string;
  departmentId: string | null;
  position: string | null;
  hireDate: string | null;
  status: 'active' | 'on_leave' | 'terminated';
}

const NEXT_STATUS: Record<Employee['status'], Employee['status'][]> = {
  active: ['on_leave', 'terminated'],
  on_leave: ['active', 'terminated'],
  terminated: [],
};

/** HR (ADR-029) — Employees screen: list + create form + status transition, same shape as `TreasuryAccounts.tsx`. */
export function HrEmployees() {
  const { t, preload } = useLanguage();
  const [departments, setDepartments] = useState<Department[]>([]);
  const [employees, setEmployees] = useState<Employee[] | null>(null);
  const [code, setCode] = useState('');
  const [fullName, setFullName] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [position, setPosition] = useState('');
  const [hireDate, setHireDate] = useState('');
  const [creating, setCreating] = useState(false);
  const [busyStatus, setBusyStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  preload([
    'nav.hr_employees',
    'field.code',
    'field.full_name',
    'field.department',
    'field.position',
    'field.hire_date',
    'field.status',
    'field.actions',
    'action.create_employee',
    'action.change_employee_status',
    'panel.no_employees_yet',
    'value.employee_status.active',
    'value.employee_status.on_leave',
    'value.employee_status.terminated',
  ]);

  async function loadDepartments() {
    setDepartments(await api.get<Department[]>('/hr/departments'));
  }

  async function loadEmployees() {
    try {
      setEmployees(await api.get<Employee[]>('/hr/employees'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load employees.');
    }
  }

  useEffect(() => {
    loadDepartments();
    loadEmployees();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      await api.post('/hr/employees', {
        code,
        fullName,
        departmentId: departmentId || undefined,
        position: position || undefined,
        hireDate: hireDate || undefined,
      });
      setCode('');
      setFullName('');
      setDepartmentId('');
      setPosition('');
      setHireDate('');
      await loadEmployees();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create employee.');
    } finally {
      setCreating(false);
    }
  }

  async function setStatus(emp: Employee, status: Employee['status']) {
    setBusyStatus(emp.id);
    setError(null);
    try {
      await api.post(`/hr/employees/${emp.id}/status`, { status });
      await loadEmployees();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to change employee status.');
    } finally {
      setBusyStatus(null);
    }
  }

  const departmentName = (id: string | null) => departments.find((d) => d.id === id)?.name ?? '—';

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.hr_employees')}</h1>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <form onSubmit={onCreate} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.code')}</label>
            <input value={code} onChange={(e) => setCode(e.target.value)} required />
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.full_name')}</label>
            <input value={fullName} onChange={(e) => setFullName(e.target.value)} required />
          </div>
          <div className="form-field" style={{ marginBottom: 0, minWidth: 180 }}>
            <label>{t('field.department')}</label>
            <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
              <option value="">—</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.code} — {d.name}
                </option>
              ))}
            </select>
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.position')}</label>
            <input value={position} onChange={(e) => setPosition(e.target.value)} />
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.hire_date')}</label>
            <input type="date" value={hireDate} onChange={(e) => setHireDate(e.target.value)} />
          </div>
          <button className="btn btn-primary" type="submit" disabled={creating}>
            {t('action.create_employee')}
          </button>
        </form>
      </div>

      {error && <div className="error-text">{error}</div>}

      {employees === null ? (
        <div className="empty-state">Loading…</div>
      ) : employees.length === 0 ? (
        <div className="empty-state">{t('panel.no_employees_yet')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.code')}</th>
              <th>{t('field.full_name')}</th>
              <th>{t('field.department')}</th>
              <th>{t('field.position')}</th>
              <th>{t('field.hire_date')}</th>
              <th>{t('field.status')}</th>
              <th>{t('field.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {employees.map((emp) => (
              <tr key={emp.id}>
                <td>{emp.code}</td>
                <td>{emp.fullName}</td>
                <td>{departmentName(emp.departmentId)}</td>
                <td>{emp.position ?? '—'}</td>
                <td>{emp.hireDate ?? '—'}</td>
                <td>
                  <StatusBadge code={`value.employee_status.${emp.status}`} />
                </td>
                <td style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {NEXT_STATUS[emp.status].map((next) => (
                    <button
                      key={next}
                      className="btn btn-secondary"
                      disabled={busyStatus === emp.id}
                      onClick={() => setStatus(emp, next)}
                      title={t('action.change_employee_status')}
                    >
                      {t(`value.employee_status.${next}`)}
                    </button>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
