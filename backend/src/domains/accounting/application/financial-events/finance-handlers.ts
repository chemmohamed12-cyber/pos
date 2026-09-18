import { FinancialEvent } from '../../infrastructure/financial-event.entity';
import { HandlerContext, HandlerResult, JournalDraftLine } from './handler-registry';
import { handleSupplierInvoicePosted, handleSupplierInvoiceVoided, handleSupplierPaymentRecorded } from './supplier-invoice.handler';
import { handleGoodsReceiptPosted } from './goods-receipt.handler';

/**
 * F03 — V1 Financial Event handlers for the `finance` / `treasury` topics
 * (ADR-035 D6). Each is a PURE function: `(event, ctx) => draft | rejected`.
 * It never touches the ledger core or the posting gate directly — it
 * only produces a balanced draft, which `FinancialEventService` then runs
 * through the standard posting gate with `systemPosting: true`.
 *
 * **V1 payload assumptions (disclosed):** as of F03, `finance` /
 * `treasury` do not yet *publish* these topics (their
 * `finance.manifest.ts` `public_contract.events` declares them; no
 * `EventBusService.publish` call exists yet — `finance` domain code must
 * not be modified by F03). These handlers are built + tested end-to-end
 * with synthetic events and activate automatically once a future
 * `finance` increment (or F04) wires the real publish calls. Payload
 * field names below are the assumed contract; a handler that cannot find
 * a required field or account returns `rejected` (visible + re-drivable),
 * never a bad posting.
 */

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : typeof v === 'number' ? String(v) : null;
}

