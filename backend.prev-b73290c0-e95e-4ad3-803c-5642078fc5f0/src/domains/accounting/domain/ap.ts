/**
 * F05 — Accounts Payable (ADR-037 D5/D6). The credit-normal mirror of
 * `domain/ar.ts`. Request-type codes are permission-node-shaped strings
 * (FA-01 contract §3).
 *
 * **CTO amendment (2026-09-10):** unlike F04, ALL FIVE kinds are
 * `alwaysGated = true` — there is no straight-through path in F05.
 */

export const AP_APPROVAL_REQUEST_TYPES = {
  writeOff: 'accounting.ap.write_off',
  creditNote: 'accounting.ap.credit_note',
  debitNote: 'accounting.ap.debit_note',
  adjustment: 'accounting.ap.adjustment',
  openingBalance: 'accounting.ap.opening_balance',
} as const;

/** The permission node an FA-01 checker must hold at `editable` to decide an AP request. */
export const AP_APPROVER_PERMISSION_NODE = 'accounting.ap.approve';

export type ApAdjustmentKind = 'write_off' | 'credit_note' | 'debit_note' | 'adjustment' | 'opening_balance';

export const AP_ADJUSTMENT_KINDS: readonly ApAdjustmentKind[] = [
  'write_off',
  'credit_note',
  'debit_note',
  'adjustment',
  'opening_balance',
] as const;

export function isApAdjustmentKind(v: unknown): v is ApAdjustmentKind {
  return typeof v === 'string' && (AP_ADJUSTMENT_KINDS as readonly string[]).includes(v);
}

/**
 * kind → FA-01 request-type code + default minApprovers (CTO decision, ADR-037 D5).
 * write_off / opening_balance → 2 approvers; the rest → 1. ALL alwaysGated.
 */
export const AP_ADJUSTMENT_META: Record<
  ApAdjustmentKind,
  { requestTypeCode: string; minApprovers: number; alwaysGated: boolean }
> = {
  write_off: { requestTypeCode: AP_APPROVAL_REQUEST_TYPES.writeOff, minApprovers: 2, alwaysGated: true },
  opening_balance: { requestTypeCode: AP_APPROVAL_REQUEST_TYPES.openingBalance, minApprovers: 2, alwaysGated: true },
  credit_note: { requestTypeCode: AP_APPROVAL_REQUEST_TYPES.creditNote, minApprovers: 1, alwaysGated: true },
  debit_note: { requestTypeCode: AP_APPROVAL_REQUEST_TYPES.debitNote, minApprovers: 1, alwaysGated: true },
  adjustment: { requestTypeCode: AP_APPROVAL_REQUEST_TYPES.adjustment, minApprovers: 1, alwaysGated: true },
};

/**
 * kind → the direction of the AP-position movement. AP is a credit-normal
 * liability, so this is the mirror of `AR_ADJUSTMENT_POSTING`: AP ↑ =
 * CREDIT the `ap` control account; AP ↓ = DEBIT it.
 *
 * `subledgerDirection` here describes the AP-position movement only —
 * there is no operational AP subledger in F05 (ADR-037 D1/D3); it is kept
 * so the future OP-AP phase can reuse the shape verbatim.
 */
export const AP_ADJUSTMENT_POSTING: Record<
  ApAdjustmentKind,
  { positionDirection: 'debit' | 'credit'; entryType: 'adjustment' | 'debit_note' | 'credit_note' | 'opening_balance' }
> = {
  // writing a payable off REDUCES AP → debit the ap control account
  write_off: { positionDirection: 'debit', entryType: 'adjustment' },
  // a supplier credit note REDUCES what we owe → debit AP
  credit_note: { positionDirection: 'debit', entryType: 'credit_note' },
  // a debit note we raise against a supplier REDUCES AP → debit AP
  debit_note: { positionDirection: 'debit', entryType: 'debit_note' },
  // a manual adjustment defaults to reducing AP; the caller may flip via an explicit direction
  adjustment: { positionDirection: 'debit', entryType: 'adjustment' },
  // an opening AP balance INCREASES AP → credit the ap control account
  opening_balance: { positionDirection: 'credit', entryType: 'opening_balance' },
};
