/**
 * Exact quantity presentation for the BOM screen (UX redesign stage 3). Quantities are typed as decimals in a unit; the server converts them EXACTLY to whole base units
 * (S2 / D-ME-2). These helpers mirror that arithmetic with BigInt so the user sees the stored equivalent BEFORE saving and gets safe, exact suggestions - never a rounded guess.
 * No new unit semantics: a product's unit is its integer base unit and `factor` is "base units per larger unit" exactly as the conversion table stores it.
 */
export interface Parsed {
  /** all digits of the number without the decimal point */
  digits: bigint;
  /** number of decimals typed */
  scale: number;
}

export function parseDecimal(raw: string): Parsed | null {
  const s = raw.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [i, f = ''] = s.split('.');
  return { digits: BigInt(i + f), scale: f.length };
}

export type BaseResult =
  | { kind: 'invalid' }
  | { kind: 'zero' }
  | { kind: 'whole'; base: string }
  /** the typed amount does not land on a whole number of base units: the two nearest whole counts, both exact */
  | { kind: 'fraction'; below: string; above: string };

/** `raw` is a decimal quantity in a unit worth `factor` base units (1 for the base unit itself). */
export function toBase(raw: string, factor: number): BaseResult {
  const p = parseDecimal(raw);
  if (!p) return { kind: 'invalid' };
  if (p.digits === 0n) return { kind: 'zero' };
  const num = p.digits * BigInt(factor);
  const den = 10n ** BigInt(p.scale);
  if (num % den === 0n) return { kind: 'whole', base: (num / den).toString() };
  const below = num / den;
  return { kind: 'fraction', below: below.toString(), above: (below + 1n).toString() };
}
