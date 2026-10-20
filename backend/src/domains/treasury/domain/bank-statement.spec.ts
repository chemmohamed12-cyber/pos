import { lineFingerprint, reconciliationDifference, scoreCandidate, statementFileHash, suggestFor, MatchCandidate, StatementLineInput } from './bank-statement';

const cand = (over: Partial<MatchCandidate> = {}): MatchCandidate => ({ transactionId: 't1', transactionNumber: 'TRS-IN-2026-000001', movementDate: '2026-10-10', signedAmount: '500.00', reference: 'CHQ-77', ...over });
const line = (over: Partial<StatementLineInput> = {}): StatementLineInput => ({ valueDate: '2026-10-11', description: 'Cheque deposit CHQ-77', reference: 'CHQ-77', amount: '500.00', ...over });

describe('bank statement matching rules (pure)', () => {
  it('an amount that differs by even one cent is not a candidate', () => {
    expect(scoreCandidate(line({ amount: '500.01' }), cand())).toBeNull();
  });
  it('a value date outside the window is not a candidate', () => {
    expect(scoreCandidate(line({ valueDate: '2026-10-20' }), cand())).toBeNull();
    expect(scoreCandidate(line({ valueDate: '2026-10-15' }), cand())).not.toBeNull();
  });
  it('amount + reference + near date scores as a confident candidate, amount alone does not', () => {
    expect(scoreCandidate(line(), cand())!.score).toBeGreaterThanOrEqual(90);
    expect(scoreCandidate(line({ reference: null, description: 'transfer' }), cand())!.score).toBeLessThan(90);
  });
  it('a single strong candidate is only SUGGESTED (never confirmed); none is unmatched; several equal candidates are ambiguous', () => {
    expect(suggestFor(line(), [cand()]).outcome).toBe('suggested');
    expect(suggestFor(line(), []).outcome).toBe('unmatched');
    const two = suggestFor(line({ reference: null, description: 'cash' }), [cand({ transactionId: 'a', reference: null }), cand({ transactionId: 'b', reference: null })]);
    expect(two.outcome).toBe('ambiguous');
    expect(two.candidates).toHaveLength(2);
  });
  it('two candidates with the same amount but only ONE matching reference: the referenced one wins and is suggested', () => {
    const s = suggestFor(line(), [cand({ transactionId: 'a', reference: 'OTHER' }), cand({ transactionId: 'b', reference: 'CHQ-77' })]);
    expect(s.outcome).toBe('suggested');
    expect(s.candidates[0].transactionId).toBe('b');
  });
  it('the same file hashes identically however it is re-saved (whitespace, order of keys) and a different amount changes it', () => {
    const a = statementFileHash('acc', '2026-10-01', '2026-10-31', '1000.00', '1500.00', [line()]);
    const b = statementFileHash('acc', '2026-10-01', '2026-10-31', '1000.0', '1500', [{ ...line(), description: '  Cheque deposit CHQ-77 ' }]);
    expect(a).toBe(b);
    expect(statementFileHash('acc', '2026-10-01', '2026-10-31', '1000.00', '1500.00', [line({ amount: '499.99' })])).not.toBe(a);
  });
  it('line fingerprints are stable per account and differ across accounts', () => {
    expect(lineFingerprint('a', line())).toBe(lineFingerprint('a', line()));
    expect(lineFingerprint('a', line())).not.toBe(lineFingerprint('b', line()));
  });
  it('reconciliation arithmetic: outstanding book items and unrecorded bank items are the only reconciling items', () => {
    // bank closing 10_000; book 10_300 because a 300 deposit is in transit... book includes it, bank does not → bank + 300 = book
    expect(reconciliationDifference({ closingBalance: '10000.00', bookBalanceAtPeriodEnd: '10300.00', outstandingBookNet: '300.00', bankOnlyNet: '0.00' }).difference).toBe('0.00');
    // the bank charged a 25 fee the book does not have yet: book + (-25) = bank
    expect(reconciliationDifference({ closingBalance: '9975.00', bookBalanceAtPeriodEnd: '10000.00', outstandingBookNet: '0.00', bankOnlyNet: '-25.00' }).difference).toBe('0.00');
    // an unexplained difference is reported, not hidden
    expect(reconciliationDifference({ closingBalance: '9000.00', bookBalanceAtPeriodEnd: '10000.00', outstandingBookNet: '0.00', bankOnlyNet: '0.00' }).difference).toBe('-1000.00');
  });
});
