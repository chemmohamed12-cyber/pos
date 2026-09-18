import { FinancialEvent } from '../../infrastructure/financial-event.entity';
import { HandlerContext, HandlerResult, JournalDraftLine } from './handler-registry';
import { ApAdjustmentKind } from '../../domain/ap';

/**
 * F05 — Accounts Payable (ADR-037 D2/D5/D6). The credit-normal mirror of
 * `ar-adjustment.handler.ts`. F05's `ApAdjustmentService` emits an
 * internal `FinancialEvent` (`sourceDomain = 'accounting'`,
 * `eventType = 'accounting.ap.adjustment.approved'`) after FA-01 approves;
 * this **pure** handler maps it to a balanced 2-line journal draft that
 * F03's posting gate posts to the `ap` control account (`systemPosting`).
 * **Zero change to `journal-entry.service.ts`, the posting gate, or
 * `LedgerService`** (ADR-035 D6).
 *
 * Payload (from the approved FA-01 request):
 *   { kind, supplierRef?, amount, contraAccountCode?, direction?, reason,
 *     apAccountCode?, writeOffIncomeAccountCode?, openingBalanceAccountCode?,
 *     expenseAccountCode? }
 */
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : typeof v === 'number' ? String(v) : null;
}
function amt(v: unknown): string | null {
  const s = str(v);
  return s && /^\d+(\.\d+)?$/.test(s) && Number(s) > 0 ? s : null;
}

export async function handleApAdjustmentApproved(event: FinancialEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const p = event.payload;
  const kind = str(p.kind) as ApAdjustmentKind | null;
  const amount = amt(p.amount);
  if (!kind) return { kind: 'rejected', reason: 'ap adjustment: missing kind' };
  if (!amount) return { kind: 'rejected', reason: 'ap adjustment: missing/invalid amount' };

  // ADR-037 §2 / F05 directive §4 — if the payload names an account, use it exactly; never guess.
  const apCode = str(p.apAccountCode);
  const ap = apCode ? await ctx.findAccountByCode(apCode) : await ctx.resolveControlAccount('ap');
  if (!ap) {
    return {
      kind: 'rejected',
      reason: apCode
        ? `ap adjustment: AP account "${apCode}" not found`
        : 'ap adjustment: no AP control account in the chart (assign controlFunction "ap" to an account, or pass apAccountCode)',
    };
  }

  const description = `AP ${kind.replace('_', ' ')} — ${str(p.reason) ?? event.sourceEntityId}`;
  let lines: JournalDraftLine[];

  switch (kind) {
    case 'write_off': {
      // A payable we will not pay → AP down, income up. Not labelled "profit" in the engine —
      // it is the accounting treatment of cancelling a liability (ADR-037 D6).
      const incomeCode = str(p.writeOffIncomeAccountCode) ?? '4900';
      const income = await ctx.findAccountByCode(incomeCode);
      if (!income) return { kind: 'rejected', reason: `ap write_off: income account "${incomeCode}" not found` };
      lines = [
        { accountId: ap, debit: amount, description: 'AP written off (liability cancelled)' },
        { accountId: income, credit: amount, description: 'Income from cancelled payable' },
      ];
      break;
    }
    case 'opening_balance': {
      const openingCode = str(p.openingBalanceAccountCode) ?? '3103';
      const opening = await ctx.findAccountByCode(openingCode);
      if (!opening) return { kind: 'rejected', reason: `ap opening_balance: account "${openingCode}" not found` };
      lines = [
        { accountId: opening, debit: amount, description: 'Opening balance equity' },
        { accountId: ap, credit: amount, description: 'AP opening balance' },
      ];
      break;
    }
    case 'credit_note': {
      // Supplier credit note → reduces what we owe → AP down, expense down.
      const expCode = str(p.expenseAccountCode) ?? '5299';
      const exp = await ctx.findAccountByCode(expCode);
      if (!exp) return { kind: 'rejected', reason: `ap credit_note: expense account "${expCode}" not found` };
      lines = [
        { accountId: ap, debit: amount, description: 'AP reduced (supplier credit note)' },
        { accountId: exp, credit: amount, description: 'Expense reduction (supplier credit note)' },
      ];
      break;
    }
    case 'debit_note': {
      // A debit note we raise against a supplier → reduces AP, expense down.
      const expCode = str(p.expenseAccountCode) ?? '5299';
      const exp = await ctx.findAccountByCode(expCode);
      if (!exp) return { kind: 'rejected', reason: `ap debit_note: expense account "${expCode}" not found` };
      lines = [
        { accountId: ap, debit: amount, description: 'AP reduced (debit note to supplier)' },
        { accountId: exp, credit: amount, description: 'Expense reduction (debit note to supplier)' },
      ];
      break;
    }
    case 'adjustment':
    default: {
      const contraCode = str(p.contraAccountCode);
      if (!contraCode) return { kind: 'rejected', reason: 'ap adjustment: a contraAccountCode is required' };
      const contra = await ctx.findAccountByCode(contraCode);
      if (!contra) return { kind: 'rejected', reason: `ap adjustment: contra account "${contraCode}" not found` };
      const direction = str(p.direction) === 'credit' ? 'credit' : 'debit'; // direction of the AP-position movement
      lines =
        direction === 'credit'
          ? [
              { accountId: contra, debit: amount, description: 'Contra' },
              { accountId: ap, credit: amount, description: 'AP adjustment (increase)' },
            ]
          : [
              { accountId: ap, debit: amount, description: 'AP adjustment (decrease)' },
              { accountId: contra, credit: amount, description: 'Contra' },
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
