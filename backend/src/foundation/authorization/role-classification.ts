import { MODULE_ROLE_TEMPLATES } from '../module-registry/role-templates';

/**
 * Authorization Program — role type vocabulary (Blueprint §6). F1 only CLASSIFIES existing role keys for `/auth/me` and the Phase-0 reports; it
 * stores nothing and renames nothing. (`roles` gets real metadata columns in F3.)
 *
 *  - `system`  : the Company administration role `company_admin` (new Companies, F3/D17)
 *  - (F3) the pre-existing `admin` is `legacy`: kept verbatim and relabelled "Legacy Administrator (Operational)"
 *  - `template`: a key produced by the module role-template catalog
 *  - `legacy`  : the pre-template flat keys that business logic still checks by name (compat — Blueprint §14)
 *  - `custom`  : anything else
 */
export type RoleType = 'system' | 'template' | 'legacy' | 'custom';

export const LEGACY_ROLE_KEYS: readonly string[] = ['admin', 'driver', 'finance', 'inventory_controller', 'sales_manager', 'sales_rep', 'sales_supervisor', 'warehouse_supervisor', 'warehouse_worker'];
const SYSTEM_ROLE_KEYS: readonly string[] = ['company_admin'];

const TEMPLATE_TITLE: Map<string, string> = new Map(Object.values(MODULE_ROLE_TEMPLATES).flat().map((t) => [t.key, t.titleCode]));

export function classifyRole(key: string): RoleType {
  if (SYSTEM_ROLE_KEYS.includes(key)) return 'system';
  if (LEGACY_ROLE_KEYS.includes(key)) return 'legacy';
  if (TEMPLATE_TITLE.has(key)) return 'template';
  return 'custom';
}

/** Terminology code of the role's display name when the catalog has one (templates), else `null` (the UI falls back to the key). */
export function roleTitleCode(key: string): string | null {
  return TEMPLATE_TITLE.get(key) ?? null;
}
