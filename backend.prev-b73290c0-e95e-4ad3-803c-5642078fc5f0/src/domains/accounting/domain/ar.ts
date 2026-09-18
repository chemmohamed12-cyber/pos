/**
 * F04 — Accounts Receivable (ADR-036 D4/D5). Approval request-type codes
 * + AR adjustment kinds. The request-type codes are permission-node-shaped
 * strings (FA-01 contract §3).
 */

export const AR_APPROVAL_REQUEST_TYPES = {
  writeOff: 'accounting.ar.write_off',
  creditNote: 'accounting.ar.credit_note',
  debitNote: 'accounting.ar.debit_note',
  adjustment: 'accounting.ar.adjustment',
  openingBalance: 'accounting.ar.opening_balance',
} as const;

/** The permission node an FA-01 checker must hold at `editable` to decide an AR request. */
export const AR_APPROVER_PERMISSION_NODE = 'accounting.ar.approve';

export type ArAdjustmentKind = 'write_off' | 'credit_note' | 'debit_note' | 'adjustment' | 'opening_balance';

export const AR_ADJUSTMENT_KINDS: readonly ArAdjustmentKind[] = [
  'write_off',
  'credit_note',
  'debit_note',
  'adjustment',
  'opening_balance',
] as const;

export function isArAdjustmentKind(v: unknown): v is ArAdjustmentKind {
  return typeof v === 'string' && (AR_ADJUSTMENT_KINDS as readonly string[]).includes(v);
}

/** kind → FA-01 request-type code + default minApprovers (CTO decision D-07). */
export const AR_ADJUSTMENT_META: Record<
  ArAdjustmentKind,
  { requestTypeCode: string; minApprovers: number; alwaysGated: boolean }
> = {
  write_off: { requestTypeCode: AR_APPROVAL_REQUEST_TYPES.writeOff, minApprovers: 2, alwaysGated: true },
  opening_balance: { requestTypeCode: AR_APPROVAL_REQUEST_TYPES.openingBalance, minApprovers: 2, alwaysGated: true },
  credit_note: { requestTypeCode: AR_APPROVAL_REQUEST_TYPES.creditNote, minApprovers: 1, alwaysGated: false },
  debit_note: { requestTypeCode: AR_APPROVAL_REQUEST_TYPES.debitNote, minApprovers: 1, alwaysGated: false },
  adjustment: { requestTypeCode: AR_APPROVAL_REQUEST_TYPES.adjustment, minApprovers: 1, alwaysGated: false },
};

/**
 * kind → (subledger direction, GL posting shape). AR ↑ = debit the `ar`
 * control account; AR ↓ = credit it.
 */
export const AR_ADJUSTMENT_POSTING: Record<
  ArAdjustmentKind,
  { subledgerDirection: 'debit' | 'credit'; subledgerEntryType: 'adjustment' | 'debit_note' | 'return_credit_note' | 'opening_balance' }
> = {
  write_off: { subledgerDirection: 'credit', subledgerEntryType: 'adjustment' },
  credit_note: { subledgerDirection: 'credit', subledgerEntryType: 'return_credit_note' },
  debit_note: { subledgerDirection: 'debit', subledgerEntryType: 'debit_note' },
  adjustment: { subledgerDirection: 'credit', subledgerEntryType: 'adjustment' }, // caller may flip via an explicit direction
  opening_balance: { subledgerDirection: 'debit', subledgerEntryType: 'opening_balance' },
};
