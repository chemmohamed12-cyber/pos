/** One-way, like Warehouse's posted state — a posted ledger row is never edited, only reversed (a new offsetting row + this flag). */
export type TreasuryTransactionStatus = 'posted' | 'reversed';

const ALLOWED_TRANSITIONS: Record<TreasuryTransactionStatus, TreasuryTransactionStatus[]> = {
  posted: ['reversed'],
  reversed: [],
};

export function canTransitionTreasuryTransactionStatus(from: TreasuryTransactionStatus, to: TreasuryTransactionStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}
