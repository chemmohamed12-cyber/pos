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

export const PPV_ACCOUNT_CONFIG_KEY = 'accounting.purchase_price_variance_account_code';

/**
 * `finance.supplier_invoice.posted`.
 *
 * **D5 shape** (payload carries `receiptValueBase`): clears GRNI for EXACTLY what the receipts credited, sends the net price
 * difference to the CONFIGURED PPV account, posts the explicit VAT to Input VAT (the single `tax_receivable` control account) and
 * credits AP with the GROSS:
 *   Dr GRNI (receipt value) · Dr PPV (invoice higher) | Cr PPV (invoice lower) · Dr Input VAT (tax) / Cr AP (net + tax).
 * **Legacy shape** (pre-D5 payload, no `receiptValueBase`): Dr GRNI / Cr AP both at the invoice net — kept so a posted legacy
 * invoice voids symmetrically. Nothing is defaulted: PPV account unset ⇒ rejected; Input VAT not exactly one account ⇒ rejected.
 */
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
  if (!grni) return { kind: 'rejected', reason: 'supplier_invoice.posted: no active postable GRNI control account in this Company chart - run Chart of accounts > Complete control accounts (or mark an account with the control function "grni"), then re-drive this event' };
  if (!ap) return { kind: 'rejected', reason: 'supplier_invoice.posted: no AP control account in the chart' };

  let lines: JournalDraftLine[] = [
    { accountId: grni, debit: net, description: 'Goods Received Not Invoiced (cleared)' },
    { accountId: ap, credit: net, description: 'Accounts payable' },
  ];

  const receiptRaw = str(p.receiptValueBase);
  if (receiptRaw !== null) {
    const receipt = Number(receiptRaw);
    const ppv = Number(str(p.ppvBase) ?? 0);
    const tax = Number(str(p.taxAmount) ?? 0);
    if (![receipt, ppv, tax].every(Number.isFinite) || receipt < 0 || tax < 0) {
      return { kind: 'rejected', reason: 'supplier_invoice.posted: invalid receiptValueBase / ppvBase / taxAmount' };
    }
    const gross = Number(net) + tax;
    lines = [];
    if (receipt > 0) lines.push({ accountId: grni, debit: receipt.toFixed(4), description: 'Goods Received Not Invoiced (cleared at receipt value)' });
    if (ppv !== 0) {
      const ppvAcc = await ctx.resolveConfiguredPostableAccount(PPV_ACCOUNT_CONFIG_KEY);
      if (!ppvAcc.ok) {
        return { kind: 'rejected', reason: `supplier_invoice.posted: PPV account is ${ppvAcc.reason} — set ${PPV_ACCOUNT_CONFIG_KEY} to a postable non-control GL account` };
      }
      lines.push(
        ppv > 0
          ? { accountId: ppvAcc.id, debit: ppv.toFixed(4), description: 'Purchase price variance (invoice above receipt value)' }
          : { accountId: ppvAcc.id, credit: Math.abs(ppv).toFixed(4), description: 'Purchase price variance (invoice below receipt value)' },
      );
    }
    if (tax > 0) {
      const vat = await ctx.resolveUniqueControlAccount('tax_receivable');
      if (!vat.ok) {
        return { kind: 'rejected', reason: `supplier_invoice.posted: Input VAT account (tax_receivable) is ${vat.reason} — exactly one active postable account must carry it` };
      }
      lines.push({ accountId: vat.id, debit: tax.toFixed(4), description: 'Input VAT' });
    }
    lines.push({ accountId: ap, credit: gross.toFixed(4), description: 'Accounts payable (gross)' });
    const dr = lines.reduce((s, l) => s + Number(l.debit ?? 0), 0);
    const cr = lines.reduce((s, l) => s + Number(l.credit ?? 0), 0);
    if (Math.abs(dr - cr) > 0.00005) {
      return { kind: 'rejected', reason: `supplier_invoice.posted: unbalanced draft (Dr ${dr.toFixed(4)} ≠ Cr ${cr.toFixed(4)}) — receiptValueBase + ppvBase must equal netAmount` };
    }
  }

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

/**
 * `finance.supplier_invoice.voided` → the exact mirror of what was POSTED. D5: the mirror is built from the ORIGINAL posted event's
 * payload (so a legacy-shape invoice voids with the legacy journal and a D5 invoice reverses GRNI, PPV, Input VAT and AP
 * from the same stored figures); only when no original exists does it fall back to the void event's own payload.
 */
export async function handleSupplierInvoiceVoided(event: FinancialEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const originals: Array<{ payload: Record<string, unknown> }> = await ctx.manager.query(
    `SELECT "payload" FROM "accounting_financial_events"
      WHERE "eventType" = 'finance.supplier_invoice.posted' AND "sourceEntityId" = $1 AND "status" = 'POSTED'
      ORDER BY "receivedAt" DESC LIMIT 1`,
    [event.sourceEntityId],
  );
  const source: FinancialEvent = originals.length > 0 ? Object.assign(Object.create(Object.getPrototypeOf(event)), event, { payload: originals[0].payload }) : event;
  const posted = await handleSupplierInvoicePosted(source, ctx);
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
  // D2 (2026-10-04): the bank leg is the paying Treasury account's OWN mapped GL account (publisher-resolved
  // `glAccountCode`), by code only — never a fallback to the first `bank` control account.
  const bankCode = str(p.glAccountCode) ?? str(p.bankAccountCode) ?? str(p.accountCode);
  const bank = bankCode ? await ctx.findAccountByCode(bankCode) : null;
  if (!ap) return { kind: 'rejected', reason: 'supplier_payment.recorded: no AP control account in the chart' };
  if (!bank) return { kind: 'rejected', reason: 'supplier_payment.recorded: the paying Treasury account is not GL-mapped to an active chart account' };
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
