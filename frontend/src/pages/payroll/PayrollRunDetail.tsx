import { Fragment, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { StatusBadge } from '../../components/StatusBadge';
import { ApprovalsPanel } from '../../components/ApprovalsPanel';

interface Employee {
  id: string;
  code: string;
  fullName: string;
}
interface PayrollRun {
  id: string;
  code: string;
  status: 'draft' | 'calculated' | 'reviewed' | 'approved' | 'posted';
  postedAt: string | null;
  disbursedAt: string | null;
}
interface PayrollRunLine {
  id: string;
  employeeId: string;
  grossPay: string;
  totalDeductions: string;
  netPay: string;
  commissionAmount: string | null;
  overtimeAmount: string | null;
}
interface DayClassification {
  id: string;
  calendarDate: string;
  attendanceStatus: string;
  dayType: string;
  payImpact: string;
}
interface FinancialEventStatus {
  status: string;
  rejectionReason: string | null;
  journalEntryId: string | null;
}
interface TreasuryAccount {
  id: string;
  code: string;
  name: string;
  balance: string;
}
interface ReconciliationGap {
  payrollRunId: string;
  code: string;
}

const PAYROLL_REQUEST_TYPE_CODES = ['payroll.run_approval'];

/** ADR-070 — the Run Detail screen. Deliberately keeps three separate, differently-sourced status indicators: PayrollRun.status (this run's own record), Financial Event status (a live query into Accounting, never assumed from PayrollRun alone — ADR-070 §6), and disbursement status (Treasury) — never merging them into one. */
export function PayrollRunDetail() {
  const { id } = useParams<{ id: string }>();
  const { t, preload } = useLanguage();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [run, setRun] = useState<PayrollRun | null>(null);
  const [lines, setLines] = useState<PayrollRunLine[]>([]);
  const [financialEvent, setFinancialEvent] = useState<FinancialEventStatus | null>(null);
  const [gaps, setGaps] = useState<ReconciliationGap[]>([]);
  const [expandedLine, setExpandedLine] = useState<string | null>(null);
  const [classifications, setClassifications] = useState<DayClassification[]>([]);
  const [treasuryAccounts, setTreasuryAccounts] = useState<TreasuryAccount[]>([]);
  const [treasuryAccountId, setTreasuryAccountId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  preload([
    'nav.payroll_run_detail',
    'field.employee',
    'field.gross_pay',
    'field.total_deductions',
    'field.net_pay',
    'field.commission_amount',
    'field.overtime_amount',
    'field.status',
    'field.actions',
    'field.financial_event_status',
    'field.disbursement_status',
    'field.treasury_account',
    'field.calendar_date',
    'field.day_type',
    'field.pay_impact',
    'action.review_run',
    'action.submit_run',
    'action.disburse_run',
    'action.view_details',
    'panel.no_lines_yet',
    'panel.no_classifications_yet',
    'panel.payroll_three_states_notice',
    'panel.payroll_commission_pending_notice',
    'value.payroll_run_status.draft',
    'value.payroll_run_status.calculated',
    'value.payroll_run_status.reviewed',
    'value.payroll_run_status.approved',
    'value.payroll_run_status.posted',
    'value.financial_event_status.received',
    'value.financial_event_status.mapped',
    'value.financial_event_status.posted',
    'value.financial_event_status.rejected',
    'value.financial_event_status.ignored',
    'value.financial_event_status.none',
    'value.disbursement_status.pending',
    'value.disbursement_status.disbursed',
    'value.day_type.working',
    'value.day_type.weekend',
    'value.day_type.holiday',
    'value.day_type.approved_leave',
    'value.day_type.unclassified',
    'value.pay_impact.none',
    'value.pay_impact.deduction',
    'value.pay_impact.leave',
  ]);

  async function loadRun() {
    if (!id) return;
    try {
      const data = await api.get<{ run: PayrollRun; lines: PayrollRunLine[] }>(`/payroll/runs/${id}`);
      setRun(data.run);
      setLines(data.lines);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load payroll run.');
    }
  }
  async function loadFinancialEvent() {
    if (!id) return;
    try {
      setFinancialEvent(await api.get<FinancialEventStatus | null>(`/payroll/runs/${id}/financial-event-status`));
    } catch {
      setFinancialEvent(null);
    }
  }
  async function loadGaps() {
    try {
      setGaps(await api.get<ReconciliationGap[]>('/payroll/reconciliation-gaps'));
    } catch {
      setGaps([]);
    }
  }
  async function loadEmployees() {
    setEmployees(await api.get<Employee[]>('/hr/employees'));
  }
  async function loadTreasuryAccounts() {
    try {
      setTreasuryAccounts(await api.get<TreasuryAccount[]>('/treasury/accounts'));
    } catch {
      setTreasuryAccounts([]);
    }
  }

  useEffect(() => {
    loadRun();
    loadFinancialEvent();
    loadGaps();
    loadEmployees();
    loadTreasuryAccounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const employeeLabel = (empId: string) => {
    const emp = employees.find((e) => e.id === empId);
    return emp ? `${emp.code} — ${emp.fullName}` : empId.slice(0, 8);
  };

  async function onReview() {
    if (!id) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/payroll/runs/${id}/review`);
      await loadRun();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to review run.');
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit() {
    if (!id) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/payroll/runs/${id}/submit`);
      await loadRun();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to submit run for approval.');
    } finally {
      setBusy(false);
    }
  }

  async function onDisburse() {
    if (!id || !treasuryAccountId) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/payroll/runs/${id}/disburse`, { treasuryAccountId });
      await Promise.all([loadRun(), loadGaps()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to disburse run.');
    } finally {
      setBusy(false);
    }
  }

  async function toggleClassifications(lineId: string) {
    if (expandedLine === lineId) {
      setExpandedLine(null);
      return;
    }
    setExpandedLine(lineId);
    try {
      setClassifications(await api.get<DayClassification[]>(`/payroll/run-lines/${lineId}/day-classifications`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load day classifications.');
    }
  }

  if (!run) return <div className="empty-state">Loading…</div>;

  const financialEventStatusCode = financialEvent ? financialEvent.status.toLowerCase() : 'none';
  const isGap = gaps.some((g) => g.payrollRunId === run.id);
  const canReview = run.status === 'calculated';
  const canSubmit = run.status === 'reviewed';
  const canDisburse = run.status === 'posted' && !run.disbursedAt && financialEvent?.status.toUpperCase() === 'POSTED';

  return (
    <div>
      <div className="page-header">
        <h1>
          {t('nav.payroll_run_detail')} — {run.code}
        </h1>
      </div>

      {error && <div className="error-text">{error}</div>}

      <div className="card" style={{ marginBottom: 20, background: 'var(--panel-info-bg, #eef4ff)' }}>
        <p style={{ margin: 0 }}>{t('panel.payroll_three_states_notice')}</p>
      </div>

      <div className="card" style={{ marginBottom: 20, display: 'flex', gap: 32, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 12, opacity: 0.7 }}>{t('field.status')} (PayrollRun)</div>
          <StatusBadge code={`value.payroll_run_status.${run.status}`} />
        </div>
        <div>
          <div style={{ fontSize: 12, opacity: 0.7 }}>{t('field.financial_event_status')}</div>
          <StatusBadge code={`value.financial_event_status.${financialEventStatusCode}`} />
          {isGap && <div className="error-text" style={{ marginTop: 4 }}>⚠ Reconciliation gap</div>}
          {financialEvent?.rejectionReason && <div style={{ fontSize: 12, opacity: 0.7 }}>{financialEvent.rejectionReason}</div>}
        </div>
        <div>
          <div style={{ fontSize: 12, opacity: 0.7 }}>{t('field.disbursement_status')} (Treasury)</div>
          <StatusBadge code={`value.disbursement_status.${run.disbursedAt ? 'disbursed' : 'pending'}`} />
        </div>
      </div>

      <div className="card" style={{ marginBottom: 20, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        {canReview && (
          <button className="btn btn-primary" disabled={busy} onClick={onReview}>
            {t('action.review_run')}
          </button>
        )}
        {canSubmit && (
          <button className="btn btn-primary" disabled={busy} onClick={onSubmit}>
            {t('action.submit_run')}
          </button>
        )}
        {run.status === 'posted' && !run.disbursedAt && (
          <>
            <div className="form-field" style={{ marginBottom: 0, minWidth: 220 }}>
              <label>{t('field.treasury_account')}</label>
              <select value={treasuryAccountId} onChange={(e) => setTreasuryAccountId(e.target.value)}>
                <option value="">—</option>
                {treasuryAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} — {a.name} ({a.balance})
                  </option>
                ))}
              </select>
            </div>
            <button className="btn btn-primary" disabled={busy || !canDisburse || !treasuryAccountId} onClick={onDisburse} title={!canDisburse ? 'Financial Event must resolve POSTED first' : ''}>
              {t('action.disburse_run')}
            </button>
          </>
        )}
      </div>

      <ApprovalsPanel requestTypeCodes={PAYROLL_REQUEST_TYPE_CODES} decidePath={(reqId) => `/payroll/approvals/${reqId}/decide`} onDecided={() => { loadRun(); loadFinancialEvent(); }} />

      {lines.length === 0 ? (
        <div className="empty-state">{t('panel.no_lines_yet')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.employee')}</th>
              <th>{t('field.gross_pay')}</th>
              <th>{t('field.total_deductions')}</th>
              <th>{t('field.net_pay')}</th>
              <th>{t('field.commission_amount')}</th>
              <th>{t('field.overtime_amount')}</th>
              <th>{t('field.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <Fragment key={l.id}>
                <tr>
                  <td>{employeeLabel(l.employeeId)}</td>
                  <td>{l.grossPay}</td>
                  <td>{l.totalDeductions}</td>
                  <td>{l.netPay}</td>
                  <td title={t('panel.payroll_commission_pending_notice')}>{l.commissionAmount ?? '—'}</td>
                  <td>{l.overtimeAmount ?? '—'}</td>
                  <td>
                    <button className="btn btn-secondary" onClick={() => toggleClassifications(l.id)}>
                      {expandedLine === l.id ? '▲' : '▼'} {t('field.day_type')}
                    </button>
                  </td>
                </tr>
                {expandedLine === l.id && (
                  <tr>
                    <td colSpan={7}>
                      {classifications.length === 0 ? (
                        <div className="empty-state">{t('panel.no_classifications_yet')}</div>
                      ) : (
                        <table className="data-table">
                          <thead>
                            <tr>
                              <th>{t('field.calendar_date')}</th>
                              <th>Attendance Status</th>
                              <th>{t('field.day_type')}</th>
                              <th>{t('field.pay_impact')}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {classifications.map((c) => (
                              <tr key={c.id}>
                                <td>{c.calendarDate}</td>
                                <td>{c.attendanceStatus}</td>
                                <td>
                                  <StatusBadge code={`value.day_type.${c.dayType}`} />
                                </td>
                                <td>
                                  <StatusBadge code={`value.pay_impact.${c.payImpact}`} />
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
