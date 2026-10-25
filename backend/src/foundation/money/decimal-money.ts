import Decimal from 'decimal.js';

/**
 * Exact-decimal money arithmetic for Payroll (Addendum A / PA-36). JavaScript `number` is never used to add, compare or round an amount: every amount
 * enters as a string (NUMERIC from Postgres), is summed as a `Decimal`, and leaves as a 2-decimal string. Rounding is half-up, applied only when an
 * amount is *produced* (never mid-sum), so a sum of N exact 2-decimal lines is exact.
 */
export type MoneyInput = Decimal.Value | null | undefined;

export function dec(v: MoneyInput): Decimal {
  return new Decimal(v === null || v === undefined || v === '' ? 0 : v);
}

export function sumMoney(values: MoneyInput[]): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(dec(v)), new Decimal(0));
}

/** Two-decimal string, half-up. */
export function money(v: MoneyInput): string {
  return dec(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

/** True for a finite decimal string (sign allowed) — used to validate client-supplied amounts before they reach the database. */
export function isFiniteDecimalString(s: unknown): s is string {
  if (typeof s !== 'string' || s.trim() === '') return false;
  try {
    return new Decimal(s.trim()).isFinite();
  } catch {
    return false;
  }
}
