/**
 * ADR-048 — the fixed set of transaction types that can post to a
 * Supplier Ledger entry. Mirrors `CustomerLedgerEntryType`'s "small fixed
 * enum, plain data" pattern.
 */
export type SupplierLedgerEntryType = 'supplier_invoice' | 'payment' | 'debit_note' | 'credit_note' | 'adjustment' | 'opening_balance';

export const SUPPLIER_LEDGER_ENTRY_TYPES: SupplierLedgerEntryType[] = [
  'supplier_invoice',
  'payment',
  'debit_note',
  'credit_note',
  'adjustment',
  'opening_balance',
];

/**
 * `credit` increases what we owe the supplier (AP up, liability side);
 * `debit` decreases it (AP down) — the mirror image of
 * `CustomerLedgerEntryType`'s `LedgerDirection` (AR is an asset, debit-up;
 * AP is a liability, credit-up). Stored explicitly, never inferred from
 * `entryType`, same reasoning as the customer-side ledger.
 */
export type SupplierLedgerDirection = 'debit' | 'credit';
