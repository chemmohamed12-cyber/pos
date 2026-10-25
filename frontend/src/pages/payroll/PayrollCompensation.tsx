import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../../lib/api';
import { ErrorText, toUiError, type UiError } from '../../components/ErrorText';
import { useLanguage } from '../../context/LanguageContext';
import { STATUS_NAMES, currentLang, loadingLabel, nameOf } from '../../lib/displayNames';
import { fmtDate } from '../../lib/formatDateTime';
import { StatusBadge } from '../../components/StatusBadge';

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
  reason: string | null;
}

/** ADR-070 §B — componentized Earnings, never a single figure. Effective-dated: creating a new compensation record automatically closes the employee's prior active one (server-side), never rewriting history. */
export function PayrollCompensation() {
  const { t, preload } = useLanguage();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [compensations, setCompensations] = useState<PayrollCompensationRow[] | null>(null);
  const [error, setError] = useState<UiError | null>(null);

  const [employeeId, setEmployeeId] = useState('');
  const [earnings, setEarnings] = useState<EarningLineDraft[]>([{ componentCode: 'basic', amount: '' }]);
  const [saving, setSaving] = useState(false);
  const [effectiveFrom, setEffectiveFrom] = useState(new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState('');

  preload([
    'nav.payroll_compensation',
    'field.employee',
    'field.component_code',
    'field.amount',
    'field.status',
    'action.create_compensation',
    'action.add_earning_line',
    'panel.no_compensations_yet',
    'field.effective_from',
    'field.effective_to',
    'field.reason',
    'msg.loading',
    'msg.load_failed',
    'msg.action_failed',
    'value.payroll_period_status.open',
  ]);

  async function loadEmployees() {
    try {
      setEmployees(await api.get<Employee[]>('/hr/employees'));
    } catch (err) {
      // Foundation fix: no error handling — employee selects/labels silently stayed empty.
      setError(toUiError(err, t, 'msg.load_failed'));
    }
  }
  async function loadCompensations() {
    try {
      setCompensations(await api.get<PayrollCompensationRow[]>('/payroll/compensations'));
    } catch (err) {
      setError(toUiError(err, t, 'msg.load_failed'));
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
        effectiveFrom,
        reason,
        earnings: earnings.filter((l) => l.componentCode && l.amount).map((l) => ({ componentCode: l.componentCode, amount: l.amount })),
      });
      setEmployeeId('');
      setReason('');
      setEarnings([{ componentCode: 'basic', amount: '' }]);
      await loadCompensations();
    } catch (err) {
      setError(toUiError(err, t, 'msg.action_failed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.payroll_compensation')}</h1>
      </div>

      {error && (
        <div className="error-text">
          <ErrorText error={error} />
        </div>
      )}

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

          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <div className="form-field" style={{ minWidth: 180 }}>
              <label>{t('field.effective_from')}</label>
              <input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} required />
            </div>
            <div className="form-field" style={{ minWidth: 260, flex: 1 }}>
              <label>{t('field.reason')}</label>
              <input value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={500} required />
            </div>
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
            <button className="btn btn-primary" type="submit" disabled={saving || !employeeId || reason.trim().length < 3}>
              {t('action.create_compensation')}
            </button>
          </div>
        </form>
      </div>

      {compensations === null ? (
        <div className="empty-state">{t('msg.loading')}</div>
      ) : compensations.length === 0 ? (
        <div className="empty-state">{t('panel.no_compensations_yet')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.employee')}</th>
              <th>{t('field.effective_from')}</th>
              <th>{t('field.effective_to')}</th>
              <th>{t('field.reason')}</th>
              <th>{t('field.status')}</th>
            </tr>
          </thead>
          <tbody>
            {compensations.map((c) => (
              <tr key={c.id}>
                <td>{employeeLabel(c.employeeId)}</td>
                <td>{new Date(c.effectiveFrom).toLocaleDateString()}</td>
                <td>{c.effectiveTo ? new Date(c.effectiveTo).toLocaleDateString() : '—'}</td>
                <td>{c.reason ?? '—'}</td>
                <td>
                  <StatusBadge code={`value.compensation_status.${c.status}`} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
