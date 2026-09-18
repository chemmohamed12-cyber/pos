/**
 * ADR-051 (Month-End Closing / Black Box, Phase 1). `ClosingException`
 * shared types — Study §2.1's split between the gate-relevant `severity`
 * and the root-cause `category` (six values, ADR-051 §3).
 */
export const CLOSING_EXCEPTION_CATEGORIES = [
  'LIVE_DISCREPANCY',
  'DORMANT_SOURCE',
  'EXPECTED_BUSINESS_REJECTION',
  'CONFIGURATION_EXCEPTION',
  'HISTORICAL_TEST_ARTIFACT',
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

export type ClosingExceptionModule = 'ap' | 'ar' | 'cash_bank' | 'inventory' | 'fixed_asset' | 'financial_events' | 'grni';

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
