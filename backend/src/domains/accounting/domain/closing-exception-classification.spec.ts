import { classifyReconciliationStatus, classifyRejectedFinancialEvent } from './closing-exception-classification';

describe('classifyReconciliationStatus (ADR-051 §3)', () => {
  it('matched → no exception at all', () => {
    expect(classifyReconciliationStatus('matched')).toBeNull();
  });

  it('drift_found → LIVE_DISCREPANCY, blocking', () => {
    const result = classifyReconciliationStatus('drift_found');
    expect(result).not.toBeNull();
    expect(result!.category).toBe('LIVE_DISCREPANCY');
    expect(result!.severity).toBe('blocking');
  });

  it('no_subledger_source → DORMANT_SOURCE, informational', () => {
    const result = classifyReconciliationStatus('no_subledger_source');
    expect(result!.category).toBe('DORMANT_SOURCE');
    expect(result!.severity).toBe('informational');
  });

  it('no_valuation_source → DORMANT_SOURCE, informational', () => {
    const result = classifyReconciliationStatus('no_valuation_source');
    expect(result!.category).toBe('DORMANT_SOURCE');
    expect(result!.severity).toBe('informational');
  });
});

describe('classifyRejectedFinancialEvent (ADR-051 §3 — replaces the ADR-050 blanket rule)', () => {
  it('negative_on_hand → EXPECTED_BUSINESS_REJECTION, informational', () => {
    const result = classifyRejectedFinancialEvent('negative_on_hand');
    expect(result.category).toBe('EXPECTED_BUSINESS_REJECTION');
    expect(result.severity).toBe('informational');
  });

  it('an unset-account reason → CONFIGURATION_EXCEPTION, blocking', () => {
    const result = classifyRejectedFinancialEvent(
      'inventory movement: COGS account is unset — set accounting.inventory_cogs_account_code to a postable non-control GL account',
    );
    expect(result.category).toBe('CONFIGURATION_EXCEPTION');
    expect(result.severity).toBe('blocking');
  });

  it('a not-GL-mapped reason → CONFIGURATION_EXCEPTION, blocking', () => {
    const result = classifyRejectedFinancialEvent('deposit.verified: treasury account is not GL-mapped');
    expect(result.category).toBe('CONFIGURATION_EXCEPTION');
    expect(result.severity).toBe('blocking');
  });

  it('an unresolved-account reason → CONFIGURATION_EXCEPTION, blocking', () => {
    const result = classifyRejectedFinancialEvent('fixed asset disposal: gain-on-disposal account unresolved (unset)');
    expect(result.category).toBe('CONFIGURATION_EXCEPTION');
    expect(result.severity).toBe('blocking');
  });

  it('a deadlock rejection → TRANSIENT_DATABASE_ERROR, blocking (F03 RCA Option C)', () => {
    const result = classifyRejectedFinancialEvent('posting gate rejected: deadlock detected');
    expect(result.category).toBe('TRANSIENT_DATABASE_ERROR');
    expect(result.severity).toBe('blocking');
    expect(result.requiredAction).toMatch(/redrive/i);
  });

  it('a serialization-failure rejection → TRANSIENT_DATABASE_ERROR, blocking', () => {
    const result = classifyRejectedFinancialEvent('posting gate rejected: could not serialize access due to concurrent update');
    expect(result.category).toBe('TRANSIENT_DATABASE_ERROR');
    expect(result.severity).toBe('blocking');
  });

  it('an orphaned master-data reference → UNCLASSIFIED_REJECTION, blocking (fail-safe, never auto-waved)', () => {
    const result = classifyRejectedFinancialEvent('draft build failed: Currency "F14" not found.');
    expect(result.category).toBe('UNCLASSIFIED_REJECTION');
    expect(result.severity).toBe('blocking');
  });

  it('an unrecognized reason defaults to UNCLASSIFIED_REJECTION, blocking (fail-safe default)', () => {
    const result = classifyRejectedFinancialEvent('something never seen before');
    expect(result.category).toBe('UNCLASSIFIED_REJECTION');
    expect(result.severity).toBe('blocking');
  });

  it('a null reason defaults to UNCLASSIFIED_REJECTION, blocking', () => {
    const result = classifyRejectedFinancialEvent(null);
    expect(result.category).toBe('UNCLASSIFIED_REJECTION');
    expect(result.severity).toBe('blocking');
  });
});
