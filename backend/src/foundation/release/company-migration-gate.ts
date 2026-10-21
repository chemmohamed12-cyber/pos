import type { CompanyFanoutMode, CompanyFanoutPlan, SkippedCompany } from './company-fanout.service';
import { CompanySchemaCheckResult, hasFindings, summarizeFindings } from './company-schema-check';

/**
 * Company migration gate (CTO 2026-10-21 - Company Migration Reliability & Recovery). PURE decision logic: no I/O, no clock, so every rule is exhaustively
 * testable and the Release Engine cannot reach the atomic swap without passing through it.
 *
 * THE RULE: a release is never swapped in, and never reported successful, while a Company database that is in scope still needs migrations, is not what the new
 * code queries (schema drift), or cannot be evaluated. "Platform at 320, one Company at 315" can therefore not be reported as a successful release.
 *
 * Four distinct situations the CTO listed, and where each is caught:
 *   1. missing migration            -> `pending` per Company (plan, then re-derived after the migration step)
 *   2. schema drift                 -> read-only schema check against the candidate's entity registry (plan, then again after migration)
 *   3. incompatible/unknown history -> the migration preflight (BLOCKED before anything is changed) and the fan-out plan blockers
 *   4. Company outside the plan     -> non-READY Companies are reported as STALE and BLOCK by default (DECOMMISSIONED = out of scope)
 */
export type CompanyGateDecisionKind = 'PASS' | 'BLOCKED' | 'PLAN_ONLY';

export interface CompanyGateInput {
  mode: CompanyFanoutMode;
  plan: CompanyFanoutPlan;
  skippedPolicy: 'block' | 'allow';
  schemaCheck: 'enforce' | 'report';
}

export interface CompanyGateDecision {
  decision: CompanyGateDecisionKind;
  /** Reasons the deploy must not proceed (empty for PASS). In PLAN_ONLY they are what WOULD block a real deploy. */
  blockers: string[];
  /** Things the operator must see but that do not block. */
  warnings: string[];
  /** Non-READY, non-DECOMMISSIONED Companies that will run the new code on the old schema until caught up. */
  staleCompanies: SkippedCompany[];
  counts: { evaluated: number; needingMigration: number; withSchemaFindings: number; withUnknownMigrations: number; staleSkipped: number; outOfScope: number };
}

const names = (xs: string[], cap = 10) => xs.slice(0, cap).join(', ') + (xs.length > cap ? `, … (+${xs.length - cap})` : '');

