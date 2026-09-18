import { FinancialEvent } from '../../infrastructure/financial-event.entity';
import { HandlerContext, HandlerResult, JournalDraftLine } from './handler-registry';

/**
 * ADR-048 (original) + ADR-054/ADR-057 (GRNI, Option B) — Procurement's
 * Supplier Invoice / AP, the credit-normal mirror of `handleInvoicePosted`
 * (AR). `finance.supplier_invoice.posted` → **Dr GRNI** (control function
 * `grni`, ADR-054 — clears the exposure `handleGoodsReceiptPosted` already
 * credited at receipt time) / Cr AP (control function `ap`, F05 —
 * unchanged, the exact account `ApReconciliationService`/
 * `ApAdjustmentService` already reconcile against).
 *
 * Historically (ADR-048, superseded here) this posted `Dr Inventory`
 * directly, because Goods Receipt had no GL entry of its own — Inventory
 * only entered the GL at invoice time. ADR-054 moves Inventory recognition
 * to receipt time (`handleGoodsReceiptPosted`); this handler's job is now
 * only to clear the GRNI exposure that created, not to touch Inventory a
 * second time.
 */
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : typeof v === 'number' ? String(v) : null;
}
function amt(v: unknown): string | null {
  const s = str(v);
  return s && /^\d+(\.\d+)?$/.test(s) && Number(s) > 0 ? s : null;
}

async function resolveAccount(
  ctx: HandlerContext,
  codeHint: unknown,
  controlFn: Parameters<HandlerContext['resolveControlAccount']>[0],
): Promise<string | null> {
  const code = str(codeHint);
  if (code) {
    const byCode = await ctx.findAccountByCode(code);
    if (byCode) return byCode;
  }
  return ctx.resolveControlAccount(controlFn);
}

/** `finance.supplier_invoice.posted` → Dr GRNI / Cr AP (ADR-054 — clears the GRNI exposure the originating Goods Receipt(s) created). */
export async function handleSupplierInvoicePosted(event: FinancialEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const p = event.payload;
  const net = amt(p.netAmount ?? p.amount);
  if (!net) return { kind: 'rejected', reason: 'supplier_invoice.posted: missing/invalid netAmount' };

  // `expenseAccountCode` is the pre-existing optional code-hint field on `SupplierInvoicePostedEvent`
  // (never actually populated by the real publisher today — always falls through to
  // `resolveControlAccount`) — reused here for the GRNI hint rather than adding a new payload
  // field for an override path nothing currently exercises.
  const grni = await resolveAccount(ctx, p.expenseAccountCode, 'grni');
  const ap = await resolveAccount(ctx, p.apAccountCode, 'ap');
  if (!grni) return { kind: 'rejected', reason: 'supplier_invoice.posted: no GRNI control account in the chart — assign controlFunction "grni" to an account first' };
  if (!ap) return { kind: 'rejected', reason: 'supplier_invoice.posted: no AP control account in the chart' };

  const lines: JournalDraftLine[] = [
    { accountId: grni, debit: net, description: 'Goods Received Not Invoiced (cleared)' },
    { accountId: ap, credit: net, description: 'Accounts payable' },
  ];

  return {
    kind: 'draft',
    draft: {
      businessDate: event.businessDate,
      description: `Supplier invoice ${str(p.invoiceNumber) ?? event.sourceEntityId} posted`,
      transactionCurrencyCode: event.transactionCurrencyCode,
      orgUnitId: event.orgUnitId,
      lines,
    },
  };
}

/** `finance.supplier_invoice.voided` → the mirror of supplier_invoice.posted. */
export async function handleSupplierInvoiceVoided(event: FinancialEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const posted = await handleSupplierInvoicePosted(event, ctx);
  if (posted.kind !== 'draft') return posted;
  return {
    kind: 'draft',
    draft: {
      ...posted.draft,
      description: `Supplier invoice ${str(event.payload.invoiceNumber) ?? event.sourceEntityId} voided`,
      lines: posted.draft.lines.map((l) => ({
        accountId: l.accountId,
        debit: l.credit,
        credit: l.debit,
        description: l.description,
      })),
    },
  };
}

/** `finance.supplier_payment.recorded` → Dr AP / Cr Bank. */
export async function handleSupplierPaymentRecorded(event: FinancialEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const p = event.payload;
  const amount = amt(p.amount);
  if (!amount) return { kind: 'rejected', reason: 'supplier_payment.recorded: missing/invalid amount' };
  const ap = await resolveAccount(ctx, p.apAccountCode, 'ap');
  const bank = await resolveAccount(ctx, p.bankAccountCode ?? p.accountCode, 'bank');
  if (!ap) return { kind: 'rejected', reason: 'supplier_payment.recorded: no AP control account in the chart' };
  if (!bank) return { kind: 'rejected', reason: 'supplier_payment.recorded: no bank/cash control account resolvable' };
  return {
    kind: 'draft',
    draft: {
      businessDate: event.businessDate,
      description: `Supplier payment ${str(p.paymentNumber) ?? event.sourceEntityId} paid`,
      transactionCurrencyCode: event.transactionCurrencyCode,
      orgUnitId: event.orgUnitId,
      lines: [
        { accountId: ap, debit: amount, description: 'Accounts payable' },
        { accountId: bank, credit: amount, description: 'Cash / bank' },
      ],
    },
  };
}
