/**
 * Customer Financial Account / AR (CTO directive) — the fixed set of
 * transaction types that can post to a Customer Ledger entry. Mirrors
 * `TreasuryTransactionType`'s "small fixed enum, plain data" pattern —
 * this is a customer-facing subledger, not the cash/bank ledger itself.
 */
export type CustomerLedgerEntryType =
  | 'sales_invoice'
  | 'deposit'
  | 'payment'
  | 'cod_collection'
  | 'return_credit_note'
  | 'debit_note'
  | 'adjustment'
  | 'opening_balance'
  | 'refund';

export const CUSTOMER_LEDGER_ENTRY_TYPES: CustomerLedgerEntryType[] = [
  'sales_invoice',
  'deposit',
  'payment',
  'cod_collection',
  'return_credit_note',
  'debit_note',
  'adjustment',
  'opening_balance',
  'refund',
];

/**
 * `debit` increases what the customer owes (AR up); `credit` decreases it
 * (AR down). Stored explicitly rather than inferred from `entryType`
 * (`adjustment`/`opening_balance`/`debit_note` can legitimately go either
 * way) — same reasoning Treasury uses `type` rather than a derived sign.
 */
export type LedgerDirection = 'debit' | 'credit';
