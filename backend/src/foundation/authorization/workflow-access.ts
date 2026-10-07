import { Logger } from '@nestjs/common';
import { AuthorizationContext } from './authorization-context';
import { WORKFLOW_RULE_BY_KEY, WorkflowRule } from './workflow-rules';

/**
 * Authorization Foundation F5 — how the legacy role decisions are being retired (Map → Dual-check → Migrate → Retire).
 *
 *  - `legacy`     : only the role-list decision (the pre-F5 behaviour; the rollback position);
 *  - `dual`       : role-list OR capability — a decision can only ADD access relative to legacy, never remove it, and every disagreement is counted;
 *  - `capability` : the capability alone (the target; the legacy leg is no longer authoritative).
 * The mode is read from `AUTHZ_WORKFLOW_MODE` on every decision so it can be flipped (or rolled back) with a restart and no deploy.
 */
export type WorkflowMode = 'legacy' | 'dual' | 'capability';

export const DEFAULT_WORKFLOW_MODE: WorkflowMode = 'capability';

export function currentWorkflowMode(): WorkflowMode {
  const v = process.env.AUTHZ_WORKFLOW_MODE;
  return v === 'legacy' || v === 'dual' || v === 'capability' ? v : DEFAULT_WORKFLOW_MODE;
}

export interface DivergenceCounter {
  total: number;
  /** legacy would allow, the capability does not (a user would LOSE this power when the legacy leg is retired). */
  legacyOnly: number;
  /** the capability allows, legacy would not (a user GAINS this power compared with the role lists). */
  capabilityOnly: number;
}

/** In-process counters of rule evaluations and disagreements since boot; exposed read-only through the platform audit surface. */
export const WORKFLOW_DIVERGENCE: Map<string, DivergenceCounter> = new Map();
const logger = new Logger('WorkflowAccess');
const lastLogged = new Map<string, number>();

function record(rule: WorkflowRule, userId: string, legacy: boolean, capability: boolean): void {
  const c = WORKFLOW_DIVERGENCE.get(rule.key) ?? { total: 0, legacyOnly: 0, capabilityOnly: 0 };
  c.total++;
  if (legacy && !capability) c.legacyOnly++;
  if (!legacy && capability) c.capabilityOnly++;
  WORKFLOW_DIVERGENCE.set(rule.key, c);
  if (legacy !== capability) {
    const now = Date.now();
    if (now - (lastLogged.get(rule.key) ?? 0) > 60_000) {
      lastLogged.set(rule.key, now);
      logger.warn(`workflow rule ${rule.key}: legacy=${legacy} capability=${capability} (user ${userId}) — role lists and capabilities disagree`);
    }
  }
}

/** The decision a pre-F5 call site made: the declared roles, or the legacy `admin` (every call site let `admin` through). */
export function legacyDecision(rule: WorkflowRule, roleKeys: readonly string[]): boolean {
  return roleKeys.includes('admin') || rule.legacyRoles.some((r) => roleKeys.includes(r));
}

/** What one user holds, with the workflow rules answered under the active mode. */
export class WorkflowAccess {
  constructor(
    readonly ctx: AuthorizationContext,
    private readonly mode: WorkflowMode = currentWorkflowMode(),
  ) {}

  get roles(): string[] {
    return this.ctx.roleKeys;
  }

  /** Does the user hold this legacy role KEY (designation checks that are not authorization, e.g. "is a sales rep")? */
  hasRole(key: string): boolean {
    return this.ctx.hasRole(key);
  }

  allows(ruleKey: string): boolean {
    const rule = WORKFLOW_RULE_BY_KEY.get(ruleKey);
    if (!rule) throw new Error(`Unknown workflow rule: ${ruleKey}`);
    return this.evaluate(rule);
  }

  /** True when ANY of the rules allows (an "OR" over several call-site lists, e.g. reviewer-or-finance). */
  allowsAny(...ruleKeys: string[]): boolean {
    return ruleKeys.some((k) => this.allows(k));
  }

  private evaluate(rule: WorkflowRule): boolean {
    const legacy = legacyDecision(rule, this.ctx.roleKeys);
    if (this.mode === 'legacy') return legacy;
    const capability = this.ctx.hasAtLeast(rule.node, rule.access);
    if (this.mode === 'dual') {
      record(rule, this.ctx.userId, legacy, capability);
      return legacy || capability;
    }
    return capability;
  }
}
