import { FinancialEvent } from '../../infrastructure/financial-event.entity';
import { HandlerContext, HandlerResult, JournalDraftLine } from './handler-registry';

/**
 * ADR-070 §16 — Payroll's own GL entry point, the only one this chain
 * ever produces (`ADR-072 §16`). Pure handler, same shape as every other
 * F03 handler in this file — `PayrollService` never imports
 * `JournalEntryService`/`GLAccount` directly; it only publishes
 * `payroll.run.posted` and this handler maps it to a balanced draft.
 *
 * Payload (from `PayrollService.onApprovalApproved`):
 *   { payrollRunId, payrollPeriodId, totalGross, totalNet, employeeCount }
 *
 * Posting shape: Dr Salaries & Wages Expense (the already-templated,
 * dormant `5201` account) / Cr Wages Payable
 * (`resolveControlAccount('wages_payable')`). No Tax/Social Insurance
 * control account exists — `ADR-067 §E` ratified the boundary only, not
 * the rates; `totalGross === totalNet` in this Phase 1 slice since no
 * deduction is ever computed yet (the day-type fail-safe, `ADR-070 §9`,
 * guarantees this).
 */
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : typeof v === 'number' ? String(v) : null;
}
function amt(v: unknown): string | null {
  const s = str(v);
  return s && /^\d+(\.\d+)?$/.test(s) && Number(s) > 0 ? s : null;
}

export async function handlePayrollRunPosted(event: FinancialEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const p = event.payload;
  const payrollRunId = str(p.payrollRunId);
  const totalGross = amt(p.totalGross);
  if (!payrollRunId) return { kind: 'rejected', reason: 'payroll run posted: missing payrollRunId' };
  if (!totalGross) return { kind: 'rejected', reason: 'payroll run posted: missing/invalid totalGross' };

  const expenseCode = '5201'; // ifrs-sme.template.ts — Salaries & Wages Expense, already templated, dormant until this handler
  const expense = await ctx.findAccountByCode(expenseCode);
  if (!expense) return { kind: 'rejected', reason: `payroll run posted: expense account "${expenseCode}" not found` };

  const wagesPayable = await ctx.resolveControlAccount('wages_payable');
  if (!wagesPayable) {
    return { kind: 'rejected', reason: 'payroll run posted: no Wages Payable control account in the chart (assign controlFunction "wages_payable" to an account)' };
  }

  const lines: JournalDraftLine[] = [
    { accountId: expense, debit: totalGross, description: `Payroll run ${payrollRunId} — Salaries & Wages Expense` },
    { accountId: wagesPayable, credit: totalGross, description: `Payroll run ${payrollRunId} — Wages Payable` },
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
