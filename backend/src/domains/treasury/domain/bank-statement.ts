import { createHash } from 'crypto';

/**
 * T5 — bank statement domain rules (pure, database-free). A statement line is NEVER treated as reconciled merely because an amount matches: the matcher only SUGGESTS,
 * a person confirms, and the reconciliation closes only when the arithmetic proves bank and book agree.
 */
export type BankStatementStatus = 'imported' | 'reconciled';
export type BankLineStatus = 'unmatched' | 'suggested' | 'matched';

export interface StatementLineInput {
  valueDate: string;
  description?: string | null;
  reference?: string | null;
  /** SIGNED: positive = money into the account, negative = money out (as the bank shows it from the account holder's side). */
  amount: string;
}

export interface MatchCandidate {
  transactionId: string;
  transactionNumber: string;
  movementDate: string;
  signedAmount: string;
  reference: string | null;
}

export interface ScoredCandidate extends MatchCandidate {
  score: number;
  reasons: string[];
}

/** Days a bank value date may differ from the book movement date and still be a candidate. */
export const MATCH_DATE_WINDOW_DAYS = 5;

export function cents(v: string | number): number {
  return Math.round(Number(v) * 100);
}

export function dayDiff(a: string, b: string): number {
  return Math.abs(Math.round((Date.parse(a.slice(0, 10)) - Date.parse(b.slice(0, 10))) / 86_400_000));
}

/** Stable identity of a line, used to flag a line that already appears in another statement of the same account. */
export function lineFingerprint(accountId: string, l: StatementLineInput): string {
  return createHash('sha1').update([accountId, l.valueDate.slice(0, 10), cents(l.amount), (l.reference ?? '').trim().toLowerCase(), (l.description ?? '').trim().toLowerCase()].join('|')).digest('hex');
}

/** Identity of the whole file: the same statement imported twice (even from a re-saved file) hashes identically. */
export function statementFileHash(accountId: string, periodStart: string, periodEnd: string, opening: string, closing: string, lines: StatementLineInput[]): string {
  const canon = lines.map((l) => [l.valueDate.slice(0, 10), cents(l.amount), (l.reference ?? '').trim(), (l.description ?? '').trim()]);
  return createHash('sha256').update(JSON.stringify([accountId, periodStart, periodEnd, cents(opening), cents(closing), canon])).digest('hex');
}

/**
 * Candidate rule: the amount must match to the cent and the dates must fall within the window — otherwise it is not even a candidate. The score only ranks candidates;
 * it never confirms anything.
 */
export function scoreCandidate(line: StatementLineInput, c: MatchCandidate): ScoredCandidate | null {
  if (cents(line.amount) !== cents(c.signedAmount)) return null;
  const days = dayDiff(line.valueDate, c.movementDate);
  if (days > MATCH_DATE_WINDOW_DAYS) return null;
  let score = 50;
  const reasons = ['amount'];
  const ref = (line.reference ?? '').trim().toLowerCase();
  const cRef = (c.reference ?? '').trim().toLowerCase();
  const desc = (line.description ?? '').toLowerCase();
  if (ref && cRef && (ref === cRef || ref.includes(cRef) || cRef.includes(ref))) {
    score += 40;
    reasons.push('reference');
  } else if (cRef && desc.includes(cRef)) {
    score += 25;
    reasons.push('reference-in-description');
  } else if (desc.includes(c.transactionNumber.toLowerCase())) {
    score += 25;
    reasons.push('transaction-number-in-description');
  }
  if (days === 0) {
    score += 10;
    reasons.push('same-day');
  } else if (days <= 2) {
    score += 5;
    reasons.push('near-date');
  }
  return { ...c, score, reasons };
}

export interface Suggestion {
  /** `unmatched`: no candidate · `suggested`: exactly one strong candidate · `ambiguous`: several candidates, a person must choose. */
  outcome: 'unmatched' | 'suggested' | 'ambiguous';
  candidates: ScoredCandidate[];
}

/** Ranks the candidates; a single candidate with a reference match is a confident suggestion, anything else with candidates is ambiguous or weak (still only a suggestion). */
export function suggestFor(line: StatementLineInput, pool: MatchCandidate[]): Suggestion {
  const scored = pool.map((c) => scoreCandidate(line, c)).filter((x): x is ScoredCandidate => x !== null).sort((a, b) => b.score - a.score);
  if (scored.length === 0) return { outcome: 'unmatched', candidates: [] };
  if (scored.length === 1 && scored[0].score >= 90) return { outcome: 'suggested', candidates: scored };
  if (scored.length > 1 && scored[0].score >= 90 && scored[0].score - scored[1].score >= 25) return { outcome: 'suggested', candidates: scored.slice(0, 5) };
  return { outcome: 'ambiguous', candidates: scored.slice(0, 5) };
}

/**
 * The reconciliation proof. AdjustedBank = closing + book items the bank has not seen yet (deposits in transit +, outstanding payments −);
 * AdjustedBook = book balance + bank items the book does not have yet (fees / interest not recorded). Reconciled ⇔ the two are equal to the cent.
 */
export function reconciliationDifference(p: { closingBalance: string; bookBalanceAtPeriodEnd: string; outstandingBookNet: string; bankOnlyNet: string }): { adjustedBank: string; adjustedBook: string; difference: string } {
  const adjustedBank = cents(p.closingBalance) + cents(p.outstandingBookNet);
  const adjustedBook = cents(p.bookBalanceAtPeriodEnd) + cents(p.bankOnlyNet);
  return { adjustedBank: (adjustedBank / 100).toFixed(2), adjustedBook: (adjustedBook / 100).toFixed(2), difference: ((adjustedBank - adjustedBook) / 100).toFixed(2) };
}
