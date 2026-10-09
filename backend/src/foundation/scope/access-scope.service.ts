import { createHash } from 'crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AuthorizationService } from '../authorization/authorization.service';
import { AuthorizationContext } from '../authorization/authorization-context';
import { AuthorizationContextService } from '../authorization/authorization-context.service';
import { AUTHORIZATION_CONTEXT_FROM, AuthorizationContextRow, buildAuthorizationContext } from '../authorization/authorization-context.loader';
import { WorkflowAccess } from '../authorization/workflow-access';
import { CompanyScopedRequest } from '../company/company-context.guard';
import { CompanyUserError } from '../company/company-user-roles';
import { COMPANY_ORGANIZATION_MANAGE_NODE } from '../permission/company-nodes';

/**
 * Runs `text` as a NAMED (prepared) statement on the manager's PostgreSQL connection. This statement is the request's single authorization read and the most complex one
 * (recursive unit closure + warehouse visibility + role grants): measured on the isolated database, PLANNING it cost ~1.1 ms on EVERY request (bind 1.0-1.4 ms vs 0.2 ms
 * to execute) because an unnamed statement is re-planned each time. A named statement is parsed/planned once per pooled connection and reused. Same text, same parameters,
 * same rows, same transaction semantics — nothing is cached across requests at the data level, so a grant or a revoke is still visible on the very next call.
 * Falls back to `manager.query` for any runner that is not a PostgreSQL pool connection (unit-test doubles).
 */
async function queryPrepared<T>(manager: EntityManager, text: string, values: unknown[]): Promise<T[]> {
  const connection = (manager as { connection?: { createQueryRunner?: () => unknown } }).connection;
  if (!manager.queryRunner && typeof connection?.createQueryRunner !== 'function') return manager.query(text, values);
  const own = !manager.queryRunner;
  const runner = (manager.queryRunner ?? manager.connection.createQueryRunner()) as { connect: () => Promise<unknown>; release: () => Promise<void> };
  try {
    const client = (await runner.connect()) as { query?: (config: { name: string; text: string; values: unknown[] }) => Promise<{ rows: T[] }> };
    if (typeof client?.query !== 'function') return manager.query(text, values);
    const name = 'dq_' + createHash('sha1').update(text).digest('hex').slice(0, 24);
    return (await client.query({ name, text, values })).rows;
  } finally {
    if (own) await runner.release();
  }
}

/**
 * Authorization Foundation F6 (Blueprint §9) — the ONE definition of "which organization units may this user work with".
 *
 * Permission = what; Scope = where; this is the "where". A user's accessible units are the closure (units + descendants) of
 *   - their `org_memberships` (kept as a scope source: ADR-031 treasury scoping has always read them — zero behaviour change), and
 *   - their explicit `access_scopes` grants (descendants only when `includeDescendants`).
 * `unrestricted` (rule `core.scope.unrestricted` — the Company administrator) sees everything. A record that carries NO org-unit link is visible to everyone
 * (ADR-031 §3: every existing single-branch Company behaves exactly as before until someone links a warehouse / order / account to a unit).
 *
 * Resolution is one statement for a scoped user (a recursive CTE) and one for an unrestricted user (the rule check); nothing is cached across requests, so a
 * grant, a revoke or a role change is effective on the very next call. Always pass the Company `manager` for Company data.
 */
export interface AccessScope {
  userId: string;
  unrestricted: boolean;
  /** Closure of the accessible units (meaningful only when not unrestricted). */
  unitIds: ReadonlySet<string>;
  /**
   * Every warehouse of the Company -> may this user see it (its EFFECTIVE unit — own link, else its parent's — is unlinked or accessible)? Resolved in the SAME statement
   * as `unitIds`, so list filters and warehouse guards cost no further query. Absent when the Company has no inventory module (no `warehouses` table) or when unrestricted.
   */
  warehouses?: ReadonlyMap<string, boolean>;
}

export interface AccessScopeGrant {
  orgUnitId: string;
  includeDescendants: boolean;
}

const REQUEST_SCOPE = Symbol('daii.accessScope');
/** Per database connection: when the `warehouses` table did not exist (a Company without the inventory module) — avoids a failing statement on every request; re-checked after the TTL. */
const NO_WAREHOUSES = new WeakMap<object, number>();
const NO_WAREHOUSES_TTL_MS = 60_000;