export function evaluateCompanyGate(input: CompanyGateInput): CompanyGateDecision {
  const { mode, plan, skippedPolicy, schemaCheck } = input;
  const blockers: string[] = [];
  const warnings: string[] = [];

  // 3. a READY Company that could not even be looked at
  for (const b of plan.blockers) blockers.push(b);

  // 4. Companies the plan could not include
  const stale = plan.skipped.filter((s) => s.scope !== 'out_of_scope');
  const outOfScope = plan.skipped.filter((s) => s.scope === 'out_of_scope');
  if (stale.length > 0) {
    const text = `${stale.length} Company(ies) are not READY and cannot be migrated now: ${names(stale.map((s) => `${s.companyName ?? s.companyId} (${s.status ?? 'no Company row'})`))}. They would run the new code on the old schema once reactivated`;
    if (skippedPolicy === 'block') blockers.push(`${text}. Reactivate or decommission them, or set RELEASE_COMPANY_SKIPPED_POLICY=allow to deploy with each one recorded as STALE`);
    else warnings.push(`${text}. RELEASE_COMPANY_SKIPPED_POLICY=allow: recorded as STALE - catch each one up BEFORE it is reactivated`);
  }

  // 1. missing migrations
  const needing = plan.planned.filter((c) => c.pending.length > 0);
  if (mode === 'off' && needing.length > 0) {
    blockers.push(
      `COMPANY_MIGRATIONS_REQUIRED_BUT_DISABLED: RELEASE_COMPANY_MIGRATIONS=off but ${needing.length} Company(ies) need migrations: ` +
        `${names(needing.map((c) => `${c.companyName} (${c.pending.length})`))}. A release that leaves a Company on the old schema is refused; set RELEASE_COMPANY_MIGRATIONS=on (or unset it)`,
    );
  }

  // 3. incompatible history: migrations recorded in a Company database that the candidate does not ship (ahead of the candidate, or divergent)
  const withUnknown = plan.planned.filter((c) => (c.unknownMigrations?.length ?? 0) > 0);
  if (withUnknown.length > 0) {
    const text = `COMPANY_HISTORY_UNKNOWN: ${withUnknown.length} Company(ies) have migrations recorded that this release does not ship (the database is ahead of, or diverges from, this release): ${names(withUnknown.map((c) => `${c.companyName} (${c.unknownMigrations!.slice(0, 3).join(', ')}${c.unknownMigrations!.length > 3 ? ', …' : ''})`))}`;
    if (schemaCheck === 'enforce') blockers.push(text);
    else warnings.push(`${text} (RELEASE_COMPANY_SCHEMA_CHECK=report: recorded, not blocking)`);
  }

  // 2. schema drift / unverifiable schema
  let withFindings = 0;
  const unrunnable: string[] = [];
  const drift: string[] = [];
  for (const c of plan.planned) {
    const s = c.schema;
    if (!s || !s.ran) {
      unrunnable.push(`${c.companyName}${s?.error ? ` (${s.error.slice(0, 80)})` : ''}`);
      continue;
    }
    if (hasFindings(s.findings)) {
      withFindings += 1;
      // A Company that still has pending migrations is EXPECTED to differ before them: the migration step is what fixes it, and it is re-checked afterwards.
      // A Company with NOTHING pending that still differs has drift no migration will repair.
      if (c.pending.length === 0) drift.push(`${c.companyName}: ${JSON.stringify(summarizeFindings(s.findings, 5))}`);
    }
  }
  if (drift.length > 0) {
    const text = `schema drift in ${drift.length} Company(ies) that have no pending migrations (the migration list is complete but the schema is not what the new code queries): ${drift.join(' | ')}`;
    if (schemaCheck === 'enforce') blockers.push(text);
    else warnings.push(`${text} (RELEASE_COMPANY_SCHEMA_CHECK=report: recorded, not blocking)`);
  }
  if (unrunnable.length > 0) {
    const text = `the schema check could not run for ${unrunnable.length} Company(ies): ${names(unrunnable)}. An unverified schema is never treated as clean`;
    if (schemaCheck === 'enforce') blockers.push(text);
    else warnings.push(`${text} (RELEASE_COMPANY_SCHEMA_CHECK=report)`);
  }

  const counts = {
    evaluated: plan.planned.length,
    needingMigration: needing.length,
    withSchemaFindings: withFindings,
    withUnknownMigrations: withUnknown.length,
    staleSkipped: stale.length,
    outOfScope: outOfScope.length,
  };
  const decision: CompanyGateDecisionKind = mode === 'dry-run' ? 'PLAN_ONLY' : blockers.length > 0 ? 'BLOCKED' : 'PASS';
  return { decision, blockers, warnings, staleCompanies: stale, counts };
}

/**
 * The independent post-migration conditions, re-derived from the databases (never from the migration step's own report). Any entry => the swap must not happen.
 */
export function evaluatePostMigrationGate(
  stillPending: Record<string, string[]>,
  schemaAfter: Record<string, CompanySchemaCheckResult>,
  schemaCheck: 'enforce' | 'report',
): { blockers: string[]; warnings: string[] } {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const pendingNames = Object.keys(stillPending);
  if (pendingNames.length > 0) {
    blockers.push(`Company fan-out reported success but ${pendingNames.length} Company(ies) still have pending migrations: ${JSON.stringify(stillPending)}`);
  }
  const bad: string[] = [];
  const unrunnable: string[] = [];
  for (const [company, s] of Object.entries(schemaAfter)) {
    if (!s.ran) unrunnable.push(`${company}${s.error ? ` (${s.error.slice(0, 80)})` : ''}`);
    else if (hasFindings(s.findings)) bad.push(`${company}: ${JSON.stringify(summarizeFindings(s.findings, 5))}`);
  }
  const push = (text: string) => (schemaCheck === 'enforce' ? blockers.push(text) : warnings.push(`${text} (RELEASE_COMPANY_SCHEMA_CHECK=report)`));
  if (bad.length > 0) push(`after the migration step ${bad.length} Company(ies) still do not match the new code's schema: ${bad.join(' | ')}`);
  if (unrunnable.length > 0) push(`the post-migration schema check could not run for ${unrunnable.length} Company(ies): ${names(unrunnable)}`);
  return { blockers, warnings };
}
