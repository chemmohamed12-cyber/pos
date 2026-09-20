import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';

interface Employee {
  id: string;
  code: string;
  fullName: string;
}
interface CommissionResult {
  id: string;
  employeeId: string;
  customerId: string;
  calculationBasis: string;
  policyScope: string;
  rate: string;
  calculatedAmount: string;
  calculationTimestamp: string;
  batchId: string | null;
}
interface CommissionAdjustment {
  id: string;
  originalCommissionResultId: string;
  kind: string;
  reason: string;
  amountDelta: string;
  createdAt: string;
}

/** ADR-068 §F/§H — the immutable CommissionResult snapshot and its correction trail. No result field is ever edited here — only a new Adjustment row may reference one. */
export function CommissionResults() {
  const { t, preload } = useLanguage();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [results, setResults] = useState<CommissionResult[] | null>(null);
  const [adjustments, setAdjustments] = useState<CommissionAdjustment[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [originalCommissionResultId, setOriginalCommissionResultId] = useState('');
  const [kind, setKind] = useState<'adjustment' | 'correction' | 'recalculation'>('adjustment');
  const [reason, setReason] = useState('');
  const [amountDelta, setAmountDelta] = useState('');
  const [busy, setBusy] = useState(false);

  preload([
    'nav.commission_results',
    'field.employee',
    'field.basis',
    'field.scope',
    'field.rate',
    'field.amount',
    'field.batch',
    'field.adjustment_kind',
    'field.amount_delta',
    'field.reason',
    'field.actions',
    'action.create_adjustment',
    'panel.no_results_yet',
    'panel.no_adjustments_yet',
    'value.adjustment_kind.adjustment',
    'value.adjustment_kind.correction',
    'value.adjustment_kind.recalculation',
  ]);

  async function loadEmployees() {
    setEmployees(await api.get<Employee[]>('/hr/employees'));
  }
  async function loadResults() {
    try {
      setResults(await api.get<CommissionResult[]>('/commission/results'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load commission results.');
    }
  }
  async function loadAdjustments() {
    try {
      setAdjustments(await api.get<CommissionAdjustment[]>('/commission/adjustments'));
    } catch {
      setAdjustments([]);
    }
  }

  useEffect(() => {
    loadEmployees();
    loadResults();
    loadAdjustments();
  }, []);

  const employeeLabel = (empId: string) => {
    const emp = employees.find((e) => e.id === empId);
    return emp ? `${emp.code} — ${emp.fullName}` : empId.slice(0, 8);
  };

  async function onCreateAdjustment(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/commission/adjustments', { originalCommissionResultId, kind, reason, amountDelta });
      setOriginalCommissionResultId('');
      setReason('');
      setAmountDelta('');
      await loadAdjustments();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create adjustment.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.commission_results')}</h1>
      </div>

      {error && <div className="error-text">{error}</div>}

      {results === null ? (
        <div className="empty-state">Loading…</div>
      ) : results.length === 0 ? (
        <div className="empty-state">{t('panel.no_results_yet')}</div>
      ) : (
        <table className="data-table" style={{ marginBottom: 20 }}>
          <thead>
            <tr>
              <th>{t('field.employee')}</th>
              <th>{t('field.scope')}</th>
              <th>{t('field.basis')}</th>
              <th>{t('field.rate')}</th>
              <th>{t('field.amount')}</th>
              <th>{t('field.batch')}</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) => (
              <tr key={r.id}>
                <td>{employeeLabel(r.employeeId)}</td>
                <td>{r.policyScope}</td>
                <td>{r.calculationBasis}</td>
                <td>{r.rate}</td>
                <td>{r.calculatedAmount}</td>
                <td>{r.batchId ? r.batchId.slice(0, 8) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="card" style={{ marginBottom: 20 }}>
        <h3>{t('action.create_adjustment')}</h3>
        <form onSubmit={onCreateAdjustment} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="form-field" style={{ marginBottom: 0, minWidth: 260 }}>
            <label>Commission Result</label>
            <select value={originalCommissionResultId} onChange={(e) => setOriginalCommissionResultId(e.target.value)} required>
              <option value="">—</option>
              {(results ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {employeeLabel(r.employeeId)} — {r.calculatedAmount}
                </option>
              ))}
            </select>
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.adjustment_kind')}</label>
            <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="adjustment">{t('value.adjustment_kind.adjustment')}</option>
              <option value="correction">{t('value.adjustment_kind.correction')}</option>
              <option value="recalculation">{t('value.adjustment_kind.recalculation')}</option>
            </select>
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.amount_delta')}</label>
            <input value={amountDelta} onChange={(e) => setAmountDelta(e.target.value)} required />
          </div>
          <div className="form-field" style={{ marginBottom: 0, minWidth: 220 }}>
            <label>{t('field.reason')}</label>
            <input value={reason} onChange={(e) => setReason(e.target.value)} required />
          </div>
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {t('action.create_adjustment')}
          </button>
        </form>
      </div>

      {adjustments.length === 0 ? (
        <div className="empty-state">{t('panel.no_adjustments_yet')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.adjustment_kind')}</th>
              <th>{t('field.amount_delta')}</th>
              <th>{t('field.reason')}</th>
            </tr>
          </thead>
          <tbody>
            {adjustments.map((a) => (
              <tr key={a.id}>
                <td>{t(`value.adjustment_kind.${a.kind}`)}</td>
                <td>{a.amountDelta}</td>
                <td>{a.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
