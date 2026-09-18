import { FinancialEvent } from '../../infrastructure/financial-event.entity';
import { HandlerContext, HandlerResult, JournalDraftLine } from './handler-registry';
import { ArAdjustmentKind } from '../../domain/ar';

/**
 * F04 — Accounts Receivable (ADR-036 D2/D5). The GL posting for an
 * **approved** AR adjustment. F04's `ArAdjustmentService` emits an
 * internal `FinancialEvent` (`sourceDomain = 'accounting'`) after FA-01
 * approves; this pure handler maps it to a balanced journal draft that
 * F03's posting gate posts to the `ar` control account (`systemPosting`).
 * Zero change to the F03 ledger core (ADR-035 D6).
 *
 * Payload (from the approved FA-01 request):
 *   { kind, customerId, amount, contraAccountCode?, reason,
 *     writeOffExpenseAccountCode?, openingBalanceAccountCode?, revenueAccountCode? }
 */
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : typeof v === 'number' ? String(v) : null;
}
function amt(v: unknown): string | null {
  const s = str(v);
  return s && /^\d+(\.\d+)?$/.test(s) && Number(s) > 0 ? s : null;
}

export async function handleArAdjustmentApproved(event: FinancialEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const p = event.payload;
  const kind = str(p.kind) as ArAdjustmentKind | null;
  const amount = amt(p.amount);
  if (!kind) return { kind: 'rejected', reason: 'ar adjustment: missing kind' };
  if (!amount) return { kind: 'rejected', reason: 'ar adjustment: missing/invalid amount' };

  const ar = await ctx.resolveControlAccount('ar');
  if (!ar) return { kind: 'rejected', reason: 'ar adjustment: no AR control account in the chart' };

  const description = `AR ${kind.replace('_', ' ')} — ${str(p.reason) ?? event.sourceEntityId}`;
  let lines: JournalDraftLine[];

  switch (kind) {
    case 'write_off': {
      const expenseCode = str(p.writeOffExpenseAccountCode) ?? '5299';
      const expense = await ctx.findAccountByCode(expenseCode);
      if (!expense) return { kind: 'rejected', reason: `ar write_off: expense account "${expenseCode}" not found` };
      lines = [
        { accountId: expense, debit: amount, description: 'Bad debt expense' },
        { accountId: ar, credit: amount, description: 'AR written off' },
      ];
      break;
    }
    case 'opening_balance': {
      const openingCode = str(p.openingBalanceAccountCode) ?? '3103';
      const opening = await ctx.findAccountByCode(openingCode);
      if (!opening) return { kind: 'rejected', reason: `ar opening_balance: account "${openingCode}" not found` };
      lines = [
        { accountId: ar, debit: amount, description: 'AR opening balance' },
        { accountId: opening, credit: amount, description: 'Opening balance equity' },
      ];
      break;
    }
    case 'credit_note': {
      const revCode = str(p.revenueAccountCode) ?? '4110';
      const rev = await ctx.findAccountByCode(revCode);
      if (!rev) return { kind: 'rejected', reason: `ar credit_note: revenue account "${revCode}" not found` };
      lines = [
        { accountId: rev, debit: amount, description: 'Revenue reduction (credit note)' },
        { accountId: ar, credit: amount, description: 'AR reduced' },
      ];
      break;
    }
    case 'debit_note': {
      const revCode = str(p.revenueAccountCode) ?? '4101';
      const rev = await ctx.findAccountByCode(revCode);
      if (!rev) return { kind: 'rejected', reason: `ar debit_note: revenue account "${revCode}" not found` };
      lines = [
        { accountId: ar, debit: amount, description: 'AR increased (debit note)' },
        { accountId: rev, credit: amount, description: 'Revenue (debit note)' },
      ];
      break;
    }
    case 'adjustment':
    default: {
      const contraCode = str(p.contraAccountCode);
      if (!contraCode) return { kind: 'rejected', reason: 'ar adjustment: a contraAccountCode is required' };
      const contra = await ctx.findAccountByCode(contraCode);
      if (!contra) return { kind: 'rejected', reason: `ar adjustment: contra account "${contraCode}" not found` };
      const direction = str(p.direction) === 'debit' ? 'debit' : 'credit'; // direction of the AR movement
      lines =
        direction === 'debit'
          ? [
              { accountId: ar, debit: amount, description: 'AR adjustment (increase)' },
              { accountId: contra, credit: amount, description: 'Contra' },
            ]
          : [
              { accountId: contra, debit: amount, description: 'Contra' },
              { accountId: ar, credit: amount, description: 'AR adjustment (decrease)' },
            ];
      break;
    }
  }

  return {
    kind: 'draft',
    draft: {
      businessDate: event.businessDate,
      description,
      transactionCurrencyCode: event.transactionCurrencyCode,
      orgUnitId: event.orgUnitId,
      lines,
    },
  };
}
