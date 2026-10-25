import Decimal from 'decimal.js';
import { FinancialEvent } from '../../infrastructure/financial-event.entity';
import { HandlerContext, HandlerResult, JournalDraftLine } from './handler-registry';

/**
 * ADR-070 §16 — Payroll's own GL entry point for the ACCRUAL, the only one the run chain produces (`ADR-072 §16`). Pure handler, same shape as every other F03
 * handler — `PayrollService` never imports `JournalEntryService`/`GLAccount`; it only publishes `payroll.run.posted` and this handler maps it to a balanced draft.
 *
 * Payload (from `PayrollService.onApprovalApproved`, ADR-070 Addendum A-8):
 *   { payrollRunId, revision, kind, totalGross, totalCommission, totalAdjustments, totalDeductions, totalExpense, totalNet, employeeCount }
 *
 * Posting shape (working basis, no new account):
 *   Dr Salaries & Wages Expense `5201`   totalExpense  (= gross + approved commission + adjustment inputs — commission is recognised exactly once, here)
 *   Cr Wages Payable (`wages_payable`)   totalNet      (= what the employees are owed; reduced later by `payroll.payout.settled`)
 * `totalExpense` must equal `totalNet + totalDeductions`. No Tax / Social Insurance liability account exists (`ADR-067 §E` ratified the boundary, not the
 * rates), so a run that carries deductions is REJECTED (fail closed, never mis-posted) until that rule and its accounts are ratified.
 * A supplementary run may carry a negative delta: the same two accounts, opposite sides. The business date is the engine default (the approval date) — Accounting
 * has not decided an accrual-date rule yet (owner decision D-3).
 * Events published before the gap-closure release carry only `totalGross`; they are read as expense = net = totalGross (their historical meaning).
 */
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : typeof v === 'number' ? String(v) : null;
}
function signed(v: unknown): Decimal | null {
  const s = str(v);
  if (!s || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  return new Decimal(s);
}

export async function handlePayrollRunPosted(event: FinancialEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const p = event.payload;
  const payrollRunId = str(p.payrollRunId);
  if (!payrollRunId) return { kind: 'rejected', reason: 'payroll run posted: missing payrollRunId' };

  const legacy = p.totalExpense === undefined;
  const expense = legacy ? signed(p.totalGross) : signed(p.totalExpense);
  const net = legacy ? expense : signed(p.totalNet);
  const deductions = legacy ? new Decimal(0) : signed(p.totalDeductions ?? '0');
  if (expense === null || net === null || deductions === null) return { kind: 'rejected', reason: 'payroll run posted: missing/invalid totals' };
  if (expense.isZero() && net.isZero()) return { kind: 'rejected', reason: 'payroll run posted: nothing to post (zero totals)' };
  if (!deductions.isZero()) return { kind: 'rejected', reason: 'payroll run posted: the run carries deductions but no ratified deduction liability account exists (ADR-067 §E)' };
  if (!expense.eq(net.plus(deductions))) return { kind: 'rejected', reason: `payroll run posted: expense ${expense.toFixed(2)} does not equal net ${net.toFixed(2)} + deductions ${deductions.toFixed(2)}` };

  const expenseCode = '5201'; // ifrs-sme.template.ts — Salaries & Wages Expense
  const expenseAccount = await ctx.findAccountByCode(expenseCode);
  if (!expenseAccount) return { kind: 'rejected', reason: `payroll run posted: expense account "${expenseCode}" not found` };

  const wagesPayable = await ctx.resolveControlAccount('wages_payable');
  if (!wagesPayable) {
    return { kind: 'rejected', reason: 'payroll run posted: no Wages Payable control account in the chart (assign controlFunction "wages_payable" to an account)' };
  }

  const amount = expense.abs().toFixed(2);
  const reversing = expense.isNegative();
  const lines: JournalDraftLine[] = reversing
    ? [
        { accountId: wagesPayable, debit: amount, description: `Payroll run ${payrollRunId} — Wages Payable (correction)` },
        { accountId: expenseAccount, credit: amount, description: `Payroll run ${payrollRunId} — Salaries & Wages Expense (correction)` },
      ]
    : [
        { accountId: expenseAccount, debit: amount, description: `Payroll run ${payrollRunId} — Salaries & Wages Expense` },
        { accountId: wagesPayable, credit: amount, description: `Payroll run ${payrollRunId} — Wages Payable` },
      ];

  return {
    kind: 'draft',
    draft: {
      businessDate: event.businessDate,
      description: `Payroll Run ${payrollRunId} posted`,
      transactionCurrencyCode: event.transactionCurrencyCode,
      orgUnitId: event.orgUnitId,
      lines,
    },
  };
}
