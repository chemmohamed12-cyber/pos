/**
 * F02 — Chart of Accounts (Blueprint §3.1, ADR-034 D3). The five classic
 * account types and the derived normal balance.
 *
 * `normalBalance` is a PURE FUNCTION of `accountType` + `isContra` — never
 * supplied by a client, always recomputed by `GLAccountService`, then
 * stored denormalised for F03/F14 query performance (ADR-034 D3).
 */
export type GLAccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

export const GL_ACCOUNT_TYPES: readonly GLAccountType[] = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const;

export type NormalBalance = 'debit' | 'credit';

/** Types whose *natural* (non-contra) normal balance is debit. The rest are credit. */
const DEBIT_NORMAL_TYPES: ReadonlySet<GLAccountType> = new Set<GLAccountType>(['asset', 'expense']);

/**
 * ADR-034 D3 — asset/expense → debit; liability/equity/revenue → credit;
 * then flipped when `isContra` (e.g. Accumulated Depreciation is an
 * `asset` that carries a credit balance; Sales Returns & Allowances is a
 * `revenue` that carries a debit balance).
 */
export function deriveNormalBalance(accountType: GLAccountType, isContra: boolean): NormalBalance {
  const natural: NormalBalance = DEBIT_NORMAL_TYPES.has(accountType) ? 'debit' : 'credit';
  if (!isContra) return natural;
  return natural === 'debit' ? 'credit' : 'debit';
}

export function isGLAccountType(value: unknown): value is GLAccountType {
  return typeof value === 'string' && (GL_ACCOUNT_TYPES as readonly string[]).includes(value);
}
