import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { ErrorText, toUiError, type UiError } from '../../components/ErrorText';
import { useLanguage } from '../../context/LanguageContext';
import { StatusBadge } from '../../components/StatusBadge';
import { currentLang, loadingLabel } from '../../lib/displayNames';

interface PayrollPeriod {
  id: string;
  code: string;
  startDate: string;
  endDate: string;
}
interface PayrollRun {
  id: string;
  code: string;
  payrollPeriodId: string;
  status: 'draft' | 'calculated' | 'reviewed' | 'approved' | 'posted' | 'superseded';
  revision: number;
  kind: 'regular' | 'supplementary';
  postedAt: string | null;
  disbursedAt: string | null;
}

/** ADR-070 §5 — calculate() creates or recomputes the one PayrollRun for a period (Phase 1 scope is company-wide, one run per period). Review/Approval/Disbursement live on the Run Detail page. */
export function PayrollRuns() {
  const { t, preload } = useLanguage();
  const navigate = useNavigate();
  const [periods, setPeriods] = useState<PayrollPeriod[]>([]);
  const [runs, setRuns] = useState<PayrollRun[] | null>(null);
  const [error, setError] = useState<UiError | null>(null);
  const [payrollPeriodId, setPayrollPeriodId] = useState('');
  const [calculating, setCalculating] = useState(false);

  preload([
    'nav.payroll_runs',
    'field.run_code',
    'field.status',
    'field.actions',
    'field.financial_event_status',
    'field.disbursement_status',
    'action.calculate_run',
    'action.view_details',
    'panel.no_runs_yet',
    'value.payroll_run_status.draft',
    'value.payroll_run_status.calculated',
    'value.payroll_run_status.reviewed',
    'value.payroll_run_status.approved',
    'value.payroll_run_status.posted',
    'value.payroll_run_status.superseded',
    'value.payroll_run_kind.regular',
    'value.payroll_run_kind.supplementary',
    'field.revision',
    'field.payroll_period',
    'msg.loading',
    'msg.load_failed',
    'msg.action_failed',
    'value.disbursement_status.pending',
    'value.disbursement_status.disbursed',
  ]);

  async function loadPeriods() {
    try {
      setPeriods(await api.get<PayrollPeriod[]>('/payroll/periods'));
    } catch (err) {
      // Foundation fix: no error handling — the period selector silently stayed empty.
      setError(toUiError(err, t, 'msg.load_failed'));
    }
  }
  async function loadRuns() {
    try {
      setRuns(await api.get<PayrollRun[]>('/payroll/runs'));
    } catch (err) {
      setError(toUiError(err, t, 'msg.load_failed'));
    }
  }

  useEffect(() => {
    loadPeriods();
    loadRuns();
  }, []);

  const periodCode = (id: string) => periods.find((p) => p.id === id)?.code ?? id.slice(0, 8);

  async function onCalculate(e: FormEvent) {
    e.preventDefault();
    setCalculating(true);
    setError(null);
    try {
      const run = await api.post<PayrollRun>('/payroll/runs/calculate', { payrollPeriodId });
      await loadRuns();
      navigate(`/payroll/runs/${run.id}`);
    } catch (err) {
      setError(toUiError(err, t, 'msg.action_failed'));
    } finally {
      setCalculating(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.payroll_runs')}</h1>
      </div>

      {error && (
        <div className="error-text">
          <ErrorText error={error} />
        </div>
      )}

      <div className="card" style={{ marginBottom: 20 }}>
        <h3>{t('action.calculate_run')}</h3>
        <form onSubmit={onCalculate} style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
          <div className="form-field" style={{ marginBottom: 0, minWidth: 200 }}>
            <label>{t('field.payroll_period')}</label>
            <select value={payrollPeriodId} onChange={(e) => setPayrollPeriodId(e.target.value)} required>
              <option value="">—</option>
              {periods.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.code} ({p.startDate} → {p.endDate})
                </option>
              ))}
            </select>
          </div>
          <button className="btn btn-primary" type="submit" disabled={calculating || !payrollPeriodId}>
            {t('action.calculate_run')}
          </button>
        </form>
      </div>

      {runs === null ? (
        <div className="empty-state">{t('msg.loading')}</div>
      ) : runs.length === 0 ? (
        <div className="empty-state">{t('panel.no_runs_yet')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.run_code')}</th>
              <th>{t('field.payroll_period')}</th>
              <th>{t('field.revision')}</th>
              <th>{t('field.status')}</th>
              <th>{t('field.disbursement_status')}</th>
              <th>{t('field.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td>{r.code}</td>
                <td>{periodCode(r.payrollPeriodId)}</td>
                <td>
                  {r.revision} <StatusBadge code={`value.payroll_run_kind.${r.kind}`} />
                </td>
                <td>
                  <StatusBadge code={`value.payroll_run_status.${r.status}`} />
                </td>
                <td>
                  <StatusBadge code={`value.disbursement_status.${r.disbursedAt ? 'disbursed' : 'pending'}`} />
                </td>
                <td>
                  <button className="btn btn-secondary" onClick={() => navigate(`/payroll/runs/${r.id}`)}>
                    {t('action.view_details')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
