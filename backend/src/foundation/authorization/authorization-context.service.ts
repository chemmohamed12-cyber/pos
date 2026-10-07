import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { PermissionAccess } from '../permission/role-permission.entity';
import { AuthorizationContext, ContextGrant, ContextRole } from './authorization-context';

/** What a request needs to carry for the context to be derived from it. Matches `CompanyScopedRequest` (the Company context is set by `CompanyContextGuard`). */
export interface ContextRequest {
  user?: { id: string; companyId?: string };
  companyContext?: { companyId: string; dataSource: { manager: EntityManager } };
}

const REQUEST_CACHE = Symbol('daii.authorizationContext');
interface CachedEntry {
  managerKey: object | null;
  promise: Promise<AuthorizationContext>;
}

/**
 * Authorization Program F1.1 — resolves the `AuthorizationContext` ONCE per request and memoizes it on the request object, so `RolesGuard`,
 * `PermissionGuard`, navigation and `/auth/me` share one load (ONE statement: the user's roles joined to their `role_permissions`).
 *
 * Fail-closed by construction: the load either yields the real roles/grants or throws; a thrown/rejected load is never cached as an empty
 * context and the guards let the error deny the request (they never fall back to "allow"). The cache lives ONLY on the request object — nothing
 * is shared across requests, so a role change takes effect on the very next request (no stale-allow window).
 *
 * Authorization domain: when a Company manager is supplied (validated `CompanyContextGuard` / `CompanyViewContextService`) the roles and grants
 * are read from THAT Company's own database; with no manager they come from the ambient (platform) tables — identical to the pre-F1 behaviour
 * of `RolesGuard` / `PermissionService`.
 */
@Injectable()
export class AuthorizationContextService {
  constructor(private readonly dataSource: DataSource) {}

  /** The memoized context for the request's authenticated user. `manager` overrides the one on `req.companyContext` (used by routes that validate the Company themselves, e.g. `/me/navigation`). */
  forRequest(req: ContextRequest, manager?: EntityManager): Promise<AuthorizationContext> {
    if (!req.user) return Promise.reject(new Error('AuthorizationContext requires an authenticated request.'));
    const m = manager ?? req.companyContext?.dataSource.manager;
    const bag = req as unknown as Record<symbol, CachedEntry | undefined>;
    const hit = bag[REQUEST_CACHE];
    if (hit && hit.managerKey === (m ?? null)) return hit.promise;
    const companyId = m ? (req.companyContext?.companyId ?? req.user.companyId ?? null) : null;
    const promise = this.load(req.user.id, companyId, m);
    // never cache a failure: a transient error must not become a sticky (or empty) context
    promise.catch(() => {
      if (bag[REQUEST_CACHE]?.promise === promise) bag[REQUEST_CACHE] = undefined;
    });
    bag[REQUEST_CACHE] = { managerKey: m ?? null, promise };
    return promise;
  }

  /**
   * Uncached load for callers with no request object (batch jobs, tests).
   *
   * ONE statement: the user's roles joined to every `role_permissions` row of those roles (LEFT JOIN, so a role with no grants still appears as a
   * role). Pre-F1 each permission check cost 4 statements (user_roles, roles, role ids, grants).
   */
  async load(userId: string, companyId: string | null, manager?: EntityManager): Promise<AuthorizationContext> {
    const runner: { query: (sql: string, params: unknown[]) => Promise<unknown> } = manager ?? this.dataSource;
    const rows = (await runner.query(
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
}
