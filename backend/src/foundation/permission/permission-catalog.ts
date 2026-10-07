import { MODULE_REGISTRY } from '../module-registry/module-registry';
import { MODULE_ROLE_TEMPLATES } from '../module-registry/role-templates';
import { NAVIGATION_REGISTRY } from '../navigation/navigation-registry';
import { COMPANY_ADMINISTRATION_NODES } from './company-nodes';
import { WORKFLOW_NODES, WORKFLOW_RULE_BY_NODE } from '../authorization/workflow-rules';

/**
 * Authorization Program F1.2 — the permission node UNIVERSE used to build `/auth/me.capabilities`.
 *
 * Built only from declarations that already exist (no new taxonomy, no rename): the module manifests' nodes (`MODULE_REGISTRY`, which also knows
 * the owning module and the titles), every node the sidebar gates on, and every node the role templates grant. `capabilities` is the effective
 * level of each of these for the current user — a UX hint; the backend re-verifies on every protected operation.
 */
let cache: readonly string[] | null = null;

export function permissionCatalogNodes(): readonly string[] {
  if (cache) return cache;
  const nodes = new Set<string>();
  for (const code of MODULE_REGISTRY.allModuleCodes()) for (const n of MODULE_REGISTRY.nodesForModule(code)) nodes.add(n);
  for (const g of NAVIGATION_REGISTRY) for (const i of g.items) if (i.permissionNode) nodes.add(i.permissionNode);
  for (const templates of Object.values(MODULE_ROLE_TEMPLATES)) for (const t of templates) for (const g of t.grants) nodes.add(g.node);
  for (const n of WORKFLOW_NODES) nodes.add(n); // F5: the workflow capabilities that replace the hard-coded role lists
  for (const n of COMPANY_ADMINISTRATION_NODES) nodes.add(n); // the Company administration nodes are part of the universe even before a screen gates on each
  cache = [...nodes].sort();
  return cache;
}

const MODULE_OF = new Map<string, string | null>();

/** The owning module of a node for entitlement filtering; `null` = not module-owned (always available, e.g. `core.*`, `system.*`, `core.company.*`). Memoized: the catalog is constant. */
export function moduleOfNode(node: string): string | null {
  const hit = MODULE_OF.get(node);
  if (hit !== undefined) return hit;
  const wf = WORKFLOW_RULE_BY_NODE.get(node);
  const m = wf ? wf.module : MODULE_REGISTRY.moduleOf(node);
  const owner = !m || m === 'core' ? null : m;
  MODULE_OF.set(node, owner);
  return owner;
}
