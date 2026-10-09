/**
 * The literal `core.company.*` permission nodes (never wildcards — the engine has none). Kept in a leaf file so the permission catalog, the role seeding
 * and the role-management service can all import them without a cycle.
 */
export const COMPANY_MEMBERS_MANAGE_NODE = 'core.company.members.manage';
/** F3 — guards the role-management surface (`/company/roles`). */
export const COMPANY_ROLES_MANAGE_NODE = 'core.company.roles.manage';
export const COMPANY_BACKUP_MANAGE_NODE = 'core.company.backup.manage';
export const COMPANY_AUDIT_VIEW_NODE = 'core.company.audit.view';
/**
 * CTO ruling B1 (2026-10-08, Option B): Organization administration (the org tree, and through it the placement of other people's scopes) is a Company
 * ADMINISTRATION capability, not a workflow capability. It replaces the former workflow rule `core.organization.manage` / node `wf.core.organization.manage`
 * (reclassified by migration `1790013000000`); it is not a duplicate of it. No existing administration node represents this authority.
 */
export const COMPANY_ORGANIZATION_MANAGE_NODE = 'core.company.organization.manage';

/** The Company ADMINISTRATION authority (Blueprint §6.2): manage users, roles, organization, backups and the authorization audit — and nothing operational. */
export const COMPANY_ADMINISTRATION_NODES: readonly string[] = [COMPANY_MEMBERS_MANAGE_NODE, COMPANY_ROLES_MANAGE_NODE, COMPANY_ORGANIZATION_MANAGE_NODE, COMPANY_BACKUP_MANAGE_NODE, COMPANY_AUDIT_VIEW_NODE];
