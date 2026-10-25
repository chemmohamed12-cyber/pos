import { useLanguage } from '../../context/LanguageContext';

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

