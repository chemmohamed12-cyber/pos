/**
 * F06 — Cash & Bank (ADR-038 D5). The FA-01 request-type shapes + posting
 * directions for cash/bank *adjustments* — bank charges/fees/interest,
 * opening balances, unreconciled write-offs, and clearing-account
 * reclassifications. Routine `cash_in` / `cash_out` / `transfer` are NOT
 * here — they never need approval (ADR-038 D5).
 *
 * Request-type codes are permission-node-shaped strings (FA-01 contract
 * §3); they are NOT permission nodes (those are `accounting.cash.{view,
 * create,adjust,approve}`).
 */

export const CASH_BANK_APPROVAL_REQUEST_TYPES = {
  bankAdjustment: 'accounting.cash.bank_adjustment',
  openingBalance: 'accounting.cash.opening_balance',
  unreconciledWriteOff: 'accounting.cash.unreconciled_write_off',
  reclassification: 'accounting.cash.reclassification',
} as const;

/** The permission node an FA-01 checker must hold at `editable` to decide a cash/bank request. */
export const CASH_BANK_APPROVER_PERMISSION_NODE = 'accounting.cash.approve';

export type CashBankAdjustmentKind = 'bank_adjustment' | 'opening_balance' | 'unreconciled_write_off' | 'reclassification';

export const CASH_BANK_ADJUSTMENT_KINDS: readonly CashBankAdjustmentKind[] = [
  'bank_adjustment',
  'opening_balance',
  'unreconciled_write_off',
  'reclassification',
] as const;

export function isCashBankAdjustmentKind(v: unknown): v is CashBankAdjustmentKind {
  return typeof v === 'string' && (CASH_BANK_ADJUSTMENT_KINDS as readonly string[]).includes(v);
}

/**
 * kind → FA-01 request-type code + minApprovers + gating (ADR-038 D5).
 * `alwaysGated: false` kinds are threshold-gated via
 * `accounting.cash_bank_adjustment_approval_threshold` (`''`/non-numeric →
 * null → always gated — fail-closed).
 */
export const CASH_BANK_ADJUSTMENT_META: Record<
  CashBankAdjustmentKind,
  { requestTypeCode: string; minApprovers: number; alwaysGated: boolean }
> = {
  bank_adjustment: { requestTypeCode: CASH_BANK_APPROVAL_REQUEST_TYPES.bankAdjustment, minApprovers: 1, alwaysGated: false },
  opening_balance: { requestTypeCode: CASH_BANK_APPROVAL_REQUEST_TYPES.openingBalance, minApprovers: 1, alwaysGated: true },
  unreconciled_write_off: { requestTypeCode: CASH_BANK_APPROVAL_REQUEST_TYPES.unreconciledWriteOff, minApprovers: 2, alwaysGated: true },
  reclassification: { requestTypeCode: CASH_BANK_APPROVAL_REQUEST_TYPES.reclassification, minApprovers: 1, alwaysGated: false },
};

/**
 * kind → the default direction of the `bank`-account movement, and which
 * payload field carries the maker-supplied counter/contra account.
 * `bankDirection: 'debit'` = the `bank` GL account is DEBITED (cash into
 * the account, or an interest credit reversed — see the handler). The
 * caller may flip it with an explicit `direction`.
 */
export const CASH_BANK_ADJUSTMENT_POSTING: Record<
  CashBankAdjustmentKind,
  { bankDirection: 'debit' | 'credit'; counterField: 'counterAccountCode' | 'contraAccountCode' | 'openingBalanceAccountCode' }
> = {
  // a bank charge/fee REDUCES the bank balance → credit bank / debit the expense counter
  bank_adjustment: { bankDirection: 'credit', counterField: 'counterAccountCode' },
  // an opening bank balance (debit-normal asset) INCREASES bank → debit bank / credit opening equity
  opening_balance: { bankDirection: 'debit', counterField: 'openingBalanceAccountCode' },
  // a write-off of a residual drift — direction resolved from the drift sign by the handler
  unreconciled_write_off: { bankDirection: 'credit', counterField: 'counterAccountCode' },
  // moving a clearing-account balance to its real account — no bank leg; direction from payload
  reclassification: { bankDirection: 'debit', counterField: 'contraAccountCode' },
};
