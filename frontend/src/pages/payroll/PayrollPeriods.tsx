import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { ErrorText, toUiError, type UiError } from '../../components/ErrorText';
import { useLanguage } from '../../context/LanguageContext';
import { StatusBadge } from '../../components/StatusBadge';
import { loadingLabel } from '../../lib/displayNames';
import { useAuth } from '../../context/AuthContext';

interface PayrollPeriod {
  id: string;
  code: string;
  startDate: string;
  endDate: string;
  status: 'open' | 'closed';
}

/** ADR-070 §A — Monthly Payroll Periods. Calculating a run for a period happens from PayrollRuns, not here. */
export function PayrollPeriods() {
  const { t, preload } = useLanguage();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [periods, setPeriods] = useState<PayrollPeriod[] | null>(null);
  const [error, setError] = useState<UiError | null>(null);
  const [code, setCode] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [creating, setCreating] = useState(false);

  preload([
    'nav.payroll_periods',
    'field.period_code',
    'field.status',
    'field.actions',
    'action.create_period',
    'action.view_details',
    'action.close_period',
    'field.start_date',
    'field.end_date',
    'msg.loading',
    'msg.load_failed',
    'msg.action_failed',
    'panel.no_periods_yet',
    'value.payroll_period_status.open',
    'value.payroll_period_status.closed',
  ]);

  async function loadPeriods() {
    try {
      setPeriods(await api.get<PayrollPeriod[]>('/payroll/periods'));
    } catch (err) {
      setError(toUiError(err, t, 'msg.load_failed'));
    }
  }

  useEffect(() => {
    loadPeriods();
  }, []);

  async function onClose(id: string) {
    setError(null);
    try {
      await api.post(`/payroll/periods/${id}/close`);
      await loadPeriods();
    } catch (err) {
      setError(toUiError(err, t, 'msg.action_failed'));
    }
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      await api.post('/payroll/periods', { code, startDate, endDate });
      setCode('');
      setStartDate('');
      setEndDate('');
      await loadPeriods();
    } catch (err) {
      setError(toUiError(err, t, 'msg.action_failed'));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.payroll_periods')}</h1>
      </div>

      {error && (
        <div className="error-text">
          <ErrorText error={error} />
        </div>
      )}

      <div className="card" style={{ marginBottom: 20 }}>
        <h3>{t('action.create_period')}</h3>
        <form onSubmit={onCreate} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.period_code')}</label>
            <input value={code} onChange={(e) => setCode(e.target.value)} required />
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.start_date')}</label>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.end_date')}</label>
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} required />
          </div>
          <button className="btn btn-primary" type="submit" disabled={creating}>
            {t('action.create_period')}
          </button>
        </form>
      </div>

      {periods === null ? (
        <div className="empty-state">{t('msg.loading')}</div>
      ) : periods.length === 0 ? (
        <div className="empty-state">{t('panel.no_periods_yet')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.period_code')}</th>
              <th>{t('field.start_date')}</th>
              <th>{t('field.end_date')}</th>
              <th>{t('field.status')}</th>
              <th>{t('field.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {periods.map((p) => (
              <tr key={p.id}>
                <td>{p.code}</td>
                <td>{p.startDate}</td>
                <td>{p.endDate}</td>
                <td>
                  <StatusBadge code={`value.payroll_period_status.${p.status}`} />
                </td>
                <td>
                  <button className="btn btn-secondary" onClick={() => navigate('/payroll/runs')}>
                    {t('nav.payroll_runs')}
                  </button>
                  {p.status === 'open' && can('payroll.period.close') && (
                    <button className="btn btn-secondary" style={{ marginInlineStart: 8 }} onClick={() => onClose(p.id)}>
                      {t('action.close_period')}
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
