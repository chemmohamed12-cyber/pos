/**
 * ADR-051 (Month-End Closing / Black Box, Phase 1). `ClosingException`
 * shared types — Study §2.1's split between the gate-relevant `severity`
 * and the root-cause `category` (originally six values, ADR-051 §3;
 * `TRANSIENT_DATABASE_ERROR` added per the F03 GL Posting Concurrency RCA
 * (`docs/studies/F03_GL_POSTING_CONCURRENCY_DEADLOCK_RCA.md`) Option C,
 * CTO-approved 2026-09-21 alongside Option B's automatic deadlock retry —
 * a pure addition to this already-ratified pattern-list mechanism, not a
 * change to any of the other six categories' own meaning or governance).
 */
export const CLOSING_EXCEPTION_CATEGORIES = [
  'LIVE_DISCREPANCY',
  'DORMANT_SOURCE',
  'EXPECTED_BUSINESS_REJECTION',
  'CONFIGURATION_EXCEPTION',
  'HISTORICAL_TEST_ARTIFACT',
  'TRANSIENT_DATABASE_ERROR',
  'UNCLASSIFIED_REJECTION',
] as const;
export type ClosingExceptionCategory = (typeof CLOSING_EXCEPTION_CATEGORIES)[number];

export const CLOSING_EXCEPTION_SEVERITIES = ['blocking', 'informational'] as const;
export type ClosingExceptionSeverity = (typeof CLOSING_EXCEPTION_SEVERITIES)[number];

/**
 * `waived` is a defined value for forward schema compatibility only —
 * ADR-051 §2: no V1 code path may set it (Study §5 Decision 1, no
 * override/waiver mechanism in V1). Enforced in the service layer
 * (Phase 2), not by the type system alone.
 */
export const CLOSING_EXCEPTION_STATUSES = ['open', 'acknowledged', 'resolved', 'waived'] as const;
export type ClosingExceptionStatus = (typeof CLOSING_EXCEPTION_STATUSES)[number];

export type ClosingExceptionModule = 'ap' | 'ar' | 'cash_bank' | 'inventory' | 'fixed_asset' | 'financial_events' | 'grni' | 'wip';

export interface ClosingExceptionFinding {
  module: ClosingExceptionModule;
  documentType: string | null;
  documentId: string | null;
  transactionRef: string | null;
  accountOrSubledgerRef: string | null;
  amount: string | null;
  source: string;
  category: ClosingExceptionCategory;
  severity: ClosingExceptionSeverity;
  problem: string;
  requiredAction: string;
}
