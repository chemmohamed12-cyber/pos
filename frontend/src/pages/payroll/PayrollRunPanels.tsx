import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { StatusBadge } from '../../components/StatusBadge';

/** Display-only money formatting (the server owns every amount; these are exact 2-decimal strings). */
export function useMoney() {
  const { lang } = useLanguage();
  return (v: string | number | null | undefined) => {
    if (v === null || v === undefined || v === '') return '—';
    const n = Number(v);
    return Number.isFinite(n) ? n.toLocaleString(lang === 'ar' ? 'ar-EG' : 'en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(v);
  };
}

export const PANEL_TERMS = [
  'panel.payroll_exceptions',
  'panel.payroll_no_exceptions',
  'panel.payroll_exceptions_hint',
  'panel.payroll_inputs',
  'panel.payroll_no_inputs',
  'panel.payroll_actors',
  'panel.payroll_payouts',
  'panel.payroll_no_payouts',
  'panel.payroll_payouts_hint',
  'panel.payroll_reconciliation',
  'field.exception_code',
  'field.exception_class',
  'field.decision_reference',
  'field.employee',
  'field.status',
  'field.amount',
  'field.input_kind',
  'field.carried_forward',
  'field.stage',
  'field.performed_by',
  'field.at',
  'field.failure_reason',
  'field.payout_batch',
  'field.treasury_account',
  'field.payment_method',
  'field.outstanding',
  'field.paid',
  'field.pending',
  'field.failed',
  'field.net_pay',
  'field.total_expense',
  'field.ledger_payable',
  'field.treasury_cash_out',
  'action.acknowledge_exceptions',
  'action.create_payout_batch',
  'action.execute_payout_batch',
  'action.cancel_payout_batch',
  'action.refresh',
  'msg.consistent',
  'msg.inconsistent',
  'value.exception_class.B_APPROVE',
  'value.exception_class.A_DOC',
  'value.exception_class.INFO',
  'value.exception_status.open',
  'value.exception_status.acknowledged',
  'value.exception_status.resolved',
  'value.payout_status.pending',
  'value.payout_status.paid',
  'value.payout_status.failed',
  'value.payout_batch_status.draft',
  'value.payout_batch_status.executing',
  'value.payout_batch_status.completed',
  'value.payout_batch_status.partially_completed',
  'value.payout_batch_status.failed',
  'value.payout_batch_status.cancelled',
  'value.input_kind.commission_result',
  'value.input_kind.commission_adjustment',
  'value.input_kind.payroll_adjustment',
  'value.input_state.reserved',
  'value.input_state.consumed',
  'value.input_state.released',
  'value.stage.prepare',
  'value.stage.review',
  'value.stage.acknowledge_exception',
  'value.stage.submit',
  'value.stage.approve',
  'value.stage.disburse',
  'value.stage.reconcile',
  'value.stage.close_period',
];

export interface EmployeeRef {
  id: string;
  code: string;
  fullName: string;
}

export const employeeLabel = (employees: EmployeeRef[], id: string | null) => {
  if (!id) return '—';
  const e = employees.find((x) => x.id === id);
  return e ? `${e.code} — ${e.fullName}` : id.slice(0, 8);
};

interface PayrollException {
  id: string;
  employeeId: string | null;
  code: string;
  impactClass: 'B_APPROVE' | 'A_DOC' | 'INFO';
  status: 'open' | 'acknowledged' | 'resolved';
  decisionRef: string | null;
  detail: Record<string, unknown>;
}

/** Addendum A-9/A-10 — the exception register. A_DOC rows are acknowledged with a decision reference; B_APPROVE rows can only be fixed at the source and recalculated. */
export function RunExceptionsPanel({ runId, employees, editable, refreshKey, onChanged }: { runId: string; employees: EmployeeRef[]; editable: boolean; refreshKey: number; onChanged: () => void }) {
  const { t, preload } = useLanguage();
  const [rows, setRows] = useState<PayrollException[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [decisionRef, setDecisionRef] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  preload([...PANEL_TERMS, ...(rows ?? []).map((r) => `value.payroll_exception.${r.code}`)]);

  async function load() {
    try {
      setRows(await api.get<PayrollException[]>(`/payroll/runs/${runId}/exceptions`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('msg.load_failed'));
    }
  }
  useEffect(() => {
    load();
    setSelected(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, refreshKey]);

  const ackable = (rows ?? []).filter((r) => r.impactClass === 'A_DOC' && r.status === 'open');
  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  async function onAcknowledge() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/payroll/runs/${runId}/exceptions/acknowledge`, { exceptionIds: [...selected], decisionRef });
      setDecisionRef('');
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('msg.action_failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginBottom: 20 }} data-testid="payroll-exceptions-panel">
      <h3>{t('panel.payroll_exceptions')}</h3>
      <p style={{ opacity: 0.75, marginTop: 0 }}>{t('panel.payroll_exceptions_hint')}</p>
      {error && <div className="error-text">{error}</div>}
      {rows === null ? (
        <div className="empty-state">…</div>
      ) : rows.length === 0 ? (
        <div className="empty-state">{t('panel.payroll_no_exceptions')}</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                {editable && <th />}
                <th>{t('field.employee')}</th>
                <th>{t('field.exception_code')}</th>
                <th>{t('field.exception_class')}</th>
                <th>{t('field.status')}</th>
                <th>{t('field.decision_reference')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  {editable && (
                    <td>
                      {r.impactClass === 'A_DOC' && r.status === 'open' && (
                        <input type="checkbox" aria-label={r.code} checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                      )}
                    </td>
                  )}
                  <td>{r.employeeId ? employeeLabel(employees, r.employeeId) : '—'}</td>
                  <td>{t(`value.payroll_exception.${r.code}`)}</td>
                  <td>
                    <StatusBadge code={`value.exception_class.${r.impactClass}`} />
                  </td>
                  <td>
                    <StatusBadge code={`value.exception_status.${r.status}`} />
                  </td>
                  <td>{r.decisionRef ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editable && ackable.length > 0 && (
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: 12 }}>
          <button type="button" className="btn btn-secondary" onClick={() => setSelected(new Set(ackable.map((a) => a.id)))}>
            {ackable.length}
          </button>
          <div className="form-field" style={{ marginBottom: 0, minWidth: 260 }}>
            <label>{t('field.decision_reference')}</label>
            <input value={decisionRef} onChange={(e) => setDecisionRef(e.target.value)} maxLength={500} />
          </div>
          <button type="button" className="btn btn-primary" disabled={busy || selected.size === 0 || decisionRef.trim().length < 3} onClick={onAcknowledge}>
            {t('action.acknowledge_exceptions')}
          </button>
        </div>
      )}
    </div>
  );
}

interface InputConsumption {
  id: string;
  inputKind: string;
  sourceId: string;
  employeeId: string;
  amount: string;
  state: string;
  carriedForward: boolean;
  attributionDate: string | null;
}

export function RunInputsPanel({ runId, employees, refreshKey }: { runId: string; employees: EmployeeRef[]; refreshKey: number }) {
  const { t, preload } = useLanguage();
  const money = useMoney();
  const [rows, setRows] = useState<InputConsumption[] | null>(null);
  preload(PANEL_TERMS);
  useEffect(() => {
    api.get<InputConsumption[]>(`/payroll/runs/${runId}/inputs`).then(setRows).catch(() => setRows([]));
  }, [runId, refreshKey]);
  return (
    <div className="card" style={{ marginBottom: 20 }} data-testid="payroll-inputs-panel">
      <h3>{t('panel.payroll_inputs')}</h3>
      {rows === null ? (
        <div className="empty-state">…</div>
      ) : rows.length === 0 ? (
        <div className="empty-state">{t('panel.payroll_no_inputs')}</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('field.employee')}</th>
                <th>{t('field.input_kind')}</th>
                <th>{t('field.amount')}</th>
                <th>{t('field.status')}</th>
                <th>{t('field.carried_forward')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{employeeLabel(employees, r.employeeId)}</td>
                  <td>{t(`value.input_kind.${r.inputKind}`)}</td>
                  <td>{money(r.amount)}</td>
                  <td>{t(`value.input_state.${r.state}`)}</td>
                  <td>{r.carriedForward ? '✓' : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

interface StageActor {
  id: string;
  stage: string;
  userId: string;
  at: string;
}

export function RunActorsPanel({ runId, refreshKey }: { runId: string; refreshKey: number }) {
  const { t, preload, lang } = useLanguage();
  const [rows, setRows] = useState<StageActor[]>([]);
  preload(PANEL_TERMS);
  useEffect(() => {
    api.get<StageActor[]>(`/payroll/runs/${runId}/actors`).then(setRows).catch(() => setRows([]));
  }, [runId, refreshKey]);
  if (rows.length === 0) return null;
  return (
    <div className="card" style={{ marginBottom: 20 }} data-testid="payroll-actors-panel">
      <h3>{t('panel.payroll_actors')}</h3>
      <div style={{ overflowX: 'auto' }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.stage')}</th>
              <th>{t('field.performed_by')}</th>
              <th>{t('field.at')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{t(`value.stage.${r.stage}`)}</td>
                <td title={r.userId}>{r.userId.slice(0, 8)}</td>
                <td>{new Date(r.at).toLocaleString(lang === 'ar' ? 'ar-EG' : 'en-US')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface PayoutItem {
  id: string;
  employeeId: string;
  amount: string;
  seq: number;
  status: 'pending' | 'paid' | 'failed';
  failureReason: string | null;
}
interface PayoutBatch {
  id: string;
  code: string;
  status: string;
  treasuryAccountId: string;
  items: PayoutItem[];
}
interface TreasuryAccountRow {
  id: string;
  code: string;
  name: string;
  balance: string;
}

/** Addendum A-7 — payments are batches of items; a failed item stays as history, re-issuing it is a new item. Completion is never inferred from "cash moved" alone: see the reconciliation panel. */
export function RunPayoutsPanel({ runId, employees, canDisburse, refreshKey, onChanged }: { runId: string; employees: EmployeeRef[]; canDisburse: boolean; refreshKey: number; onChanged: () => void }) {
  const { t, preload } = useLanguage();
  const money = useMoney();
  const [batches, setBatches] = useState<PayoutBatch[] | null>(null);
  const [accounts, setAccounts] = useState<TreasuryAccountRow[]>([]);
  const [accountId, setAccountId] = useState('');
  const [method, setMethod] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  preload(PANEL_TERMS);

  async function load() {
    try {
      setBatches(await api.get<PayoutBatch[]>(`/payroll/runs/${runId}/payouts`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('msg.load_failed'));
    }
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, refreshKey]);
  useEffect(() => {
    api.get<TreasuryAccountRow[]>('/treasury/accounts').then(setAccounts).catch(() => setAccounts([]));
  }, []);

  async function call(path: string, body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      await api.post(path, body);
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('msg.action_failed'));
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginBottom: 20 }} data-testid="payroll-payouts-panel">
      <h3>{t('panel.payroll_payouts')}</h3>
      <p style={{ opacity: 0.75, marginTop: 0 }}>{t('panel.payroll_payouts_hint')}</p>
      {error && <div className="error-text">{error}</div>}
      {canDisburse && (
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 12 }}>
          <div className="form-field" style={{ marginBottom: 0, minWidth: 240 }}>
            <label>{t('field.treasury_account')}</label>
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">—</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} — {a.name} ({money(a.balance)})
                </option>
              ))}
            </select>
          </div>
          <div className="form-field" style={{ marginBottom: 0, minWidth: 160 }}>
            <label>{t('field.payment_method')}</label>
            <input value={method} onChange={(e) => setMethod(e.target.value)} maxLength={24} />
          </div>
          <button type="button" className="btn btn-primary" disabled={busy || !accountId} onClick={() => call(`/payroll/runs/${runId}/payouts`, { treasuryAccountId: accountId, method: method || undefined })}>
            {t('action.create_payout_batch')}
          </button>
        </div>
      )}
      {batches === null ? (
        <div className="empty-state">…</div>
      ) : batches.length === 0 ? (
        <div className="empty-state">{t('panel.payroll_no_payouts')}</div>
      ) : (
        batches.map((b) => (
          <div key={b.id} style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
              <strong>
                {t('field.payout_batch')} {b.code}
              </strong>
              <StatusBadge code={`value.payout_batch_status.${b.status}`} />
              {canDisburse && b.items.some((i) => i.status === 'pending') && (
                <button type="button" className="btn btn-primary" disabled={busy} onClick={() => call(`/payroll/payouts/${b.id}/execute`)}>
                  {t('action.execute_payout_batch')}
                </button>
              )}
              {canDisburse && b.status === 'draft' && (
                <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => call(`/payroll/payouts/${b.id}/cancel`)}>
                  {t('action.cancel_payout_batch')}
                </button>
              )}
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t('field.employee')}</th>
                    <th>{t('field.amount')}</th>
                    <th>{t('field.status')}</th>
                    <th>{t('field.failure_reason')}</th>
                  </tr>
                </thead>
                <tbody>
                  {b.items.map((i) => (
                    <tr key={i.id}>
                      <td>{employeeLabel(employees, i.employeeId)}</td>
                      <td>{money(i.amount)}</td>
                      <td>
                        <StatusBadge code={`value.payout_status.${i.status}`} />
                      </td>
                      <td>{i.failureReason ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

interface Reconciliation {
  consistent: boolean;
  outstanding: string;
  payroll: { totalNet: string; totalExpense: string };
  ledger: { eventStatus: string | null; expenseDebit: string; payableCredit: string };
  payouts: { paid: string; pending: string; failed: string };
  payoutLedger: { payableDebit: string };
  treasury: { cashOut: string };
  differences: Array<{ code: string; message: string; expected: string; actual: string }>;
}

/** Lines = journal = payouts = Treasury, per run. A difference is shown, never repaired here. */
export function RunReconciliationPanel({ runId, refreshKey }: { runId: string; refreshKey: number }) {
  const { t, preload } = useLanguage();
  const money = useMoney();
  const [rec, setRec] = useState<Reconciliation | null>(null);
  const [error, setError] = useState<string | null>(null);
  preload(PANEL_TERMS);
  async function load() {
    setError(null);
    try {
      setRec(await api.get<Reconciliation>(`/payroll/runs/${runId}/reconciliation`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('msg.load_failed'));
    }
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, refreshKey]);
  return (
    <div className="card" style={{ marginBottom: 20 }} data-testid="payroll-reconciliation-panel">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>{t('panel.payroll_reconciliation')}</h3>
        <button type="button" className="btn btn-secondary" onClick={load}>
          {t('action.refresh')}
        </button>
      </div>
      {error && <div className="error-text">{error}</div>}
      {rec && (
        <>
          <div style={{ margin: '8px 0' }}>
            <span className={`status-badge ${rec.consistent ? 'positive' : 'negative'}`}>{t(rec.consistent ? 'msg.consistent' : 'msg.inconsistent')}</span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <tbody>
                <tr>
                  <td>{t('field.net_pay')}</td>
                  <td>{money(rec.payroll.totalNet)}</td>
                </tr>
                <tr>
                  <td>{t('field.total_expense')}</td>
                  <td>
                    {money(rec.payroll.totalExpense)} / {money(rec.ledger.expenseDebit)}
                  </td>
                </tr>
                <tr>
                  <td>{t('field.ledger_payable')}</td>
                  <td>
                    {money(rec.ledger.payableCredit)} − {money(rec.payoutLedger.payableDebit)}
                  </td>
                </tr>
                <tr>
                  <td>{t('field.paid')}</td>
                  <td>{money(rec.payouts.paid)}</td>
                </tr>
                <tr>
                  <td>{t('field.treasury_cash_out')}</td>
                  <td>{money(rec.treasury.cashOut)}</td>
                </tr>
                <tr>
                  <td>{t('field.pending')} / {t('field.failed')}</td>
                  <td>
                    {money(rec.payouts.pending)} / {money(rec.payouts.failed)}
                  </td>
                </tr>
                <tr>
                  <td>
                    <strong>{t('field.outstanding')}</strong>
                  </td>
                  <td>
                    <strong>{money(rec.outstanding)}</strong>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          {rec.differences.length > 0 && (
            <ul className="error-text" style={{ marginTop: 8 }}>
              {rec.differences.map((d) => (
                <li key={d.code}>
                  {d.message} ({d.expected} ≠ {d.actual})
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
