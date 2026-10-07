/**
 * The literal `core.company.*` permission nodes (never wildcards — the engine has none). Kept in a leaf file so the permission catalog, the role seeding
 * and the role-management service can all import them without a cycle.
 */
export const COMPANY_MEMBERS_MANAGE_NODE = 'core.company.members.manage';
/** F3 — guards the role-management surface (`/company/roles`). */
export const COMPANY_ROLES_MANAGE_NODE = 'core.company.roles.manage';
export const COMPANY_BACKUP_MANAGE_NODE = 'core.company.backup.manage';
export const COMPANY_AUDIT_VIEW_NODE = 'core.company.audit.view';

/** The Company ADMINISTRATION authority (Blueprint §6.2): manage users, roles, backups and the authorization audit — and nothing operational. */
export const COMPANY_ADMINISTRATION_NODES: readonly string[] = [COMPANY_MEMBERS_MANAGE_NODE, COMPANY_ROLES_MANAGE_NODE, COMPANY_BACKUP_MANAGE_NODE, COMPANY_AUDIT_VIEW_NODE];
