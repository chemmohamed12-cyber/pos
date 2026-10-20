/**
 * T3 (2026-10-20) — Treasury Documents: the business layer ABOVE the append-only Treasury ledger. A document says WHY money moves (purpose), WHAT supports it
 * (source / reference), WHO prepared / approved / executed it, and it is the only thing that may trigger the movement. The ledger, the Financial Events and the
 * GL posting stay exactly as they are — a document executes through them.
 */
export type TreasuryDocumentKind = 'customer_collection' | 'transfer' | 'misc_receipt' | 'disbursement';
export const TREASURY_DOCUMENT_KINDS: readonly TreasuryDocumentKind[] = ['customer_collection', 'transfer', 'misc_receipt', 'disbursement'];

/** A transfer is one mechanism with three business purposes; the subtype decides which account types are allowed. */
export type TreasuryTransferSubtype = 'account_transfer' | 'bank_deposit' | 'bank_withdrawal';
export const TREASURY_TRANSFER_SUBTYPES: readonly TreasuryTransferSubtype[] = ['account_transfer', 'bank_deposit', 'bank_withdrawal'];

export type TreasuryDocumentStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'executed' | 'reversed' | 'cancelled';

/** Valid transitions only; `executed` and `reversed` are reached exclusively by the explicit execute / reverse actions. */
const TRANSITIONS: Record<TreasuryDocumentStatus, TreasuryDocumentStatus[]> = {
  draft: ['submitted', 'cancelled'],
  submitted: ['approved', 'rejected', 'cancelled'],
  approved: ['executed', 'cancelled'],
  rejected: ['draft', 'cancelled'],
  executed: ['reversed'],
  reversed: [],
  cancelled: [],
};

export function canTransitionTreasuryDocument(from: TreasuryDocumentStatus, to: TreasuryDocumentStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** Posting-profile config keys (company-owned reason → GL account maps). No account number exists in code. */
export const TREASURY_RECEIPT_REASON_ACCOUNTS_KEY = 'accounting.treasury_receipt_reason_accounts';
export const TREASURY_DISBURSEMENT_REASON_ACCOUNTS_KEY = 'accounting.treasury_disbursement_reason_accounts';
/** Amounts at or below this limit skip the approval request; unset / non-numeric = every document needs a separate approver (fail-closed). */
export const TREASURY_DOCUMENT_AUTO_APPROVE_LIMIT_KEY = 'finance.treasury_document_auto_approve_limit';

export const TREASURY_DOCUMENT_APPROVAL_REQUEST_TYPE = 'finance.treasury_document';
export const TREASURY_DOCUMENT_APPROVER_NODE = 'finance.cash_document.approve';
export const TREASURY_DOCUMENT_RESOURCE_TYPE = 'TreasuryDocument';
