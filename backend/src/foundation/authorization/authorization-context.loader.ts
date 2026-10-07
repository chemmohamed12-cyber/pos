import { EntityManager } from 'typeorm';
import { PermissionAccess } from '../permission/role-permission.entity';
import { AuthorizationContext, ContextGrant, ContextRole } from './authorization-context';

/**
 * The ONE statement that loads a user's roles and every grant of those roles from a database (a Company database when `runner` is its manager, else the ambient
 * one). Shared by the request-scoped `AuthorizationContextService` and by `AuthorizationService.workflowAccess` so there is a single definition of "what a user holds".
 */
export async function loadAuthorizationContext(runner: { query: (sql: string, params: unknown[]) => Promise<unknown> } | EntityManager, userId: string, companyId: string | null): Promise<AuthorizationContext> {
  const rows = (await (runner as { query: (sql: string, params: unknown[]) => Promise<unknown> }).query(
    `SELECT r."id" AS "roleId", r."key" AS "key", rp."nodeKey" AS "nodeKey", rp."access" AS "access"
       FROM "user_roles" ur
       INNER JOIN "roles" r ON r."id" = ur."roleId"
       LEFT JOIN "role_permissions" rp ON rp."roleId" = r."id"
      WHERE ur."userId" = $1`,
    [userId],
  )) as Array<{ roleId: string; key: string; nodeKey: string | null; access: PermissionAccess | null }>;
  const roles = new Map<string, ContextRole>();
  const grants: ContextGrant[] = [];
  for (const row of rows) {
    if (!roles.has(row.roleId)) roles.set(row.roleId, { id: row.roleId, key: row.key });
    if (row.nodeKey && row.access) grants.push({ roleId: row.roleId, nodeKey: row.nodeKey, access: row.access });
  }
  return new AuthorizationContext(userId, companyId, [...roles.values()], grants);
}
