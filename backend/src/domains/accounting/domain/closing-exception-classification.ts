import { ClosingExceptionCategory, ClosingExceptionSeverity } from './closing-exception';

/**
 * ADR-051 §3 (Month-End Closing / Black Box, Phase 1). The classification
 * policy replacing ADR-050's blanket `REJECTED = INFORMATIONAL` rule.
 * Versioned, code-reviewed data — deliberately NOT exposed through
 * `ConfigurationEngineService` (Study §2.4): these patterns encode an
 * accounting judgment about what a rejection means, not an operational
 * parameter. Adding or changing a pattern here is a source-code change,
 * reviewed like any other.
 *
 * Two independent classifiers below, matching the two kinds of finding the
 * Closing Audit produces (Study §2.1): a reconciliation result never has a
 * "reason string" to pattern-match — its severity is a direct function of
 * its own three-valued status. A rejected financial event's classification
 * DOES depend on inspecting its reason text, because a `REJECTED` status
 * alone carries no information about whether a real financial effect is
 * missing.
 */

export interface ReconciliationClassification {
  category: Extract<ClosingExceptionCategory, 'LIVE_DISCREPANCY' | 'DORMANT_SOURCE'>;
  severity: ClosingExceptionSeverity;
  requiredAction: string;
}

/**
 * Accepts each reconciliation run entity's own (broader) `status` union
 * — `open`/`closed` are a DIFFERENT axis (whether a human later closed the
 * reconciliation record) and can never be the value `reconcile()` itself
 * just returned, but are included here so this function type-checks
 * directly against every entity's `.status` field without a cast at the
 * call site. Defensively treated as "not a fresh finding."
 */
export function classifyReconciliationStatus(
  status: 'matched' | 'drift_found' | 'no_subledger_source' | 'no_valuation_source' | 'open' | 'closed',
): ReconciliationClassification | null {
  if (status === 'matched' || status === 'open' || status === 'closed') return null; // not an exception at all
  if (status === 'drift_found') {
    return {
      category: 'LIVE_DISCREPANCY',
      severity: 'blocking',
      requiredAction: "Investigate the drift, post an approved correcting entry via the domain's own adjustment service, then re-run the Closing Audit.",
    };
  }
  return {
    category: 'DORMANT_SOURCE',
    severity: 'informational',
    requiredAction: 'None to close. This domain’s operational contract is not yet bound — informational only, not evidence of a mismatch.',
  };
}

export interface FinancialEventRejectionClassification {
  category: Extract<
    ClosingExceptionCategory,
    'EXPECTED_BUSINESS_REJECTION' | 'CONFIGURATION_EXCEPTION' | 'UNCLASSIFIED_REJECTION'
  >;
  severity: ClosingExceptionSeverity;
  requiredAction: string;
}

/**
 * Ordered pattern rules, first match wins. Deliberately small: everything
 * that does not match a NAMED, reviewed pattern falls through to
 * `UNCLASSIFIED_REJECTION` (blocking, fail-safe) — the fail-safe default
 * is the entire point of replacing the old blanket rule (Study §2.2's
 * `UNCLASSIFIED_REJECTION` row). `HISTORICAL_TEST_ARTIFACT` is deliberately
 * NOT reachable from this function at all — it is only ever set via an
 * explicit, individual, permissioned annotation (ADR-051 §3), never
 * inferred from a reason string, however old or test-looking it appears.
 */
const EXPECTED_BUSINESS_REJECTION_PATTERNS: RegExp[] = [
  /^negative_on_hand$/,
];

const CONFIGURATION_EXCEPTION_PATTERNS: RegExp[] = [
  /account is unset/i,
  /account is not gl-mapped/i,
  /account.*unresolved \(unset\)/i,
];

export function classifyRejectedFinancialEvent(rejectionReason: string | null): FinancialEventRejectionClassification {
  const reason = rejectionReason ?? '';

  if (EXPECTED_BUSINESS_REJECTION_PATTERNS.some((p) => p.test(reason))) {
    return {
      category: 'EXPECTED_BUSINESS_REJECTION',
      severity: 'informational',
      requiredAction: 'None to close. The system correctly refused to post an invalid operational transaction — nothing should exist in the GL for this event.',
    };
  }

  if (CONFIGURATION_EXCEPTION_PATTERNS.some((p) => p.test(reason))) {
    return {
      category: 'CONFIGURATION_EXCEPTION',
      severity: 'blocking',
      requiredAction: 'Fix the configuration via its legitimate mechanism, then explicitly redrive this specific event, then re-run the Closing Audit.',
    };
  }

  return {
    category: 'UNCLASSIFIED_REJECTION',
    severity: 'blocking',
    requiredAction: 'Investigate. Either this fits an existing category (propose a reviewed pattern-list change), or it is a genuine defect needing a real fix. Never assumed safe by default.',
  };
}