/** `$1` = user id. The accessible units: the closure of the user's org memberships and explicit grants (descendants only where granted). */
const UNITS_CTE = `WITH RECURSIVE seed("id") AS (
         SELECT m."orgUnitId" FROM "org_memberships" m WHERE m."userId" = $1
         UNION
         SELECT s."orgUnitId" FROM "access_scopes" s WHERE s."userId" = $1 AND s."includeDescendants" = true
       ), tree("id") AS (
         SELECT "id" FROM seed
         UNION
         SELECT u."id" FROM "org_units" u INNER JOIN tree t ON u."parentId" = t."id"
       ), units("id") AS (
         SELECT "id" FROM tree
         UNION
         SELECT s."orgUnitId" FROM "access_scopes" s WHERE s."userId" = $1 AND s."includeDescendants" = false
       )`;
/** Every warehouse -> visible? (its EFFECTIVE unit — own link, else its parent's — is unlinked or inside `units`). */
const WAREHOUSE_VISIBILITY = `SELECT w."id"::text AS "id", (COALESCE(w."orgUnitId", p."orgUnitId") IS NULL OR COALESCE(w."orgUnitId", p."orgUnitId") IN (SELECT "id" FROM units)) AS "v"
             FROM "warehouses" w LEFT JOIN "warehouses" p ON p."id" = w."parentWarehouseId"`;

const errorCode = (err: unknown): string | undefined =>
  (err as { code?: string; driverError?: { code?: string } }).code ?? (err as { driverError?: { code?: string } }).driverError?.code;

