import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { StatusBadge } from '../../components/StatusBadge';

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
  const [periods, setPeriods] = useState<PayrollPeriod[] | null>(null);
  const [error, setError] = useState<string | null>(null);
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
    'panel.no_periods_yet',
    'value.payroll_period_status.open',
    'value.payroll_period_status.closed',
  ]);

  async function loadPeriods() {
    try {
      setPeriods(await api.get<PayrollPeriod[]>('/payroll/periods'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load payroll periods.');
    }
  }

  useEffect(() => {
    loadPeriods();
  }, []);

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
      setError(err instanceof ApiError ? err.message : 'Failed to create period.');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.payroll_periods')}</h1>
      </div>

      {error && <div className="error-text">{error}</div>}

      <div className="card" style={{ marginBottom: 20 }}>
        <h3>{t('action.create_period')}</h3>
        <form onSubmit={onCreate} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.period_code')}</label>
            <input value={code} onChange={(e) => setCode(e.target.value)} required />
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>Start</label>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>End</label>
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} required />
          </div>
          <button className="btn btn-primary" type="submit" disabled={creating}>
            {t('action.create_period')}
          </button>
        </form>
      </div>

      {periods === null ? (
        <div className="empty-state">Loading…</div>
      ) : periods.length === 0 ? (
        <div className="empty-state">{t('panel.no_periods_yet')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.period_code')}</th>
              <th>Start</th>
              <th>End</th>
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
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
