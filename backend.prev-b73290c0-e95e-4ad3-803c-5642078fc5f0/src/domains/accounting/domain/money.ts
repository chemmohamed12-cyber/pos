import Decimal from 'decimal.js';
import { CurrencyRoundingMode } from './currency-rounding-mode';

/**
 * F03 — General Ledger (ADR-035 D4). Exact-decimal money arithmetic.
 *
 * **Summation and equality for the double-entry check, ledger balances
 * and the trial balance are done in PostgreSQL `NUMERIC`** (SQL-side
 * `SUM(...)` / comparison) — NOT here. This module is used ONLY for the
 * one computation that cannot be pushed to SQL: converting a line's
 * transaction amount to the functional currency:
 *
 *     functionalAmount = round(transactionAmount × exchangeRateUsed,
 *                              currency.decimalPlaces, currency.roundingMode)
 *
 * `decimal.js` (pinned 10.6.0, MIT, zero deps, no install scripts —
 * reviewed per `DEPENDENCY_SECURITY_POLICY.md` §1) gives exact decimal
 * multiplication and the three rounding modes F01's `Currency` supports.
 * JavaScript `number` / `parseFloat` / `.toFixed()` are never used as the
 * basis of any ledger equality or balance (ADR-035 D4).
 */

const ROUNDING_MODE_MAP: Record<CurrencyRoundingMode, Decimal.Rounding> = {
  half_up: Decimal.ROUND_HALF_UP,
  half_even: Decimal.ROUND_HALF_EVEN,
  half_down: Decimal.ROUND_HALF_DOWN,
};

/** `true` iff `s` is a finite, non-negative decimal string (no NaN/Infinity, no sign tricks). */
export function isNonNegativeAmount(s: string): boolean {
  if (typeof s !== 'string' || s.trim() === '') return false;
  try {
    const d = new Decimal(s);
    return d.isFinite() && d.gte(0);
  } catch {
    return false;
  }
}

/** `true` iff `s` is a finite, strictly-positive decimal string. */
export function isPositiveAmount(s: string): boolean {
  return isNonNegativeAmount(s) && new Decimal(s).gt(0);
}

/**
 * The functional-currency amount for one journal line.
 * `exchangeRateUsed` is `'1'` when the transaction currency IS the
 * functional currency — there is no special-cased skip path (F01 §3.7),
 * so `1 × amount` still flows through here and is still rounded to the
 * functional currency's precision.
 */
export function computeFunctionalAmount(
  transactionAmount: string,
  exchangeRateUsed: string,
  functionalDecimalPlaces: number,
  functionalRoundingMode: CurrencyRoundingMode,
): string {
  const product = new Decimal(transactionAmount).times(new Decimal(exchangeRateUsed));
  return product.toFixed(functionalDecimalPlaces, ROUNDING_MODE_MAP[functionalRoundingMode]);
}

/** Normalise a client-supplied amount string to a fixed number of decimal places (storage form). */
export function normaliseAmount(s: string, decimalPlaces: number): string {
  return new Decimal(s).toFixed(decimalPlaces);
}

/** Exact equality of two decimal strings (used only in tests / assertions, never as the posting gate — that is SQL). */
export function amountsEqual(a: string, b: string): boolean {
  return new Decimal(a).eq(new Decimal(b));
}
