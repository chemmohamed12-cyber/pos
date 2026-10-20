import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { StatusBadge } from '../../components/StatusBadge';
import { ApprovalsPanel } from '../../components/ApprovalsPanel';
import { loadingLabel } from '../../lib/displayNames';

interface Employee {
  id: string;
  code: string;
  fullName: string;
}
interface Target {
  id: string;
  employeeId: string;
  periodStart: string;
  periodEnd: string;
  targetValue: string;
  status: 'draft' | 'pending_approval' | 'approved' | 'rejected';
}

const TARGET_REQUEST_TYPE_CODES = ['targets.target_approval'];

/** ADR-071 §4/§6 — Target Management: create (Employee + period + value mandatory, ADR-068 §D), submit for FA-01 approval, and the approvals queue. */
export function Targets() {
  const { t, preload } = useLanguage();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [targets, setTargets] = useState<Target[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [employeeId, setEmployeeId] = useState('');
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [targetValue, setTargetValue] = useState('');
  const [busy, setBusy] = useState(false);

  preload([
    'nav.targets',
    'field.employee',
    'field.period_start',
    'field.period_end',
    'field.target_value',
    'field.status',
    'field.actions',
    'action.create_target',
    'action.submit_target',
    'panel.no_targets_yet',
    'value.target_status.draft',
    'value.target_status.pending_approval',
    'value.target_status.approved',
    'value.target_status.rejected',
  ]);

  async function loadEmployees() {
    try {
      setEmployees(await api.get<Employee[]>('/hr/employees'));
    } catch (err) {
      // Foundation fix: no error handling — the employee select silently stayed empty.
      setError(err instanceof ApiError ? err.message : 'Failed to load employees.');
    }
  }
  async function loadTargets() {
    try {
      setTargets(await api.get<Target[]>('/targets/targets'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load targets.');
    }
  }

  useEffect(() => {
    loadEmployees();
    loadTargets();
  }, []);

  const employeeLabel = (empId: string) => {
    const emp = employees.find((e) => e.id === empId);
    return emp ? `${emp.code} — ${emp.fullName}` : empId.slice(0, 8);
  };

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/targets/targets', { employeeId, periodStart, periodEnd, targetValue });
      setEmployeeId('');
      setPeriodStart('');
      setPeriodEnd('');
      setTargetValue('');
      await loadTargets();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create target.');
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit(id: string) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/targets/targets/${id}/submit`);
      await loadTargets();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to submit target for approval.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.targets')}</h1>
      </div>

      {error && <div className="error-text">{error}</div>}

      <div className="card" style={{ marginBottom: 20 }}>
        <h3>{t('action.create_target')}</h3>
        <form onSubmit={onCreate} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="form-field" style={{ marginBottom: 0, minWidth: 220 }}>
            <label>{t('field.employee')}</label>
            <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} required>
              <option value="">—</option>
              {employees.map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {emp.code} — {emp.fullName}
                </option>
              ))}
            </select>
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.period_start')}</label>
            <input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} required />
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.period_end')}</label>
            <input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} required />
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.target_value')}</label>
            <input value={targetValue} onChange={(e) => setTargetValue(e.target.value)} required />
          </div>
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {t('action.create_target')}
          </button>
        </form>
      </div>

      <ApprovalsPanel requestTypeCodes={TARGET_REQUEST_TYPE_CODES} decidePath={(reqId) => `/targets/approvals/${reqId}/decide`} onDecided={loadTargets} />

      {targets === null ? (
        <div className="empty-state">{loadingLabel()}</div>
      ) : targets.length === 0 ? (
        <div className="empty-state">{t('panel.no_targets_yet')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.employee')}</th>
              <th>{t('field.period_start')}</th>
              <th>{t('field.period_end')}</th>
              <th>{t('field.target_value')}</th>
              <th>{t('field.status')}</th>
              <th>{t('field.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {targets.map((tg) => (
              <tr key={tg.id}>
                <td>{employeeLabel(tg.employeeId)}</td>
                <td>{tg.periodStart}</td>
                <td>{tg.periodEnd}</td>
                <td>{tg.targetValue}</td>
                <td>
                  <StatusBadge code={`value.target_status.${tg.status}`} />
                </td>
                <td>
                  {tg.status === 'draft' && (
                    <button className="btn btn-secondary" disabled={busy} onClick={() => onSubmit(tg.id)}>
                      {t('action.submit_target')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
