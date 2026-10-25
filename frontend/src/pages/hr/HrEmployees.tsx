import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { StatusBadge } from '../../components/StatusBadge';
import { loadingLabel } from '../../lib/displayNames';

interface Department {
  id: string;
  name: string;
  code: string | null;
}
interface AdminUser {
  id: string;
  email: string;
  fullName: string;
}
interface Employee {
  id: string;
  code: string;
  fullName: string;
  departmentId: string | null;
  position: string | null;
  hireDate: string | null;
  status: 'active' | 'on_leave' | 'terminated';
  userId: string | null;
  managerId: string | null;
  employmentType: 'full_time' | 'part_time' | 'contractor' | null;
  terminationDate: string | null;
  terminationReason: string | null;
}

const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contractor'] as const;
const NEXT_STATUS: Record<Employee['status'], Array<'active' | 'on_leave'>> = {
  active: ['on_leave'],
  on_leave: ['active'],
  terminated: [],
};

/** ADR-059 (HR Phase 1) — Employees screen. Employee codes are `NumberingService`-issued (D4), never entered by hand. Termination (D3) and manual User linking (D2) are their own dedicated actions, each behind its own permission node. */
export function HrEmployees() {
  const { t, preload } = useLanguage();
  const [departments, setDepartments] = useState<Department[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [employees, setEmployees] = useState<Employee[] | null>(null);
  const [fullName, setFullName] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [position, setPosition] = useState('');
  const [hireDate, setHireDate] = useState('');
  const [employmentType, setEmploymentType] = useState<(typeof EMPLOYMENT_TYPES)[number] | ''>('');
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [terminatingId, setTerminatingId] = useState<string | null>(null);
  const [terminateReason, setTerminateReason] = useState('');

  const [linkingId, setLinkingId] = useState<string | null>(null);
  const [linkUserId, setLinkUserId] = useState('');

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editFullName, setEditFullName] = useState('');
  const [editPosition, setEditPosition] = useState('');
  const [editDepartmentId, setEditDepartmentId] = useState('');
  const [editEmploymentType, setEditEmploymentType] = useState<(typeof EMPLOYMENT_TYPES)[number] | ''>('');
  const [editManagerId, setEditManagerId] = useState('');

  preload([
    'nav.hr_employees',
    'field.code',
    'field.full_name',
    'field.department',
    'field.position',
    'field.hire_date',
    'field.status',
    'field.actions',
    'field.employment_type',
    'field.linked_user',
    'field.termination_reason',
    'field.termination_date',
    'field.manager',
    'action.create_employee',
    'action.change_employee_status',
    'action.terminate_employee',
    'action.link_user',
    'action.edit_employee',
    'action.save',
    'action.confirm',
    'action.cancel',
    'panel.no_employees_yet',
    'value.employee_status.active',
    'value.employee_status.on_leave',
    'value.employee_status.terminated',
    ...EMPLOYMENT_TYPES.map((et) => `value.employment_type.${et}`),
  ]);

  async function loadDepartments() {
    setDepartments(await api.get<Department[]>('/hr/departments'));
  }

  async function loadUsers() {
    try {
      setUsers(await api.get<AdminUser[]>('/hr/link-candidates'));
    } catch {
      // link-user picker degrades to empty — not fatal for the rest of the page
    }
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
    loadUsers();
    loadEmployees();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      await api.post('/hr/employees', {
        fullName,
        departmentId: departmentId || undefined,
        position: position || undefined,
        hireDate: hireDate || undefined,
        employmentType: employmentType || undefined,
      });
      setFullName('');
      setDepartmentId('');
      setPosition('');
      setHireDate('');
      setEmploymentType('');
      await loadEmployees();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create employee.');
    } finally {
      setCreating(false);
    }
  }

  async function setStatus(emp: Employee, status: 'active' | 'on_leave') {
    setBusyId(emp.id);
    setError(null);
    try {
      await api.post(`/hr/employees/${emp.id}/status`, { status });
      await loadEmployees();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to change employee status.');
    } finally {
      setBusyId(null);
    }
  }

  async function confirmTerminate(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await api.post(`/hr/employees/${id}/terminate`, { reason: terminateReason });
      setTerminatingId(null);
      setTerminateReason('');
      await loadEmployees();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to terminate employee.');
    } finally {
      setBusyId(null);
    }
  }

  async function confirmLinkUser(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await api.post(`/hr/employees/${id}/link-user`, { userId: linkUserId });
      setLinkingId(null);
      setLinkUserId('');
      await loadEmployees();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to link user.');
    } finally {
      setBusyId(null);
    }
  }

  function startEdit(emp: Employee) {
    setEditingId(emp.id);
    setEditFullName(emp.fullName);
    setEditPosition(emp.position ?? '');
    setEditDepartmentId(emp.departmentId ?? '');
    setEditEmploymentType(emp.employmentType ?? '');
    setEditManagerId(emp.managerId ?? '');
  }

  async function saveEdit(emp: Employee) {
    setBusyId(emp.id);
    setError(null);
    try {
      await api.post(`/hr/employees/${emp.id}`, {
        fullName: editFullName,
        position: editPosition || null,
        departmentId: editDepartmentId || null,
        employmentType: editEmploymentType || null,
      });
      if (editManagerId !== (emp.managerId ?? '')) {
        await api.post(`/hr/employees/${emp.id}/manager`, { managerId: editManagerId || null });
      }
      setEditingId(null);
      await loadEmployees();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to edit employee.');
    } finally {
      setBusyId(null);
    }
  }

  const departmentName = (id: string | null) => departments.find((d) => d.id === id)?.name ?? '—';
  const userLabel = (id: string | null) => (id ? (users.find((u) => u.id === id)?.fullName ?? id.slice(0, 8)) : '—');
  const employeeLabel = (id: string | null) => {
    const found = employees?.find((e) => e.id === id);
    return found ? `${found.code} — ${found.fullName}` : '—';
  };

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.hr_employees')}</h1>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <form onSubmit={onCreate} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
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
                  {d.code ? `${d.code} — ${d.name}` : d.name}
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
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.employment_type')}</label>
            <select value={employmentType} onChange={(e) => setEmploymentType(e.target.value as never)}>
              <option value="">—</option>
              {EMPLOYMENT_TYPES.map((et) => (
                <option key={et} value={et}>
                  {t(`value.employment_type.${et}`)}
                </option>
              ))}
            </select>
          </div>
          <button className="btn btn-primary" type="submit" disabled={creating}>
            {t('action.create_employee')}
          </button>
        </form>
      </div>

      {error && <div className="error-text">{error}</div>}

      {employees === null ? (
        <div className="empty-state">{loadingLabel()}</div>
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
              <th>{t('field.employment_type')}</th>
              <th>{t('field.manager')}</th>
              <th>{t('field.linked_user')}</th>
              <th>{t('field.status')}</th>
              <th>{t('field.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {employees.map((emp) =>
              editingId === emp.id ? (
                <tr key={emp.id}>
                  <td>{emp.code}</td>
                  <td>
                    <input value={editFullName} onChange={(e) => setEditFullName(e.target.value)} style={{ width: 140 }} />
                  </td>
                  <td>
                    <select value={editDepartmentId} onChange={(e) => setEditDepartmentId(e.target.value)}>
                      <option value="">—</option>
                      {departments.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.code ? `${d.code} — ${d.name}` : d.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input value={editPosition} onChange={(e) => setEditPosition(e.target.value)} style={{ width: 100 }} />
                  </td>
                  <td>
                    <select value={editEmploymentType} onChange={(e) => setEditEmploymentType(e.target.value as never)}>
                      <option value="">—</option>
                      {EMPLOYMENT_TYPES.map((et) => (
                        <option key={et} value={et}>
                          {t(`value.employment_type.${et}`)}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select value={editManagerId} onChange={(e) => setEditManagerId(e.target.value)}>
                      <option value="">—</option>
                      {employees
                        .filter((e) => e.id !== emp.id)
                        .map((e) => (
                          <option key={e.id} value={e.id}>
                            {e.code} — {e.fullName}
                          </option>
                        ))}
                    </select>
                  </td>
                  <td>{userLabel(emp.userId)}</td>
                  <td>
                    <StatusBadge code={`value.employee_status.${emp.status}`} />
                  </td>
                  <td style={{ display: 'flex', gap: 6 }}>
                    <button className="btn btn-primary" disabled={busyId === emp.id} onClick={() => saveEdit(emp)}>
                      {t('action.save')}
                    </button>
                    <button className="btn btn-secondary" onClick={() => setEditingId(null)}>
                      {t('action.cancel')}
                    </button>
                  </td>
                </tr>
              ) : (
              <tr key={emp.id}>
                <td>{emp.code}</td>
                <td>{emp.fullName}</td>
                <td>{departmentName(emp.departmentId)}</td>
                <td>{emp.position ?? '—'}</td>
                <td>{emp.employmentType ? t(`value.employment_type.${emp.employmentType}`) : '—'}</td>
                <td>{employeeLabel(emp.managerId)}</td>
                <td>{userLabel(emp.userId)}</td>
                <td>
                  <StatusBadge code={`value.employee_status.${emp.status}`} />
                  {emp.status === 'terminated' && emp.terminationReason && (
                    <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>{emp.terminationReason}</div>
                  )}
                </td>
                <td style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 220 }}>
                  {emp.status !== 'terminated' && (
                    <button className="btn btn-secondary" onClick={() => startEdit(emp)}>
                      {t('action.edit_employee')}
                    </button>
                  )}
                  {emp.status !== 'terminated' && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {NEXT_STATUS[emp.status].map((next) => (
                        <button key={next} className="btn btn-secondary" disabled={busyId === emp.id} onClick={() => setStatus(emp, next)}>
                          {t(`value.employee_status.${next}`)}
                        </button>
                      ))}
                      {terminatingId === emp.id ? (
                        <>
                          <input
                            placeholder={t('field.termination_reason')}
                            value={terminateReason}
                            onChange={(e) => setTerminateReason(e.target.value)}
                            style={{ width: 140 }}
                          />
                          <button className="btn btn-danger" disabled={busyId === emp.id} onClick={() => confirmTerminate(emp.id)}>
                            {t('action.confirm')}
                          </button>
                          <button className="btn btn-secondary" onClick={() => setTerminatingId(null)}>
                            {t('action.cancel')}
                          </button>
                        </>
                      ) : (
                        <button className="btn btn-danger" onClick={() => setTerminatingId(emp.id)}>
                          {t('action.terminate_employee')}
                        </button>
                      )}
                    </div>
                  )}
                  {!emp.userId && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {linkingId === emp.id ? (
                        <>
                          <select value={linkUserId} onChange={(e) => setLinkUserId(e.target.value)} style={{ minWidth: 140 }}>
                            <option value="">—</option>
                            {users.map((u) => (
                              <option key={u.id} value={u.id}>
                                {u.fullName} ({u.email})
                              </option>
                            ))}
                          </select>
                          <button className="btn btn-primary" disabled={busyId === emp.id || !linkUserId} onClick={() => confirmLinkUser(emp.id)}>
                            {t('action.confirm')}
                          </button>
                          <button className="btn btn-secondary" onClick={() => setLinkingId(null)}>
                            {t('action.cancel')}
                          </button>
                        </>
                      ) : (
                        <button className="btn btn-secondary" onClick={() => setLinkingId(emp.id)}>
                          {t('action.link_user')}
                        </button>
                      )}
                    </div>
                  )}
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
