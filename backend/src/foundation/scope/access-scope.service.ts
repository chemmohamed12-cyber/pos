import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AuthorizationService } from '../authorization/authorization.service';
import { AuthorizationContext } from '../authorization/authorization-context';
import { AuthorizationContextService } from '../authorization/authorization-context.service';
import { WorkflowAccess } from '../authorization/workflow-access';
import { CompanyScopedRequest } from '../company/company-context.guard';

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
}

export interface AccessScopeGrant {
  orgUnitId: string;
  includeDescendants: boolean;
}

const REQUEST_SCOPE = Symbol('daii.accessScope');

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

  /** The scope of the request's caller, memoized on the request (one resolution per request however many enforcement points run); reuses the request's authorization context, so an unrestricted caller costs no extra statement. */
  forRequest(req: CompanyScopedRequest): Promise<AccessScope> {
    if (!req.user || !req.companyContext) return Promise.reject(new Error('AccessScope requires an authenticated Company request.'));
    const bag = req as unknown as Record<symbol, Promise<AccessScope> | undefined>;
    const hit = bag[REQUEST_SCOPE];
    if (hit) return hit;
    const manager = req.companyContext.dataSource.manager;
    const promise = (async () => {
      const ctx = this.contexts ? await this.contexts.forRequest(req, manager) : undefined;
      return this.resolve(req.user!.id, manager, ctx);
    })();
    promise.catch(() => {
      if (bag[REQUEST_SCOPE] === promise) bag[REQUEST_SCOPE] = undefined; // never cache a failure
    });
    bag[REQUEST_SCOPE] = promise;
    return promise;
  }

  async resolve(userId: string, manager?: EntityManager, ctx?: AuthorizationContext): Promise<AccessScope> {
    const access = ctx ? new WorkflowAccess(ctx) : await this.authorization.workflowAccess(userId, manager);
    if (access.allows('core.scope.unrestricted')) return { userId, unrestricted: true, unitIds: new Set() };
    const rows: Array<{ id: string }> = await this.runner(manager).query(
      `WITH RECURSIVE seed("id") AS (
         SELECT m."orgUnitId" FROM "org_memberships" m WHERE m."userId" = $1
         UNION
         SELECT s."orgUnitId" FROM "access_scopes" s WHERE s."userId" = $1 AND s."includeDescendants" = true
       ), tree("id") AS (
         SELECT "id" FROM seed
         UNION
         SELECT u."id" FROM "org_units" u INNER JOIN tree t ON u."parentId" = t."id"
       )
       SELECT "id" FROM tree
       UNION
       SELECT s."orgUnitId" AS "id" FROM "access_scopes" s WHERE s."userId" = $1 AND s."includeDescendants" = false`,
      [userId],
    );
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
      if (widened && !actorScope.unrestricted && !actorScope.unitIds.has(g.orgUnitId)) throw new NotFoundException(); // the unit is outside the actor's own scope: never confirm it exists
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
