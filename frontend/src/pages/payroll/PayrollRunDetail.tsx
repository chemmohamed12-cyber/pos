import { Fragment, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { ErrorText, toUiError, type UiError } from '../../components/ErrorText';
import { useLanguage } from '../../context/LanguageContext';
import { useAuth } from '../../context/AuthContext';
import { StatusBadge } from '../../components/StatusBadge';
import { ApprovalsPanel } from '../../components/ApprovalsPanel';
import { ErrorState } from '../../components/ErrorState';
import { RunActorsPanel, RunExceptionsPanel, RunInputsPanel, RunPayoutsPanel, RunReconciliationPanel } from './PayrollRunPanels';
import { PANEL_TERMS, useMoney } from './payrollUi';

interface Employee {
  id: string;
  code: string;
  fullName: string;
}
interface PayrollRun {
  approvalRequestId?: string | null;
  id: string;
  code: string;
  payrollPeriodId: string;
  status: 'draft' | 'calculated' | 'reviewed' | 'approved' | 'posted' | 'superseded';
  revision: number;
  kind: 'regular' | 'supplementary';
  postedAt: string | null;
  disbursedAt: string | null;
  rejectionReason: string | null;
  rejectedAt: string | null;
  totalGross: string | null;
  totalCommission: string | null;
  totalAdjustments: string | null;
  totalDeductions: string | null;
  totalNet: string | null;
}
interface PayrollRunLine {
  id: string;
  employeeId: string;
  grossPay: string;
  totalDeductions: string;
  netPay: string;
  commissionAmount: string | null;
  adjustmentsAmount: string;
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
interface ReconciliationGap {
  payrollRunId: string;
  code: string;
}

const PAYROLL_REQUEST_TYPE_CODES = ['payroll.run_approval'];

/**
 * ADR-070 — the Run Detail screen. Keeps three separate, differently-sourced status indicators: PayrollRun.status (this run's own record), Financial Event status
 * (a live query into Accounting, never assumed from PayrollRun alone — ADR-070 §6), and disbursement status (Treasury) — never merging them into one.
 * Gap-closure additions (Addendum A-4/A-6/A-7/A-9): revision and kind, the rejection notice, the exception register with documented acknowledgement, the commission /
 * adjustment inputs this run holds, the stage actors, payout batches and the run reconciliation. Every server refusal (separation of duties, open exceptions, stale
 * inputs) is shown with the server's own message.
 */
export function PayrollRunDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t, preload } = useLanguage();
  const { can } = useAuth();
  const money = useMoney();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [run, setRun] = useState<PayrollRun | null>(null);
  const [lines, setLines] = useState<PayrollRunLine[]>([]);
  const [financialEvent, setFinancialEvent] = useState<FinancialEventStatus | null>(null);
  const [gaps, setGaps] = useState<ReconciliationGap[]>([]);
  const [expandedLine, setExpandedLine] = useState<string | null>(null);
  const [classifications, setClassifications] = useState<DayClassification[]>([]);
  const [error, setError] = useState<UiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  preload([
    ...PANEL_TERMS,
    'nav.payroll_run_detail',
    'field.employee',
    'field.gross_pay',
    'field.total_deductions',
    'field.net_pay',
    'field.commission_amount',
    'field.adjustments_amount',
    'field.overtime_amount',
    'field.status',
    'field.actions',
    'field.revision',
    'field.run_kind',
    'field.financial_event_status',
    'field.disbursement_status',
    'field.calendar_date',
    'field.attendance_status',
    'field.day_type',
    'field.pay_impact',
    'action.review_run',
    'action.submit_run',
    'action.recalculate_run',
    'action.calculate_supplementary',
    'action.disburse_run',
    'action.view_details',
    'panel.no_lines_yet',
    'panel.no_classifications_yet',
    'panel.payroll_three_states_notice',
    'panel.payroll_commission_pending_notice',
    'panel.payroll_rejection_notice',
    'panel.payroll_superseded_notice',
    'panel.reconciliation_gap',
    'msg.loading',
    'msg.load_failed',
    'msg.action_failed',
    'value.payroll_run_status.draft',
    'value.payroll_run_status.calculated',
    'value.payroll_run_status.reviewed',
    'value.payroll_run_status.approved',
    'value.payroll_run_status.posted',
    'value.payroll_run_status.superseded',
    'value.payroll_run_kind.regular',
    'value.payroll_run_kind.supplementary',
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
      setError(toUiError(err, t, 'msg.load_failed'));
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
    try {
      setEmployees(await api.get<Employee[]>('/hr/employees'));
    } catch (err) {
      setError(toUiError(err, t, 'msg.load_failed'));
    }
  }

  function reloadAll() {
    loadRun();
    loadFinancialEvent();
    loadGaps();
    setRefreshKey((k) => k + 1);
  }

  useEffect(() => {
    loadEmployees();
    reloadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const employeeText = (empId: string) => {
    const emp = employees.find((e) => e.id === empId);
    return emp ? `${emp.code} — ${emp.fullName}` : empId.slice(0, 8);
  };

  async function act(path: string, body?: unknown, after?: (result: unknown) => void) {
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<unknown>(path, body);
      after?.(result);
      reloadAll();
    } catch (err) {
      setError(toUiError(err, t, 'msg.action_failed'));
      reloadAll();
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
      setError(toUiError(err, t, 'msg.load_failed'));
    }
  }

  if (!run && error) return <ErrorState error={new Error(error.message)} onRetry={reloadAll} />;
  if (!run) return <div className="empty-state">{t('msg.loading')}</div>;

  const financialEventStatusCode = financialEvent ? financialEvent.status.toLowerCase() : 'none';
  const isGap = gaps.some((g) => g.payrollRunId === run.id);
  const editableState = run.status === 'calculated' || run.status === 'reviewed';
  const canReview = run.status === 'calculated';
  const canSubmit = run.status === 'reviewed' && !run.approvalRequestId; // a submitted run stays 'reviewed' until the approval decides it
  const canRecalculate = run.status === 'calculated' || run.status === 'reviewed' || run.status === 'draft';
  const isPosted = run.status === 'posted';
  const ledgerPosted = financialEvent?.status.toUpperCase() === 'POSTED';

  return (
    <div>
      <div className="page-header">
        <h1>
          {t('nav.payroll_run_detail')} — {run.code}
        </h1>
      </div>

      {error && (
        <div className="error-text" role="alert" data-testid="payroll-error">
          <ErrorText error={error} />
        </div>
      )}

      {run.rejectionReason && run.status === 'calculated' && (
        <div className="card" style={{ marginBottom: 20, borderInlineStart: '4px solid var(--danger, #c0392b)' }} data-testid="payroll-rejection-notice">
          <strong>{t('panel.payroll_rejection_notice')}</strong>
          <div>{run.rejectionReason}</div>
        </div>
      )}
      {run.status === 'superseded' && (
        <div className="card" style={{ marginBottom: 20 }}>
          <p style={{ margin: 0 }}>{t('panel.payroll_superseded_notice')}</p>
        </div>
      )}

      <div className="card" style={{ marginBottom: 20, background: 'var(--panel-info-bg, #eef4ff)' }}>
        <p style={{ margin: 0 }}>{t('panel.payroll_three_states_notice')}</p>
      </div>

      <div className="card" style={{ marginBottom: 20, display: 'flex', gap: 32, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 12, opacity: 0.7 }}>{t('field.status')} (PayrollRun)</div>
          <StatusBadge code={`value.payroll_run_status.${run.status}`} />
        </div>
        <div>
          <div style={{ fontSize: 12, opacity: 0.7 }}>{t('field.revision')}</div>
          <strong data-testid="payroll-revision">{run.revision}</strong> <StatusBadge code={`value.payroll_run_kind.${run.kind}`} />
        </div>
        <div>
          <div style={{ fontSize: 12, opacity: 0.7 }}>{t('field.financial_event_status')}</div>
          <StatusBadge code={`value.financial_event_status.${financialEventStatusCode}`} />
          {isGap && <div className="error-text" style={{ marginTop: 4 }}>⚠ {t('panel.reconciliation_gap')}</div>}
          {financialEvent?.rejectionReason && <div style={{ fontSize: 12, opacity: 0.7 }}>{financialEvent.rejectionReason}</div>}
        </div>
        <div>
          <div style={{ fontSize: 12, opacity: 0.7 }}>{t('field.disbursement_status')} (Treasury)</div>
          <StatusBadge code={`value.disbursement_status.${run.disbursedAt ? 'disbursed' : 'pending'}`} />
        </div>
      </div>

      <div className="card" style={{ marginBottom: 20, display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 12, opacity: 0.7 }}>{t('field.gross_pay')}</div>
          <strong>{money(run.totalGross)}</strong>
        </div>
        <div>
          <div style={{ fontSize: 12, opacity: 0.7 }}>{t('field.commission_amount')}</div>
          <strong>{money(run.totalCommission)}</strong>
        </div>
        <div>
          <div style={{ fontSize: 12, opacity: 0.7 }}>{t('field.adjustments_amount')}</div>
          <strong>{money(run.totalAdjustments)}</strong>
        </div>
        <div>
          <div style={{ fontSize: 12, opacity: 0.7 }}>{t('field.total_deductions')}</div>
          <strong>{money(run.totalDeductions)}</strong>
        </div>
        <div>
          <div style={{ fontSize: 12, opacity: 0.7 }}>{t('field.net_pay')}</div>
          <strong data-testid="payroll-total-net">{money(run.totalNet)}</strong>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 20, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        {canRecalculate && can('payroll.run.calculate') && (
          <button
            className="btn btn-secondary"
            disabled={busy}
            onClick={() => act('/payroll/runs/calculate', { payrollPeriodId: run.payrollPeriodId }, (r) => {
              const next = r as PayrollRun;
              if (next.id !== run.id) navigate(`/payroll/runs/${next.id}`);
            })}
          >
            {t('action.recalculate_run')}
          </button>
        )}
        {canReview && can('payroll.run.review') && (
          <button className="btn btn-primary" disabled={busy} onClick={() => act(`/payroll/runs/${id}/review`)}>
            {t('action.review_run')}
          </button>
        )}
        {canSubmit && can('payroll.run.submit') && (
          <button className="btn btn-primary" disabled={busy} onClick={() => act(`/payroll/runs/${id}/submit`)}>
            {t('action.submit_run')}
          </button>
        )}
        {isPosted && can('payroll.run.calculate') && (
          <button
            className="btn btn-secondary"
            disabled={busy}
            onClick={() => act('/payroll/runs/calculate-supplementary', { payrollPeriodId: run.payrollPeriodId }, (r) => navigate(`/payroll/runs/${(r as PayrollRun).id}`))}
          >
            {t('action.calculate_supplementary')}
          </button>
        )}
      </div>

      <RunExceptionsPanel runId={run.id} employees={employees} editable={editableState && can('payroll.exception.acknowledge')} refreshKey={refreshKey} onChanged={reloadAll} />

      <ApprovalsPanel requestTypeCodes={PAYROLL_REQUEST_TYPE_CODES} decidePath={(reqId) => `/payroll/approvals/${reqId}/decide`} onDecided={reloadAll} />

      {lines.length === 0 ? (
        <div className="empty-state">{t('panel.no_lines_yet')}</div>
      ) : (
        <div style={{ overflowX: 'auto', marginBottom: 20 }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('field.employee')}</th>
                <th>{t('field.gross_pay')}</th>
                <th>{t('field.commission_amount')}</th>
                <th>{t('field.adjustments_amount')}</th>
                <th>{t('field.total_deductions')}</th>
                <th>{t('field.net_pay')}</th>
                <th>{t('field.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <Fragment key={l.id}>
                  <tr>
                    <td>{employeeText(l.employeeId)}</td>
                    <td>{money(l.grossPay)}</td>
                    <td title={t('panel.payroll_commission_pending_notice')}>{money(l.commissionAmount)}</td>
                    <td>{money(l.adjustmentsAmount)}</td>
                    <td>{money(l.totalDeductions)}</td>
                    <td>{money(l.netPay)}</td>
                    <td>
                      {run.kind === 'regular' && (
                        <button className="btn btn-secondary" onClick={() => toggleClassifications(l.id)}>
                          {expandedLine === l.id ? '▲' : '▼'} {t('field.day_type')}
                        </button>
                      )}
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
                                <th>{t('field.attendance_status')}</th>
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
        </div>
      )}

      <RunInputsPanel runId={run.id} employees={employees} refreshKey={refreshKey} />

      {isPosted && (
        <>
          <RunPayoutsPanel runId={run.id} employees={employees} canDisburse={ledgerPosted && can('payroll.run.disburse')} refreshKey={refreshKey} onChanged={reloadAll} />
          <RunReconciliationPanel runId={run.id} refreshKey={refreshKey} />
        </>
      )}

      <RunActorsPanel runId={run.id} refreshKey={refreshKey} />
    </div>
  );
}