@Injectable()
export class AccessScopeService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly authorization: AuthorizationService,
    /** Optional only so unit specs can construct the service without it; under Nest DI it is always present. */
    private readonly contexts?: AuthorizationContextService,
  ) {}

  private runner(manager?: EntityManager) {
    return manager ?? this.dataSource;
  }

  /**
   * The scope of the request's caller, memoized on the request (one resolution per request however many enforcement points run).
   * B2 (2026-10-08): when the request has not loaded its authorization context yet, the context AND the scope rows are read in ONE statement (one round trip
   * instead of two); the context is memoized for every later guard / handler, and the scope rows are used only if the context says the caller is restricted —
   * the decision is exactly `resolve()`'s. When the context is already loaded, `resolve()` reuses it (an unrestricted caller then costs no extra statement).
   */
  forRequest(req: CompanyScopedRequest): Promise<AccessScope> {
    if (!req.user || !req.companyContext) return Promise.reject(new Error('AccessScope requires an authenticated Company request.'));
    const bag = req as unknown as Record<symbol, Promise<AccessScope> | undefined>;
    const hit = bag[REQUEST_SCOPE];
    if (hit) return hit;
    const manager = req.companyContext.dataSource.manager;
    const promise = (async () => {
      const userId = req.user!.id;
      const known = NO_WAREHOUSES.get(this.connectionOf(manager));
      const combined = this.contexts && !(known && Date.now() - known < NO_WAREHOUSES_TTL_MS)
        ? this.contexts.forRequestWith(req, manager, (uid, companyId) => this.loadContextAndScope(uid, companyId, manager))
        : null;
      if (combined) {
        try {
          const ctx = await combined.ctx;
          if (new WorkflowAccess(ctx).allows('core.scope.unrestricted')) return { userId, unrestricted: true, unitIds: new Set<string>() } as AccessScope;
          return await combined.extra;
        } catch (err) {
          if (errorCode(err) !== '42P01') throw err; // only "relation does not exist" (a Company without the inventory module) falls back to the separate statements
          NO_WAREHOUSES.set(this.connectionOf(manager), Date.now());
        }
      }
      const ctx = this.contexts ? await this.contexts.forRequest(req, manager) : undefined;
      return this.resolve(userId, manager, ctx);
    })();
    promise.catch(() => {
      if (bag[REQUEST_SCOPE] === promise) bag[REQUEST_SCOPE] = undefined; // never cache a failure
    });
    bag[REQUEST_SCOPE] = promise;
    return promise;
  }

  /**
   * CTO Decision 3 — the Company administrator (`company_admin`) manages Organization and Scopes WITHOUT being a data-unrestricted user: holding the Organization
   * administration node (`core.company.organization.manage`, CTO ruling B1) lets a caller place people on ANY unit of the tree they administer. It is the administrative reach over the org tree, not a data privilege.
   */
  async canAdministerAllUnits(req: CompanyScopedRequest): Promise<boolean> {
    if (!this.contexts || !req.user || !req.companyContext) return false;
    const ctx = await this.contexts.forRequest(req, req.companyContext.dataSource.manager);
    return ctx.hasAtLeast(COMPANY_ORGANIZATION_MANAGE_NODE, 'editable');
  }

  /** The connection a runner belongs to (the key of the per-connection "no warehouses table" memo). */
  private connectionOf(manager?: EntityManager): object {
    const runner = this.runner(manager);
    return (runner as { connection?: object }).connection ?? (runner as unknown as object);
  }

  /**
   * B2 — ONE statement: the caller's roles and grants (the very rows `loadAuthorizationContext` reads, `AUTHORIZATION_CONTEXT_FROM`) + the accessible units +
   * the visibility of every warehouse. Throws 42P01 when the Company has no `warehouses` table (the caller falls back).
   */
  private async loadContextAndScope(userId: string, companyId: string | null, manager: EntityManager): Promise<{ ctx: AuthorizationContext; extra: AccessScope }> {
    const rows = await queryPrepared<{ k: string; a: string; b: string | null; c: string | null; d: string | null }>(
      manager,
      `${UNITS_CTE}
       SELECT 'r' AS "k", r."id"::text AS "a", r."key" AS "b", rp."nodeKey" AS "c", rp."access"::text AS "d"
       ${AUTHORIZATION_CONTEXT_FROM}
       UNION ALL
       SELECT 'u', "id"::text, NULL, NULL, NULL FROM units
       UNION ALL
       SELECT 'w', vis."id", NULL, NULL, vis."v"::text FROM (${WAREHOUSE_VISIBILITY}) vis`,
      [userId],
    );
    const contextRows: AuthorizationContextRow[] = rows
      .filter((r) => r.k === 'r')
      .map((r) => ({ roleId: r.a, key: r.b as string, nodeKey: r.c, access: r.d as AuthorizationContextRow['access'] }));
    return {
      ctx: buildAuthorizationContext(contextRows, userId, companyId),
      extra: {
        userId,
        unrestricted: false,
        unitIds: new Set(rows.filter((r) => r.k === 'u').map((r) => r.a)),
        warehouses: new Map(rows.filter((r) => r.k === 'w').map((r) => [r.a, r.d === 'true'])),
      },
    };
  }

  async resolve(userId: string, manager?: EntityManager, ctx?: AuthorizationContext): Promise<AccessScope> {
    const access = ctx ? new WorkflowAccess(ctx) : await this.authorization.workflowAccess(userId, manager);
    if (access.allows('core.scope.unrestricted')) return { userId, unrestricted: true, unitIds: new Set() };
    const runner = this.runner(manager);
    const UNITS = UNITS_CTE;
    const conn = this.connectionOf(manager);
    const known = NO_WAREHOUSES.get(conn);
    if (!(known && Date.now() - known < NO_WAREHOUSES_TTL_MS)) {
      try {
        // ONE statement: the accessible units AND the visibility of every warehouse (own link, else the parent's)
        const rows: Array<{ k: string; id: string; v: boolean | null }> = await runner.query(
          `${UNITS}
           SELECT 'u' AS "k", "id"::text AS "id", NULL::boolean AS "v" FROM units
           UNION ALL
           SELECT 'w', vis."id", vis."v" FROM (${WAREHOUSE_VISIBILITY}) vis`,
          [userId],
        );
        return {
          userId,
          unrestricted: false,
          unitIds: new Set(rows.filter((r) => r.k === 'u').map((r) => r.id)),
          warehouses: new Map(rows.filter((r) => r.k === 'w').map((r) => [r.id, r.v === true])),
        };
      } catch (err) {
        if (errorCode(err) !== '42P01') throw err; // only "relation does not exist" (a Company without the inventory module) falls back
        NO_WAREHOUSES.set(conn, Date.now());
      }
    }
    const rows: Array<{ id: string }> = await runner.query(`${UNITS} SELECT "id" FROM units`, [userId]);
    return { userId, unrestricted: false, unitIds: new Set(rows.map((r) => r.id)) };
  }

  /** The decision for ONE unit link: no link = visible to everyone; otherwise the unit must be inside the accessible closure. */
  allowsUnit(scope: AccessScope, orgUnitId: string | null | undefined): boolean {
    return scope.unrestricted || !orgUnitId || scope.unitIds.has(orgUnitId);
  }

  /** 404 (never 403 — anti-enumeration, ADR-005) when the unit is outside the caller's scope. */
  assertUnit(scope: AccessScope, orgUnitId: string | null | undefined): void {
    if (!this.allowsUnit(scope, orgUnitId)) throw new NotFoundException();
  }

  /**
   * The warehouses the caller may work with: `'ALL'` when unrestricted, else the ids whose EFFECTIVE unit (own link, else the parent warehouse's — an operational
   * custody sub-location inherits the warehouse it hangs under) is unlinked or accessible. Requires the inventory module's tables.
   */
  async visibleWarehouseIds(scope: AccessScope, manager?: EntityManager): Promise<'ALL' | string[]> {
    if (scope.unrestricted) return 'ALL';
    if (scope.warehouses) return [...scope.warehouses].filter(([, visible]) => visible).map(([id]) => id); // resolved with the scope: no further statement
    const rows: Array<{ id: string }> = await this.runner(manager).query(
      `SELECT w."id" FROM "warehouses" w LEFT JOIN "warehouses" p ON p."id" = w."parentWarehouseId"
        WHERE COALESCE(w."orgUnitId", p."orgUnitId") IS NULL OR COALESCE(w."orgUnitId", p."orgUnitId") = ANY($1::uuid[])`,
      [[...scope.unitIds]],
    );
    return rows.map((r) => r.id);
  }

  /** The warehouse's effective unit link (own, else its parent's) — `null` = unscoped. `undefined` = the warehouse does not exist. */
  async warehouseUnit(warehouseId: string, manager?: EntityManager): Promise<string | null | undefined> {
    const rows: Array<{ unit: string | null }> = await this.runner(manager).query(
      `SELECT COALESCE(w."orgUnitId", p."orgUnitId") AS "unit" FROM "warehouses" w LEFT JOIN "warehouses" p ON p."id" = w."parentWarehouseId" WHERE w."id" = $1`,
      [warehouseId],
    );
    return rows.length ? rows[0].unit : undefined;
  }

  /** Detail / create / edit / approve / post / reverse on a warehouse-keyed record: 404 when the warehouse is outside the scope. A missing warehouse is not a scope matter (the caller reports it). */
  async assertWarehouse(scope: AccessScope, warehouseId: string | null | undefined, manager?: EntityManager): Promise<void> {
    if (scope.unrestricted || !warehouseId) return;
    if (scope.warehouses) {
      // resolved with the scope: an id that is not a warehouse is not a scope matter; a warehouse the caller cannot see is a 404
      if (scope.warehouses.get(warehouseId) === false) throw new NotFoundException();
      return;
    }
    const unit = await this.warehouseUnit(warehouseId, manager);
    if (unit === undefined) return;
    this.assertUnit(scope, unit);
  }

  /** What the scope means for the user, in names: the accessible units and (when the inventory module is installed) the warehouses they can and cannot see. Backs the Effective Access Preview. */
  async describe(userId: string, manager?: EntityManager): Promise<{
    unrestricted: boolean;
    units: Array<{ id: string; name: string; type: string }>;
    warehouses: { visible: Array<{ id: string; code: string; name: string }>; hidden: Array<{ id: string; code: string; name: string }> } | null;
  }> {
    const scope = await this.resolve(userId, manager);
    const runner = this.runner(manager);
    const units: Array<{ id: string; name: string; type: string }> = scope.unrestricted
      ? []
      : await runner.query(`SELECT "id", "name", "type" FROM "org_units" WHERE "id" = ANY($1::uuid[]) ORDER BY "name"`, [[...scope.unitIds]]);
    const hasWarehouses: Array<{ t: string | null }> = await runner.query(`SELECT to_regclass('warehouses')::text AS "t"`);
    let warehouses: { visible: Array<{ id: string; code: string; name: string }>; hidden: Array<{ id: string; code: string; name: string }> } | null = null;
    if (hasWarehouses[0]?.t) {
      const rows: Array<{ id: string; code: string; name: string; unit: string | null }> = await runner.query(
        `SELECT w."id", w."code", w."name", COALESCE(w."orgUnitId", p."orgUnitId") AS "unit" FROM "warehouses" w LEFT JOIN "warehouses" p ON p."id" = w."parentWarehouseId" ORDER BY w."code"`,
      );
      const visible = rows.filter((r) => this.allowsUnit(scope, r.unit));
      const hidden = rows.filter((r) => !this.allowsUnit(scope, r.unit));
      warehouses = { visible: visible.map(({ id, code, name }) => ({ id, code, name })), hidden: hidden.map(({ id, code, name }) => ({ id, code, name })) };
    }
    return { unrestricted: scope.unrestricted, units, warehouses };
  }

  // ---- grants (management) ----

  async listGrants(userId: string, manager?: EntityManager): Promise<Array<AccessScopeGrant & { id: string; unitName: string | null; unitType: string | null }>> {
    return this.runner(manager).query(
      `SELECT s."id", s."orgUnitId", s."includeDescendants", u."name" AS "unitName", u."type" AS "unitType"
         FROM "access_scopes" s LEFT JOIN "org_units" u ON u."id" = s."orgUnitId" WHERE s."userId" = $1 ORDER BY u."name"`,
      [userId],
    );
  }

  /**
   * Replaces the target user's explicit grants with `grants`. Anti-elevation (a scope grant broadens data access): the actor can only grant units that are inside
   * their OWN scope (an unrestricted actor — the Company administrator — may grant any unit, including the Company root = "All company"). Returns before/after for audit.
   */
  async replaceGrants(
    actorScope: AccessScope,
    targetUserId: string,
    grants: AccessScopeGrant[],
    actorUserId: string,
    manager: EntityManager,
    opts: { organizationAdmin?: boolean } = {},
  ): Promise<{ before: AccessScopeGrant[]; after: AccessScopeGrant[] }> {
    const unique = new Map<string, AccessScopeGrant>();
    for (const g of grants) {
      if (!g || typeof g.orgUnitId !== 'string') throw new BadRequestException('Every grant needs an orgUnitId.');
      unique.set(g.orgUnitId, { orgUnitId: g.orgUnitId, includeDescendants: g.includeDescendants !== false });
    }
    const wanted = [...unique.values()];
    if (wanted.length) {
      const found: Array<{ id: string }> = await manager.query(`SELECT "id" FROM "org_units" WHERE "id" = ANY($1::uuid[])`, [wanted.map((g) => g.orgUnitId)]);
      const known = new Set(found.map((r) => r.id));
      const missing = wanted.filter((g) => !known.has(g.orgUnitId));
      if (missing.length) throw new BadRequestException(`Unknown organization unit: ${missing.map((m) => m.orgUnitId).join(', ')}`);
    }
    const before = (await this.listGrants(targetUserId, manager)).map((g) => ({ orgUnitId: g.orgUnitId, includeDescendants: g.includeDescendants }));
    const beforeMap = new Map(before.map((g) => [g.orgUnitId, g]));
    // only what is NEW or WIDENED needs the actor to hold the unit; removing or narrowing is always allowed to the administration authority
    for (const g of wanted) {
      const old = beforeMap.get(g.orgUnitId);
      const widened = !old || (g.includeDescendants && !old.includeDescendants);
      // NO SELF-ELEVATION (CTO Decisions 3 / 4-C, also for Company administrators): nobody may add to or widen THEIR OWN scope; narrowing or removing it is always allowed.
      if (widened && targetUserId === actorUserId) throw new CompanyUserError('SELF_SCOPE_CHANGE', 'You cannot add to or widen your own access scope; ask another administrator.');
      if (widened && !actorScope.unrestricted && !opts.organizationAdmin && !actorScope.unitIds.has(g.orgUnitId)) throw new NotFoundException(); // the unit is outside the actor's own scope: never confirm it exists
    }
    await manager.query(`DELETE FROM "access_scopes" WHERE "userId" = $1 AND NOT ("orgUnitId" = ANY($2::uuid[]))`, [targetUserId, wanted.map((g) => g.orgUnitId)]);
    for (const g of wanted) {
      await manager.query(
        `INSERT INTO "access_scopes" ("userId", "orgUnitId", "includeDescendants", "createdBy") VALUES ($1, $2, $3, $4)
         ON CONFLICT ("userId", "orgUnitId") DO UPDATE SET "includeDescendants" = EXCLUDED."includeDescendants"`,
        [targetUserId, g.orgUnitId, g.includeDescendants, actorUserId],
      );
    }
    return { before, after: wanted };
  }
}
