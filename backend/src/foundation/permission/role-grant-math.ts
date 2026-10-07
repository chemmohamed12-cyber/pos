import { ancestorChain } from '../authorization/authorization-context';
import { CRITICAL_NODES } from './permission-risk';
import { PermissionAccess } from './role-permission.entity';

/**
 * Pure grant math shared by the role-management and user-management services (no I/O). Semantics are the Permission Engine's: along the node's ancestor
 * chain the MOST SPECIFIC grant of a role wins; across roles the most permissive wins; nothing granted = `hidden`.
 */
export interface Grant {
  node: string;
  access: PermissionAccess;
}

const RANK: Record<PermissionAccess, number> = { hidden: 0, 'read-only': 1, editable: 2 };

/** The effective level a SINGLE role's grants give a node (most specific ancestor wins). */
export function effectiveLevel(grants: readonly Grant[], node: string): PermissionAccess {
  const byNode = new Map(grants.map((g) => [g.node, g.access] as const));
  for (const key of ancestorChain(node)) {
    const level = byNode.get(key);
    if (level) return level;
  }
  return 'hidden';
}

/** The critical nodes this grant set reaches at `editable` (a module-wide grant covers every critical node below it). */
export function criticalNodesCovered(grants: readonly Grant[]): string[] {
  return CRITICAL_NODES.filter((n) => RANK[effectiveLevel(grants, n)] >= RANK.editable);
}

export function atLeast(level: PermissionAccess, required: PermissionAccess): boolean {
  return RANK[level] >= RANK[required];
}
