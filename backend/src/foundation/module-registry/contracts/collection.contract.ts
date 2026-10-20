/**
 * T3 (2026-10-20) — the contract Treasury Documents use to EXECUTE a customer collection and to REVERSE a payment through the owning business domain
 * (customer-finance). Dependency inversion, same pattern as `finance.contract.ts`: the Treasury domain never imports customer-finance classes.
 */
import { EntityManager } from 'typeorm';

export interface CollectionAllocationInput {
  invoiceId: string;
  amount: string;
}

export interface RecordCollectionInput {
  customerId: string;
  /** one row per invoice settled by this receipt (an invoice may appear once). */
  allocations: CollectionAllocationInput[];
  /** the part of the receipt not applied to any invoice (customer advance / unapplied receipt); '0.00' or omitted when none. */
  unappliedAmount?: string;
  method: string;
  treasuryAccountId: string;
  reference: string | null;
  /** the owning Treasury Document id (traceability; used as the Treasury leg's reference when none is given). */
  documentId: string;
}

export interface OpenInvoiceView {
  id: string;
  invoiceNumber: string;
  remaining: string;
  state: string;
}

export interface FinanceCollectionContract {
  /** One receipt → one Treasury cash-in, one payment row, N Customer-Ledger credits, one GL event, N invoice-status recomputes — atomic inside the caller's transaction. */
  recordCollection(input: RecordCollectionInput, actorUserId: string, manager: EntityManager): Promise<{ paymentId: string; paymentNumber: string; treasuryTransactionId: string; amount: string }>;
  /** Reverse a payment through its owning document (Treasury leg + ledger + invoices + GL mirror). */
  reversePayment(paymentId: string, reason: string, actorUserId: string, manager: EntityManager): Promise<{ reversalNumber: string; invoicesReopened: string[] }>;
  /** The customer's invoices that can still receive money (posted / partially paid) with their remaining balance — Scope-checked. */
  listOpenInvoices(customerId: string, actorUserId: string, manager: EntityManager): Promise<OpenInvoiceView[]>;
}
export const FINANCE_COLLECTION_CONTRACT = Symbol('FINANCE_COLLECTION_CONTRACT');
