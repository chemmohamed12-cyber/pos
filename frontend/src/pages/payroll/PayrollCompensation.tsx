import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { nameOf, currentLang, STATUS_NAMES } from '../../lib/displayNames';
import { fmtDate } from '../../lib/formatDateTime';

interface Employee {
  id: string;
  code: string;
  fullName: string;
  status: 'active' | 'on_leave' | 'terminated';
  employmentType: string | null;
}
interface EarningLineDraft {
  componentCode: string;
  amount: string;
}
interface PayrollCompensationRow {
  id: string;
  employeeId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: 'active' | 'superseded';
}

/** ADR-070 §B — componentized Earnings, never a single figure. Effective-dated: creating a new compensation record automatically closes the employee's prior active one (server-side), never rewriting history. */
export function PayrollCompensation() {
  const { t, preload } = useLanguage();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [compensations, setCompensations] = useState<PayrollCompensationRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [employeeId, setEmployeeId] = useState('');
  const [earnings, setEarnings] = useState<EarningLineDraft[]>([{ componentCode: 'basic', amount: '' }]);
  const [saving, setSaving] = useState(false);

  preload([
    'nav.payroll_compensation',
    'field.employee',
    'field.component_code',
    'field.amount',
    'field.status',
    'action.create_compensation',
    'action.add_earning_line',
    'panel.no_compensations_yet',
    'value.payroll_period_status.open',
  ]);

  async function loadEmployees() {
    try {
      setEmployees(await api.get<Employee[]>('/hr/employees'));
    } catch (err) {
      // Foundation fix: no error handling — employee selects/labels silently stayed empty.
      setError(err instanceof ApiError ? err.message : 'Failed to load employees.');
    }
  }
  async function loadCompensations() {
    try {
      setCompensations(await api.get<PayrollCompensationRow[]>('/payroll/compensations'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load compensation records.');
    }
  }

  useEffect(() => {
    loadEmployees();
    loadCompensations();
  }, []);

  const employeeLabel = (id: string) => {
    const emp = employees.find((e) => e.id === id);
    return emp ? `${emp.code} — ${emp.fullName}` : id.slice(0, 8);
  };

  function updateLine(i: number, patch: Partial<EarningLineDraft>) {
    setEarnings((lines) => lines.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }
  function addLine() {
    setEarnings((lines) => [...lines, { componentCode: '', amount: '' }]);
  }
  function removeLine(i: number) {
    setEarnings((lines) => lines.filter((_, idx) => idx !== i));
  }

  async function onSave(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.post('/payroll/compensations', {
        employeeId,
        earnings: earnings.filter((l) => l.componentCode && l.amount).map((l) => ({ componentCode: l.componentCode, amount: l.amount })),
      });
      setEmployeeId('');
      setEarnings([{ componentCode: 'basic', amount: '' }]);
      await loadCompensations();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save compensation.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.payroll_compensation')}</h1>
      </div>

      {error && <div className="error-text">{error}</div>}

      <div className="card" style={{ marginBottom: 20 }}>
        <h3>{t('action.create_compensation')}</h3>
        <form onSubmit={onSave}>
          <div className="form-field" style={{ maxWidth: 320 }}>
            <label>{t('field.employee')}</label>
            <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} required>
              <option value="">—</option>
              {employees
                .filter((e) => e.status === 'active' && e.employmentType !== 'contractor')
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.code} — {e.fullName}
                  </option>
                ))}
            </select>
          </div>

          {earnings.map((line, i) => (
            <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginBottom: 8 }}>
              <div className="form-field" style={{ marginBottom: 0 }}>
                <label>{t('field.component_code')}</label>
                <input value={line.componentCode} onChange={(e) => updateLine(i, { componentCode: e.target.value })} placeholder="basic" required />
              </div>
              <div className="form-field" style={{ marginBottom: 0 }}>
                <label>{t('field.amount')}</label>
                <input value={line.amount} onChange={(e) => updateLine(i, { amount: e.target.value })} placeholder="0.00" required />
              </div>
              {earnings.length > 1 && (
                <button type="button" className="btn btn-secondary" onClick={() => removeLine(i)}>
                  ×
                </button>
              )}
            </div>
          ))}
          <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
            <button type="button" className="btn btn-secondary" onClick={addLine}>
              {t('action.add_earning_line')}
            </button>
            <button className="btn btn-primary" type="submit" disabled={saving || !employeeId}>
              {t('action.create_compensation')}
            </button>
          </div>
        </form>
      </div>

      {compensations === null ? (
        <div className="empty-state">Loading…</div>
      ) : compensations.length === 0 ? (
        <div className="empty-state">{t('panel.no_compensations_yet')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.employee')}</th>
              <th>Effective From</th>
              <th>Effective To</th>
              <th>{t('field.status')}</th>
            </tr>
          </thead>
          <tbody>
            {compensations.map((c) => (
              <tr key={c.id}>
                <td>{employeeLabel(c.employeeId)}</td>
                <td>{fmtDate(c.effectiveFrom)}</td>
                <td>{c.effectiveTo ? fmtDate(c.effectiveTo) : '—'}</td>
                <td>{nameOf(STATUS_NAMES, c.status, currentLang())}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