function amt(v: unknown): string | null {
  const s = str(v);
  if (s === null) return null;
  return /^\d+(\.\d+)?$/.test(s) && Number(s) > 0 ? s : null;
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

/** `finance.invoice.posted` → Dr AR / Cr Revenue (+ Cr Tax payable). */
export async function handleInvoicePosted(event: FinancialEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const p = event.payload;
  const net = amt(p.netAmount ?? p.amount);
  const tax = amt(p.taxAmount) ?? '0';
  if (!net) return { kind: 'rejected', reason: 'invoice.posted: missing/invalid netAmount' };

  const ar = await resolveAccount(ctx, p.arAccountCode, 'ar');
  const revenueCode = str(p.revenueAccountCode) ?? '4101'; // payload hint, else the IFRS-SME template's Sales Revenue
  const revenueAcc = await ctx.findAccountByCode(revenueCode);
  if (!ar) return { kind: 'rejected', reason: 'invoice.posted: no AR control account in the chart' };
  if (!revenueAcc) return { kind: 'rejected', reason: `invoice.posted: revenue account "${revenueCode}" not found (set payload.revenueAccountCode)` };

  const gross = (Number(net) + Number(tax)).toFixed(4);
  const lines: JournalDraftLine[] = [
    { accountId: ar, debit: gross, description: 'Accounts receivable' },
    { accountId: revenueAcc, credit: net, description: 'Revenue' },
  ];
  if (Number(tax) > 0) {
    const taxAcc = await resolveAccount(ctx, p.taxAccountCode, 'tax_payable');
    if (!taxAcc) return { kind: 'rejected', reason: 'invoice.posted: tax amount present but no tax_payable control account' };
    lines.push({ accountId: taxAcc, credit: tax, description: 'Output tax' });
  }

  return {
    kind: 'draft',
    draft: {
      businessDate: event.businessDate,
      description: `Invoice ${str(p.invoiceNumber) ?? event.sourceEntityId} posted`,
      transactionCurrencyCode: event.transactionCurrencyCode,
      orgUnitId: event.orgUnitId,
      lines,
    },
  };
}

/** `finance.invoice.voided` → the mirror of invoice.posted. */
export async function handleInvoiceVoided(event: FinancialEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const posted = await handleInvoicePosted(event, ctx);
  if (posted.kind !== 'draft') return posted;
  return {
    kind: 'draft',
    draft: {
      ...posted.draft,
      description: `Invoice ${str(event.payload.invoiceNumber) ?? event.sourceEntityId} voided`,
      lines: posted.draft.lines.map((l) => ({
        accountId: l.accountId,
        debit: l.credit,
        credit: l.debit,
        description: l.description,
      })),
    },
  };
}

/** `finance.payment.recorded` → Dr Bank/Cash / Cr AR. */
export async function handlePaymentRecorded(event: FinancialEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const p = event.payload;
  const amount = amt(p.amount);
  if (!amount) return { kind: 'rejected', reason: 'payment.recorded: missing/invalid amount' };
  const bank = await resolveAccount(ctx, p.bankAccountCode ?? p.accountCode, 'bank');
  const ar = await resolveAccount(ctx, p.arAccountCode, 'ar');
  if (!bank) return { kind: 'rejected', reason: 'payment.recorded: no bank/cash control account resolvable' };
  if (!ar) return { kind: 'rejected', reason: 'payment.recorded: no AR control account in the chart' };
  return {
    kind: 'draft',
    draft: {
      businessDate: event.businessDate,
      description: `Payment ${str(p.paymentNumber) ?? event.sourceEntityId} received`,
      transactionCurrencyCode: event.transactionCurrencyCode,
      orgUnitId: event.orgUnitId,
      lines: [
        { accountId: bank, debit: amount, description: 'Cash / bank' },
        { accountId: ar, credit: amount, description: 'Accounts receivable' },
      ],
    },
  };
}

/**
 * `deposit.verified` → Dr [the Treasury account's mapped GL code] / Cr `ar` (ADR-042 D1/D2/D9).
 * Structurally identical in shape to `handlePaymentRecorded` — a verified deposit is a
 * customer-facing cash event (money reducing what a customer owes), never a treasury-internal
 * movement. `glAccountCode` is resolved and placed in the payload by the PUBLISHER
 * (`DepositsService.approveDeposit`, F09-H1) — this handler never re-derives it, and never falls
 * back to `resolveControlAccount('bank')` (which could silently choose the WRONG bank account) —
 * `findAccountByCode` only, exactly the specific account the money actually landed in, or
 * `REJECTED` when unmapped (fail-closed, never invented, ADR-042 D3h's own rule applied here).
 */
export async function handleDepositVerified(event: FinancialEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const p = event.payload;
  const amount = amt(p.amount);
  if (!amount) return { kind: 'rejected', reason: 'deposit.verified: missing/invalid amount' };
  const glCode = str(p.glAccountCode);
  const bank = glCode ? await ctx.findAccountByCode(glCode) : null;
  if (!bank) return { kind: 'rejected', reason: 'deposit.verified: treasury account is not GL-mapped' };
  const ar = await ctx.resolveControlAccount('ar');
  if (!ar) return { kind: 'rejected', reason: 'deposit.verified: no ar control account in the chart' };
  return {
    kind: 'draft',
    draft: {
      businessDate: event.businessDate,
      description: `Deposit ${str(p.depositId) ?? event.sourceEntityId} verified`,
      transactionCurrencyCode: event.transactionCurrencyCode,
      orgUnitId: event.orgUnitId,
      lines: [
        { accountId: bank, debit: amount, description: 'Cash / bank' },
        { accountId: ar, credit: amount, description: 'Accounts receivable' },
      ],
    },
  };
}

/**
 * `collection.remitted` → Dr [the settlement account's mapped GL code] / Cr `ar` (ADR-042
 * D1/D2/D3). The SOLE GL trigger for a COD collection — `collection.recorded` never gets a handler
 * here, by design (ADR-042 D3a-D3h): it fires at collection time, before a custodian-less
 * collection has any real Treasury leg at all, and before the Customer Ledger is ever credited.
 * `collection.remitted` fires exactly when both of those become true, for every collection shape
 * uniformly (`DeliveryService.remitCollection`, F09-H2). Same fail-closed shape as
 * `handleDepositVerified` — never a control-function fallback, never an invented account.
 */
export async function handleCollectionRemitted(event: FinancialEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const p = event.payload;
  const amount = amt(p.amount);
  if (!amount) return { kind: 'rejected', reason: 'collection.remitted: missing/invalid amount' };
  const glCode = str(p.glAccountCode);
  const bank = glCode ? await ctx.findAccountByCode(glCode) : null;
  if (!bank) return { kind: 'rejected', reason: 'collection.remitted: treasury account is not GL-mapped' };
  const ar = await ctx.resolveControlAccount('ar');
  if (!ar) return { kind: 'rejected', reason: 'collection.remitted: no ar control account in the chart' };
  return {
    kind: 'draft',
    draft: {
      businessDate: event.businessDate,
      description: `COD collection ${str(p.collectionId) ?? event.sourceEntityId} remitted`,
      transactionCurrencyCode: event.transactionCurrencyCode,
      orgUnitId: event.orgUnitId,
      lines: [
        { accountId: bank, debit: amount, description: 'Cash / bank' },
        { accountId: ar, credit: amount, description: 'Accounts receivable' },
      ],
    },
  };
}

/**
 * `treasury.cash.recorded` → Dr/Cr bank vs. a counter account.
 *
 * F06 (ADR-038 D3): when the event carries no `counterAccountCode`, the
 * counter is the **configured clearing/suspense account**
 * (`accounting.cash_movement_clearing_account_code`). **No hard-coded
 * fallback** — if that config is unset, or resolves to an account that is
 * missing / inactive / non-postable / a control account, this handler
 * returns `rejected` (fail-closed: the `FinancialEvent` lands REJECTED,
 * visible + re-drivable once the config is fixed; the Treasury
 * transaction itself is unaffected).
 */
export async function handleCashRecorded(event: FinancialEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const p = event.payload;
  const amount = amt(p.amount);
  const direction = str(p.direction);
  if (!amount) return { kind: 'rejected', reason: 'cash.recorded: missing/invalid amount' };
  if (direction !== 'in' && direction !== 'out') return { kind: 'rejected', reason: 'cash.recorded: direction must be "in" or "out"' };
  const bank = await resolveAccount(ctx, p.accountCode ?? p.bankAccountCode, 'bank');
  if (!bank) return { kind: 'rejected', reason: 'cash.recorded: no bank control account resolvable' };

  const counterCode = str(p.counterAccountCode);
  let counterAcc: string | null;
  if (counterCode) {
    counterAcc = await ctx.findAccountByCode(counterCode);
    if (!counterAcc) return { kind: 'rejected', reason: `cash.recorded: counter account "${counterCode}" not found` };
  } else {
    const clearing = await ctx.resolveConfiguredPostableAccount('accounting.cash_movement_clearing_account_code');
    if (!clearing.ok) {
      return {
        kind: 'rejected',
        reason: `cash.recorded: no counterAccountCode and the clearing account is ${clearing.reason} — set accounting.cash_movement_clearing_account_code to a postable non-control GL account`,
      };
    }
    counterAcc = clearing.id;
  }
  const bankLine: JournalDraftLine =
    direction === 'in' ? { accountId: bank, debit: amount } : { accountId: bank, credit: amount };
  const counterLine: JournalDraftLine =
    direction === 'in' ? { accountId: counterAcc, credit: amount } : { accountId: counterAcc, debit: amount };
  return {
    kind: 'draft',
    draft: {
      businessDate: event.businessDate,
      description: `Treasury cash ${direction} ${str(p.reference) ?? event.sourceEntityId}`,
      transactionCurrencyCode: event.transactionCurrencyCode,
      orgUnitId: event.orgUnitId,
      lines: [bankLine, counterLine],
    },
  };
}

/** `treasury.transfer.completed` → Dr to-account / Cr from-account. */
export async function handleTransferCompleted(event: FinancialEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const p = event.payload;
  const amount = amt(p.amount);
  if (!amount) return { kind: 'rejected', reason: 'transfer.completed: missing/invalid amount' };
  const from = await ctx.findAccountByCode(str(p.fromAccountCode) ?? '');
  const to = await ctx.findAccountByCode(str(p.toAccountCode) ?? '');
  if (!from || !to) return { kind: 'rejected', reason: 'transfer.completed: fromAccountCode / toAccountCode must resolve to accounts in the chart' };
  return {
    kind: 'draft',
    draft: {
      businessDate: event.businessDate,
      description: `Treasury transfer ${str(p.reference) ?? event.sourceEntityId}`,
      transactionCurrencyCode: event.transactionCurrencyCode,
      orgUnitId: event.orgUnitId,
      lines: [
        { accountId: to, debit: amount, description: 'Transfer in' },
        { accountId: from, credit: amount, description: 'Transfer out' },
      ],
    },
  };
}

export const V1_FINANCE_HANDLERS: Record<string, (e: FinancialEvent, c: HandlerContext) => Promise<HandlerResult>> = {
  'finance.invoice.posted': handleInvoicePosted,
  'finance.invoice.voided': handleInvoiceVoided,
  'finance.payment.recorded': handlePaymentRecorded,
  // ADR-048 — Procurement's Supplier Invoice/AP, the credit-normal mirror of the AR trio above.
  // The first REAL publisher AP_EVENT_TOPICS ever had (ADR-037 shipped only the contract).
  'finance.supplier_invoice.posted': handleSupplierInvoicePosted,
  'finance.supplier_invoice.voided': handleSupplierInvoiceVoided,
  'finance.supplier_payment.recorded': handleSupplierPaymentRecorded,
  // ADR-054/ADR-057 — GRNI's own leg: Dr Inventory / Cr GRNI at receipt (the FIRST GL entry
  // Procurement's purchased value now hits, before the invoice clears GRNI above).
  'procurement.goods_receipt.posted': handleGoodsReceiptPosted,
  'treasury.cash.recorded': handleCashRecorded,
  'treasury.transfer.completed': handleTransferCompleted,
  // F09 (ADR-042 D1-D3) — 'deposit.verified' and 'collection.remitted' are both PURE (read
  // ctx.findAccountByCode/resolveControlAccount only, mutate nothing) — the same shape as
  // handleCashRecorded/handlePaymentRecorded above, so the stateless map is the right home for
  // them, unlike F08's self-registering InventoryCostingHandlerService. 'collection.recorded' is
  // deliberately NEVER registered here (ADR-042 D3) — it stays subscribed-but-permanently-IGNORED,
  // by design, not a placeholder awaiting a future handler.
  'deposit.verified': handleDepositVerified,
  'collection.remitted': handleCollectionRemitted,
  // F07 registered a handler for 'inventory.movement.recorded' here originally; F08 (ADR-041
  // D18/D18a) moved it to a self-registering service (`InventoryCostingHandlerService`) instead,
  // so it can depend on `INVENTORY_VALUATION_CONTRACT` and share a transaction with GL posting —
  // the exact self-registration pattern `InventoryAdjustmentService` already uses for its own
  // internal event, not this stateless map.
};
