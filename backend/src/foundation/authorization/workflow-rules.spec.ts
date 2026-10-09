import { AuthorizationContext } from './authorization-context';
import { WORKFLOW_RULES, WORKFLOW_RULE_BY_NODE, WORKFLOW_NODES, rolesGrantedFor } from './workflow-rules';
import { WorkflowAccess, legacyDecision, WORKFLOW_DIVERGENCE } from './workflow-access';
import { WorkflowCapabilityGrants1790009000000 } from '../../database/migrations/core/1790009000000-WorkflowCapabilityGrants';

/**
 * Authorization Foundation F5 — the CAPABILITY DIFF proof (success condition: Capability Diff = empty).
 *
 * For every combination of the legacy role keys a user can hold and for every workflow rule, the decision taken from the migrated capability grants must equal the
 * decision the pre-F5 call site took (`admin` OR one of the declared roles). The grants are derived exactly the way the migration derives them (a role receives the
 * nodes whose legacy list names its key; `admin` receives all), from the migration's own frozen snapshot, so a drift between `workflow-rules.ts` and the migration
 * fails here too.
 */
const LEGACY_ROLE_KEYS = ['admin', 'sales_rep', 'sales_supervisor', 'sales_manager', 'finance', 'warehouse_worker', 'warehouse_supervisor', 'inventory_controller', 'driver'];

function migrationSnapshot(): Array<[string, string[]]> {
  return (new WorkflowCapabilityGrants1790009000000() as unknown as { rules: Array<[string, string[]]> }).rules;
}

function grantsFor(keys: string[]) {
  const snapshot = migrationSnapshot();
  const roles = keys.map((k) => ({ id: `role-${k}`, key: k }));
  const grants = roles.flatMap((r) =>
    snapshot.filter(([, legacy]) => [...new Set([...legacy, 'admin'])].includes(r.key)).map(([node]) => ({ roleId: r.id, nodeKey: node, access: 'editable' as const })),
  );
  return new AuthorizationContext('u1', 'c1', roles, grants);
}

describe('F5 workflow rules — Capability Diff = empty', () => {
  it('the migration snapshot is exactly the rule map (node, legacy roles) — no drift, except the ONE node later reclassified out of the workflow namespace', () => {
    const fromRules = WORKFLOW_RULES.map((r) => [r.node, [...r.legacyRoles]] as [string, string[]]);
    // CTO ruling B1 (2026-10-08): `wf.core.organization.manage` became the Company administration node `core.company.organization.manage`
    // (migration 1790013000000 moves every grant). The F5 migration is committed history and stays frozen; this is the only permitted difference.
    const RECLASSIFIED: Array<[string, string[]]> = [['wf.core.organization.manage', []]];
    const reclassifiedNodes = new Set(RECLASSIFIED.map(([n]) => n));
    expect(migrationSnapshot().filter(([n]) => reclassifiedNodes.has(n))).toEqual(RECLASSIFIED);
    expect(migrationSnapshot().filter(([n]) => !reclassifiedNodes.has(n))).toEqual(fromRules);
    expect(WORKFLOW_NODES.filter((n) => reclassifiedNodes.has(n))).toEqual([]); // no rule reads a reclassified node any more
    expect(new Set(WORKFLOW_NODES).size).toBe(WORKFLOW_NODES.length); // unique nodes
    expect(new Set(WORKFLOW_RULES.map((r) => r.key)).size).toBe(WORKFLOW_RULES.length); // unique keys
  });

  it('every rule node lives in the wf.* namespace, outside every module prefix', () => {
    for (const r of WORKFLOW_RULES) {
      expect(r.node.startsWith('wf.')).toBe(true);
      expect(WORKFLOW_RULE_BY_NODE.get(r.node)).toBe(r);
    }
  });

  it('legacy decision == capability decision for ALL 512 role combinations x every rule (zero divergence)', () => {
    let checked = 0;
    for (let mask = 0; mask < 1 << LEGACY_ROLE_KEYS.length; mask++) {
      const keys = LEGACY_ROLE_KEYS.filter((_, i) => mask & (1 << i));
      const ctx = grantsFor(keys);
      for (const rule of WORKFLOW_RULES) {
        const legacy = legacyDecision(rule, keys);
        const capability = ctx.hasAtLeast(rule.node, rule.access);
        if (legacy !== capability) throw new Error(`DIVERGENCE rule=${rule.key} roles=[${keys.join(',')}] legacy=${legacy} capability=${capability}`);
        checked++;
      }
    }
    expect(checked).toBe(512 * WORKFLOW_RULES.length);
  });

  it('a user with NO legacy role holds no workflow capability (deny by default)', () => {
    const ctx = grantsFor([]);
    for (const rule of WORKFLOW_RULES) expect(ctx.hasAtLeast(rule.node, 'read-only')).toBe(false);
  });

  it('read-only on a wf node is not enough (rules need editable)', () => {
    const rule = WORKFLOW_RULES[0];
    const ctx = new AuthorizationContext('u', 'c', [{ id: 'r', key: 'custom' }], [{ roleId: 'r', nodeKey: rule.node, access: 'read-only' }]);
    expect(new WorkflowAccess(ctx, 'capability').allows(rule.key)).toBe(false);
  });

  it('a role designed by the Company (any key) that is granted the node passes in capability mode but not in legacy mode', () => {
    const rule = WORKFLOW_RULES.find((r) => r.key === 'sales.order.supervisor_approve')!;
    const ctx = new AuthorizationContext('u', 'c', [{ id: 'r', key: 'my_custom_role' }], [{ roleId: 'r', nodeKey: rule.node, access: 'editable' }]);
    expect(new WorkflowAccess(ctx, 'capability').allows(rule.key)).toBe(true);
    expect(new WorkflowAccess(ctx, 'legacy').allows(rule.key)).toBe(false);
    expect(new WorkflowAccess(ctx, 'dual').allows(rule.key)).toBe(true); // dual only ever ADDS to legacy
  });

  it('dual never removes a legacy permission; capability mode removes the legacy leg (a bare legacy key without the grant is denied)', () => {
    const rule = WORKFLOW_RULES.find((r) => r.key === 'sales.order.supervisor_approve')!;
    const bare = new AuthorizationContext('u', 'c', [{ id: 'r', key: 'sales_supervisor' }], []); // key held, grant removed by the Company
    expect(new WorkflowAccess(bare, 'legacy').allows(rule.key)).toBe(true);
    expect(new WorkflowAccess(bare, 'dual').allows(rule.key)).toBe(true);
    expect(new WorkflowAccess(bare, 'capability').allows(rule.key)).toBe(false);
  });

  it('dual mode counts every disagreement', () => {
    WORKFLOW_DIVERGENCE.clear();
    const rule = WORKFLOW_RULES.find((r) => r.key === 'sales.order.supervisor_approve')!;
    const bare = new AuthorizationContext('u', 'c', [{ id: 'r', key: 'sales_supervisor' }], []);
    new WorkflowAccess(bare, 'dual').allows(rule.key);
    expect(WORKFLOW_DIVERGENCE.get(rule.key)).toEqual({ total: 1, legacyOnly: 1, capabilityOnly: 0 });
  });

  it('an unknown rule is a programming error, never a silent allow', () => {
    expect(() => new WorkflowAccess(grantsFor(['admin']), 'capability').allows('nope.nothing')).toThrow('Unknown workflow rule');
  });

  it('rolesGrantedFor always includes admin', () => {
    for (const r of WORKFLOW_RULES) expect(rolesGrantedFor(r)).toContain('admin');
  });
});
