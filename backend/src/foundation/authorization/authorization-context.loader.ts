import { EntityManager } from 'typeorm';
import { PermissionAccess } from '../permission/role-permission.entity';
import { AuthorizationContext, ContextGrant, ContextRole } from './authorization-context';

/** The rows a user's roles and grants are read from (`$1` = user id). Shared by `loadAuthorizationContext` and by any statement that loads the context together with other rows (B2). */
export const AUTHORIZATION_CONTEXT_FROM = `FROM "user_roles" ur
       INNER JOIN "roles" r ON r."id" = ur."roleId"
       LEFT JOIN "role_permissions" rp ON rp."roleId" = r."id"
      WHERE ur."userId" = $1`;

export interface AuthorizationContextRow {
  roleId: string;
  key: string;
  nodeKey: string | null;
  access: PermissionAccess | null;
}

/** The ONE construction of an `AuthorizationContext` from its rows (roles kept even without grants). */
export function buildAuthorizationContext(rows: readonly AuthorizationContextRow[], userId: string, companyId: string | null): AuthorizationContext {
  const roles = new Map<string, ContextRole>();
  const grants: ContextGrant[] = [];
  for (const row of rows) {
    if (!roles.has(row.roleId)) roles.set(row.roleId, { id: row.roleId, key: row.key });
    if (row.nodeKey && row.access) grants.push({ roleId: row.roleId, nodeKey: row.nodeKey, access: row.access });
  }
  return new AuthorizationContext(userId, companyId, [...roles.values()], grants);
}

/**
 * The ONE statement that loads a user's roles and every grant of those roles from a database (a Company database when `runner` is its manager, else the ambient
 * one). Shared by the request-scoped `AuthorizationContextService` and by `AuthorizationService.workflowAccess` so there is a single definition of "what a user holds".
 */
export async function loadAuthorizationContext(runner: { query: (sql: string, params: unknown[]) => Promise<unknown> } | EntityManager, userId: string, companyId: string | null): Promise<AuthorizationContext> {
  const rows = (await (runner as { query: (sql: string, params: unknown[]) => Promise<unknown> }).query(
    `SELECT r."id" AS "roleId", r."key" AS "key", rp."nodeKey" AS "nodeKey", rp."access" AS "access"
       ${AUTHORIZATION_CONTEXT_FROM}`,
    [userId],
  )) as AuthorizationContextRow[];
  return buildAuthorizationContext(rows, userId, companyId);
}
