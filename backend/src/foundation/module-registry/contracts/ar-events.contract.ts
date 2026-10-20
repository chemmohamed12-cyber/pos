/**
 * F04 — Accounts Receivable (ADR-036 D3, Event Contract Map). The AR
 * event topics + payload shapes that `customer-finance` PUBLISHES and
 * `accounting` (F04) CONSUMES, defined here in `foundation/module-registry/
 * contracts/` — the one place both domains may import from
 * (`no-restricted-imports` blocks a direct cross-domain import, exactly as
 * for `finance.contract.ts`).
 *
 * **Every payload carries an explicit `idempotencyKey`** — the derived
 * fallback (F03 §4.7) is NOT acceptable for genuinely-distinct
 * same-source occurrences (post → void → re-post). The publisher builds it.
 */

/** Common envelope on every AR event. */
export interface ArEventBase {
  /** REQUIRED, unique per real occurrence — e.g. `customer-finance:invoice:<id>:posted:<n>`. */
  idempotencyKey: string;
  /** ISO date — drives fiscal-period resolution in F03's posting gate. */
  businessDate: string;
  orgUnitId: string | null;
  /** ISO 4217 transaction currency. */
  currency: string;
  sourceEntityType: 'invoice' | 'payment' | 'credit_note' | 'debit_note' | 'ledger_entry';
  sourceEntityId: string;
  /** Snapshot of the subledger document's generic external-document reference at emission time (E-02). */
  externalDocument: { type: string; id: string; status: string | null; secondaryId: string | null } | null;
  payloadVersion: number;
}

export interface InvoicePostedEvent extends ArEventBase {
  invoiceId: string;
  invoiceNumber: string;
  customerId: string;
  salesOrderId: string | null;
  /** net (pre-tax) amount, in `currency` precision */
  netAmount: string;
  /** tax amount (0 when none) */
  taxAmount: string;
  /** gross = net + tax */
  grossAmount: string;
  dueDate: string | null;
  /** optional chart-account code hints; the handler falls back to control-function / default resolution */
  arAccountCode?: string | null;
  revenueAccountCode?: string | null;
  taxAccountCode?: string | null;
}

export interface InvoiceVoidedEvent extends InvoicePostedEvent {
  voidReason: string;
}

export interface PaymentRecordedEvent extends ArEventBase {
  paymentId: string;
  paymentNumber: string;
  customerId: string;
  invoiceId: string | null;
  amount: string;
  method: string;
  treasuryAccountId: string;
  /** D2: the receiving Treasury account's own mapped GL account code — the ONLY source of the bank leg (no control-account fallback). */
  glAccountCode: string;
  bankAccountCode?: string | null;
}

/**
 * T2 (2026-10-20) — published by `customer-finance` when a customer payment is REVERSED through its owning document: the exact mirror of
 * `PaymentRecordedEvent` (Dr `ar` control / Cr the receiving account's own mapped GL account). Carries `reversalOf` = the original payment id.
 */
export interface PaymentReversedEvent extends ArEventBase {
  paymentId: string;
  paymentNumber: string;
  reversalNumber: string;
  customerId: string;
  amount: string;
  treasuryAccountId: string;
  glAccountCode: string;
  reversalOf: string;
  reason: string;
  arAccountCode?: string | null;
}

/**
 * D4 (2026-10-05) — published by `returns` when a Sales Return / Shipment Return of an INVOICED sale completes: the
 * Revenue reversal + AR credit (+ tax reversal) of the returned value. `netAmount`/`taxAmount`/`grossAmount` are derived
 * from the ORIGINAL invoice value (never from a return price). The inventory/COGS leg travels on its own
 * `inventory.movement.recorded` (`glKind='return_in'`) event.
 */
export interface SalesReturnCreditedEvent extends ArEventBase {
  returnKind: 'sales_return' | 'shipment_return';
  returnId: string;
  returnNumber: string;
  customerId: string;
  invoiceId: string;
  invoiceNumber: string;
  salesOrderId: string;
  netAmount: string;
  taxAmount: string;
  grossAmount: string;
}

export const AR_EVENT_TOPICS = {
  invoicePosted: 'finance.invoice.posted',
  invoiceVoided: 'finance.invoice.voided',
  paymentRecorded: 'finance.payment.recorded',
  /** T2 — a customer payment reversed through its owning document (Dr `ar` / Cr bank). */
  paymentReversed: 'finance.payment.reversed',
  creditNoteIssued: 'finance.credit_note.issued',
  /** D4 — a completed return of an invoiced sale (Dr Sales Returns [+ Dr tax] / Cr AR). */
  salesReturnCredited: 'returns.sale_return.credited',
  debitNoteIssued: 'finance.debit_note.issued',
  arOpeningBalanceRecorded: 'finance.ar.opening_balance.recorded',
} as const;

/** The AR topics that have a real publisher wired in F04 V1 (handoff F04-H1). */
export const AR_EVENT_TOPICS_V1: readonly string[] = [
  AR_EVENT_TOPICS.invoicePosted,
  AR_EVENT_TOPICS.invoiceVoided,
  AR_EVENT_TOPICS.paymentRecorded,
  AR_EVENT_TOPICS.paymentReversed,
] as const;

/**
 * F04's own internal event type for an approved AR adjustment — emitted
 * (via `FinancialEventService.ingest`) by F04's FA-01 approval subscriber
 * and consumed by F04's own handler → the F03 posting gate → GL. Not
 * cross-domain (`sourceDomain: 'accounting'`).
 */
export const AR_ADJUSTMENT_APPROVED_EVENT = 'accounting.ar.adjustment.approved';
