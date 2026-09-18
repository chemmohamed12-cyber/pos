import { FinancialEvent } from '../../infrastructure/financial-event.entity';
import { HandlerContext, HandlerResult, JournalDraftLine } from './handler-registry';
import { CashBankAdjustmentKind } from '../../domain/cash-bank';

/**
 * F06 — Cash & Bank (ADR-038 D3/D5). The mirror of `ap-adjustment.handler.ts`.
 * F06's `CashBankAdjustmentService` emits an internal `FinancialEvent`
 * (`sourceDomain = 'accounting'`, `eventType =
 * 'accounting.cash.adjustment.approved'`) after FA-01 approves (or
 * straight-through for an under-threshold `bank_adjustment` /
 * `reclassification`); this **pure** handler maps it to a balanced 2-line
 * journal draft that F03's posting gate posts.
 *
 * **Zero change to `journal-entry.service.ts`, the posting gate, or
 * `LedgerService`.** **No hard-coded account codes** — every non-`bank`
 * account is a payload-supplied code the service already resolved and
 * validated; the handler only looks it up and rejects on a miss.
 *
 * Payload (from the approved FA-01 request / straight-through path):
 *   { kind, amount, reason, direction, glAccountCode?, counterAccountCode?,
 *     contraAccountCode?, openingBalanceAccountCode?, clearingAccountCode? }
 */
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : typeof v === 'number' ? String(v) : null;
}
function amt(v: unknown): string | null {
  const s = str(v);
  return s && /^\d+(\.\d+)?$/.test(s) && Number(s) > 0 ? s : null;
}

export async function handleCashBankAdjustmentApproved(event: FinancialEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const p = event.payload;
  const kind = str(p.kind) as CashBankAdjustmentKind | null;
  const amount = amt(p.amount);
  if (!kind) return { kind: 'rejected', reason: 'cash adjustment: missing kind' };
  if (!amount) return { kind: 'rejected', reason: 'cash adjustment: missing/invalid amount' };

  const direction = str(p.direction) === 'credit' ? 'credit' : 'debit';
  const description = `Cash/Bank ${kind.replace(/_/g, ' ')} — ${str(p.reason) ?? event.sourceEntityId}`;

  // resolve the `bank` GL account (payload code exact, else the control account)
  async function bankAccount(): Promise<string | null> {
    const code = str(p.glAccountCode);
    return code ? ctx.findAccountByCode(code) : ctx.resolveControlAccount('bank');
  }

  let lines: JournalDraftLine[];

  switch (kind) {
    case 'reclassification': {
      // no bank leg — move a clearing-account balance to its real account
      const clearingCode = str(p.clearingAccountCode);
      const contraCode = str(p.contraAccountCode);
      if (!clearingCode) return { kind: 'rejected', reason: 'cash reclassification: a clearingAccountCode is required' };
      if (!contraCode) return { kind: 'rejected', reason: 'cash reclassification: a contraAccountCode is required' };
      const clearing = await ctx.findAccountByCode(clearingCode);
      const contra = await ctx.findAccountByCode(contraCode);
      if (!clearing) return { kind: 'rejected', reason: `cash reclassification: clearing account "${clearingCode}" not found` };
      if (!contra) return { kind: 'rejected', reason: `cash reclassification: contra account "${contraCode}" not found` };
      lines =
        direction === 'debit'
          ? [
              { accountId: clearing, debit: amount, description: 'Clearing account' },
              { accountId: contra, credit: amount, description: 'Reclassified to' },
            ]
          : [
              { accountId: contra, debit: amount, description: 'Reclassified to' },
              { accountId: clearing, credit: amount, description: 'Clearing account' },
            ];
      break;
    }
    case 'opening_balance': {
      const bank = await bankAccount();
      const openingCode = str(p.openingBalanceAccountCode);
      if (!bank) return { kind: 'rejected', reason: 'cash opening_balance: no bank control account in the chart (assign controlFunction "bank" or pass glAccountCode)' };
      if (!openingCode) return { kind: 'rejected', reason: 'cash opening_balance: an openingBalanceAccountCode is required' };
      const opening = await ctx.findAccountByCode(openingCode);
      if (!opening) return { kind: 'rejected', reason: `cash opening_balance: account "${openingCode}" not found` };
      lines =
        direction === 'debit'
          ? [
              { accountId: bank, debit: amount, description: 'Opening bank balance' },
              { accountId: opening, credit: amount, description: 'Opening balance equity' },
            ]
          : [
              { accountId: opening, debit: amount, description: 'Opening balance equity' },
              { accountId: bank, credit: amount, description: 'Opening bank balance (credit)' },
            ];
      break;
    }
    case 'bank_adjustment':
    case 'unreconciled_write_off':
    default: {
      const bank = await bankAccount();
      const counterCode = str(p.counterAccountCode);
      if (!bank) return { kind: 'rejected', reason: `cash ${kind}: no bank control account in the chart (assign controlFunction "bank" or pass glAccountCode)` };
      if (!counterCode) return { kind: 'rejected', reason: `cash ${kind}: a counterAccountCode is required` };
      const counter = await ctx.findAccountByCode(counterCode);
      if (!counter) return { kind: 'rejected', reason: `cash ${kind}: counter account "${counterCode}" not found` };
      // direction = the BANK account's movement
      lines =
        direction === 'debit'
          ? [
              { accountId: bank, debit: amount, description: 'Bank' },
              { accountId: counter, credit: amount, description: 'Counter' },
            ]
          : [
              { accountId: counter, debit: amount, description: 'Counter' },
              { accountId: bank, credit: amount, description: 'Bank' },
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
