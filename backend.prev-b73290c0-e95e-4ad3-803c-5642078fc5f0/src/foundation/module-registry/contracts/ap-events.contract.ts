/**
 * F05 — Accounts Payable (ADR-037 D1/D4, Blueprint §4/§8). The AP
 * integration boundary a **future operational supplier-finance domain**
 * ("OP-AP") will implement. Defined here in `foundation/module-registry/
 * contracts/` — the one place both domains may import from
 * (`no-restricted-imports` blocks a direct cross-domain import).
 *
 * **NOTHING in this file has a producer/consumer wired in F05** (there is
 * no supplier-finance domain yet — ADR-037 D1 = Option A, defer). F05
 * ships:
 *   - the event topic/payload shapes so a future publisher matches them,
 *   - the `SUPPLIER_LEDGER_CONTRACT` token so `ApReconciliationService` /
 *     `ApAdjustmentService` can inject it `@Optional()` and light up
 *     additively when OP-AP binds an implementation.
 *
 * Every event payload carries an explicit `idempotencyKey` — the derived
 * fallback (F03 §4.7) is NOT acceptable for post → void → re-post. The
 * publisher builds it.
 */

// ---------------------------------------------------------------------------
// Event contract (for the future OP-AP publisher)
// ---------------------------------------------------------------------------

/** Common envelope on every AP event. */
export interface ApEventBase {
  /** REQUIRED, unique per real occurrence — e.g. `supplier-finance:bill:<id>:posted:<n>`. */
  idempotencyKey: string;
  /** ISO date — drives fiscal-period resolution in F03's posting gate. */
  businessDate: string;
  orgUnitId: string | null;
  /** ISO 4217 transaction currency. */
  currency: string;
  sourceEntityType: 'supplier_invoice' | 'supplier_payment' | 'credit_note' | 'debit_note' | 'ledger_entry';
  sourceEntityId: string;
  /** Snapshot of the operational document's generic external-document reference at emission time (E-02). Never ETA-named. */
  externalDocument: { type: string; id: string; status: string | null; secondaryId: string | null } | null;
  payloadVersion: number;
}

export interface SupplierInvoicePostedEvent extends ApEventBase {
  supplierInvoiceId: string;
  invoiceNumber: string;
  supplierId: string;
  purchaseOrderId: string | null;
  /** net (pre-tax) amount, in `currency` precision */
  netAmount: string;
  /** tax amount (0 when none) */
  taxAmount: string;
  /** gross = net + tax */
  grossAmount: string;
  dueDate: string | null;
  /** optional chart-account code hints; the handler falls back to control-function / default resolution */
  apAccountCode?: string | null;
  expenseAccountCode?: string | null;
  taxAccountCode?: string | null;
}

export interface SupplierInvoiceVoidedEvent extends SupplierInvoicePostedEvent {
  voidReason: string;
}

export interface SupplierPaymentRecordedEvent extends ApEventBase {
  supplierPaymentId: string;
  paymentNumber: string;
  supplierId: string;
  supplierInvoiceId: string | null;
  amount: string;
  method: string;
  treasuryAccountId: string;
  bankAccountCode?: string | null;
}

export const AP_EVENT_TOPICS = {
  supplierInvoicePosted: 'finance.supplier_invoice.posted',
  supplierInvoiceVoided: 'finance.supplier_invoice.voided',
  supplierPaymentRecorded: 'finance.supplier_payment.recorded',
  debitNoteIssued: 'finance.supplier_debit_note.issued',
  creditNoteReceived: 'finance.supplier_credit_note.received',
  apOpeningBalanceRecorded: 'finance.ap.opening_balance.recorded',
} as const;

/** The AP topics with a real publisher wired today. F05-H1: NONE — the future OP-AP phase wires them. */
export const AP_EVENT_TOPICS_V1: readonly string[] = [] as const;

/**
 * F05's own internal event type for an approved AP adjustment — emitted
 * (via `FinancialEventService.ingest`) by F05's FA-01 approval subscriber
 * and consumed by F05's own handler → the F03 posting gate → GL. Not
 * cross-domain (`sourceDomain: 'accounting'`).
 */
export const AP_ADJUSTMENT_APPROVED_EVENT = 'accounting.ap.adjustment.approved';

// ---------------------------------------------------------------------------
// Supplier-ledger read/write contract (for the future OP-AP domain to provide)
// ---------------------------------------------------------------------------

/**
 * `ApReconciliationService` injects this `@Optional()`. **Unbound today**
 * (ADR-037 D2) — the reconciliation records `no_subledger_source` and the
 * GL side only. The future OP-AP domain binds an implementation via
 * `useExisting` in its own module; then reconciliation compares
 * `Σ getAllSupplierBalances` vs the `ap` control account GL balance, and
 * `ApAdjustmentService` gains a subledger-movement step.
 *
 * Return types are primitives / plain shapes — never imported from a
 * domain folder (`no-restricted-imports`), exactly like `finance.contract.ts`.
 */
export interface SupplierLedgerContract {
  /** Σ of every supplier's balance as of the date (inclusive of the whole calendar day), SQL NUMERIC. */
  getAllSupplierBalances(asOfDate?: string): Promise<{ balances: Array<{ supplierId: string; balance: string }>; total: string }>;
  /** One supplier's ledger rows. */
  listLedger(supplierId: string, filter?: { from?: string; to?: string }): Promise<unknown[]>;
  /** Post one operational supplier-ledger movement (the sanctioned write route — never a raw table write). */
  postEntry(input: {
    supplierId: string;
    entryType: string;
    direction: 'debit' | 'credit';
    amount: string;
    reason: string;
    createdByUserId: string;
  }): Promise<unknown>;
}

export const SUPPLIER_LEDGER_CONTRACT = Symbol('SUPPLIER_LEDGER_CONTRACT');
