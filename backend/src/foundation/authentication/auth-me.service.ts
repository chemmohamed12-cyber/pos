import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { createHash } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import { AuthorizationContextService, ContextRequest } from '../authorization/authorization-context.service';
import { AuthorizationContext } from '../authorization/authorization-context';
import { classifyRole, roleTitleCode, RoleType } from '../authorization/role-classification';
import { CompanyConnectionManagerService } from '../database-registry/company-connection-manager.service';
import { CompanyEntitlementService } from '../plans/company-entitlement.service';
import { EntitlementService } from '../entitlement/entitlement.service';
import { moduleOfNode, permissionCatalogNodes } from '../permission/permission-catalog';

/** Policy flags exposed to the UI (ESC-3, CTO 2026-10-06): document types where the maker cannot approve. A UX hint — the services enforce it. */
const MAKER_CHECKER_DOCUMENTS = ['purchase_request', 'purchase_order'];
/** Same set `ScopeService` treats as unrestricted (kept in one place by the F6 scope work). */
const UNRESTRICTED_ROLE_KEYS = ['admin'];

type Level = 'read-only' | 'editable';

export interface AuthMeRole {
  key: string;
  type: RoleType;
  /** Terminology code of the display name for template roles; `null` = show the key. */
  titleCode: string | null;
}

/**
 * The Company-aware `/auth/me` contract (Authorization Blueprint §13, F1.2). ADDITIVE: the pre-existing top-level fields
 * (`id`, `email`, `fullName`, `roles`) keep their exact meaning (`roles` = platform/ambient roles) so nothing breaks while the 107 frontend
 * `hasRole()` consumers migrate; the Company-correct data lives in the new fields.
 *
 * NOT AN AUTHORITY: nothing in this payload is ever read back by the server as an authorization input. Every protected operation re-runs
 * JWT → CompanyContext → Entitlement → Permission → Scope → Policy server-side (Zero Trust, amendment A6).
 */
export interface AuthMeView {
  // legacy (unchanged)
  id: string;
  email: string;
  fullName: string;
  roles: string[];
  // F1 additions
  identity: { id: string; email: string; fullName: string; status: string };
  platform: { roles: string[]; capabilities: Record<string, Level>; isPlatformAdmin: boolean };
  company: { id: string; name: string; status: string } | null;
  membership: { id: string; roleKeys: string[]; roles: AuthMeRole[]; joinedAt: string } | null;
  /** Effective node -> level for the CURRENT authorization domain (the Company's when one is active, else the platform's), entitlement-filtered. */
  capabilities: Record<string, Level>;
  scopes: { unrestricted: boolean; orgUnitIds: string[]; warehouseIds: string[]; departmentIds: string[]; ownOnly: boolean };
  entitlements: { modules: string[]; source: 'package' | 'installation' | null };
  policyFlags: { makerChecker: string[] };
  /** F1: a stable fingerprint of (company, roles, capabilities). From F2 it becomes the membership's change counter. */
  authzVersion: string;
  legacyRoles: string[];
  legacy: { rolesSource: 'platform' };
}

interface IdentityRow {
  id: string;
  email: string;
  fullName: string;
  status: string;
  membershipId: string | null;
  membershipCreatedAt: Date | null;
  companyName: string | null;
  companyStatus: string | null;
  ambientRoleKeys: string[] | null;
}

interface Computed {
  capabilities: Record<string, Level>;
  authzVersion: string;
}

/** Bounded memo of the capability map + fingerprint, keyed by a digest of the FRESHLY LOADED roles/grants and the entitled modules. A pure function of its key, so it can never serve a stale answer. */
const COMPUTED_CACHE = new Map<string, Computed>();
const COMPUTED_CACHE_MAX = 500;

@Injectable()
export class AuthMeService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly contexts: AuthorizationContextService,
    private readonly connections: CompanyConnectionManagerService,
    private readonly companyEntitlement: CompanyEntitlementService,
    @Optional() private readonly installationEntitlement?: EntitlementService,
  ) {}

  async build(req: ContextRequest & { user: { id: string; email?: string; companyId?: string } }): Promise<AuthMeView> {
    const claimed = req.user.companyId ?? null;

    // Stage 1: ONE control-plane statement for identity + the platform role keys + Membership + Company (the Company claim in the JWT is honoured only
    // if this Membership exists — same rule as /me/navigation — otherwise the platform view).
    // The Company-database reads for the CLAIMED Company are started speculatively, in parallel with the identity statement (one fewer sequential
    // round trip). Their result is consumed ONLY if the Membership check below passes; otherwise it is discarded and never memoized on the request,
    // so an unvalidated claim can neither surface data nor influence a later guard. The claim itself is a signed JWT field issued by select-company.
    const speculative = claimed ? this.speculativeCompanyReads(req.user.id, claimed) : null;
    const identity = await this.identityRow(req.user.id, claimed);
    if (!identity) throw new NotFoundException('User not found.');
    const legacyRoles = identity.ambientRoleKeys ?? [];

    const member = claimed && identity.membershipId && identity.companyName !== null;
    const reads = member && speculative ? await speculative : null; // null = Company DB unreachable
    // An unreachable Company database degrades to the platform view (same as CompanyViewContextService), never to partial Company data.
    const active = member && reads ? { companyId: claimed as string, manager: reads.manager } : null;

    // Stage 2 (parallel): the entitlement, plus — in platform mode only — the platform authorization context. In Company mode the platform grants
    // are NOT loaded: `platform.capabilities` is reserved for the `platform.*` namespace introduced in F4 (nothing consumes it before then), and
    // `roles` already comes from the identity statement.
    const [domainCtx, entitled] = await Promise.all([
      active && reads ? Promise.resolve(reads.ctx) : legacyRoles.length > 0 ? this.contexts.load(req.user.id, null) : Promise.resolve(new AuthorizationContext(req.user.id, null, [], [])),
      this.entitledModules(active ? active.companyId : null),
    ]);
    const orgUnitIds = active && reads ? reads.orgUnitIds : [];
    const ctx = domainCtx;
    const computed = this.compute(ctx, entitled.modules, active?.companyId ?? null);
    const platformCapabilities: Record<string, Level> = active ? {} : computed.capabilities;

    const roles: AuthMeRole[] = ctx.roles.map((r) => ({ key: r.key, type: classifyRole(r.key), titleCode: roleTitleCode(r.key) }));
    return {
      id: identity.id,
      email: identity.email,
      fullName: identity.fullName,
      roles: legacyRoles,
      identity: { id: identity.id, email: identity.email, fullName: identity.fullName, status: identity.status },
      platform: { roles: legacyRoles, capabilities: platformCapabilities, isPlatformAdmin: legacyRoles.includes('admin') },
      company: active ? { id: active.companyId, name: identity.companyName as string, status: identity.companyStatus as string } : null,
      membership: active ? { id: identity.membershipId as string, roleKeys: ctx.roleKeys, roles, joinedAt: new Date(identity.membershipCreatedAt as Date).toISOString() } : null,
      capabilities: computed.capabilities,
      scopes: {
        unrestricted: ctx.roleKeys.some((k) => UNRESTRICTED_ROLE_KEYS.includes(k)),
        orgUnitIds: active ? orgUnitIds : [],
        warehouseIds: [],
        departmentIds: [],
        ownOnly: false,
      },
      entitlements: { modules: [...entitled.modules].sort(), source: entitled.source },
      policyFlags: { makerChecker: MAKER_CHECKER_DOCUMENTS },
      authzVersion: computed.authzVersion,
      legacyRoles,
      legacy: { rolesSource: 'platform' },
    };
  }

  /** Company-DB reads for the claimed Company (authorization context + org memberships). NEVER rejects: any failure yields `null` (platform view). Not memoized on the request. */
  private async speculativeCompanyReads(userId: string, companyId: string): Promise<{ manager: EntityManager; ctx: AuthorizationContext; orgUnitIds: string[] } | null> {
    try {
      const manager = (await this.connections.getDataSource(companyId)).manager;
      const [ctx, orgUnitIds] = await Promise.all([this.contexts.load(userId, companyId, manager), this.orgUnitIds(userId, manager)]);
      return { manager, ctx, orgUnitIds };
    } catch {
      return null;
    }
  }

  private async identityRow(userId: string, companyId: string | null): Promise<IdentityRow | null> {
    const rows = (await this.dataSource.query(
      `SELECT u."id" AS "id", u."email" AS "email", u."fullName" AS "fullName", u."status" AS "status",
              m."id" AS "membershipId", m."createdAt" AS "membershipCreatedAt", c."name" AS "companyName", c."status" AS "companyStatus",
              ARRAY(SELECT r."key" FROM "user_roles" ur INNER JOIN "roles" r ON r."id" = ur."roleId" WHERE ur."userId" = u."id" ORDER BY r."key") AS "ambientRoleKeys"
         FROM "users" u
         LEFT JOIN "user_company_memberships" m ON m."userId" = u."id" AND m."companyId" = $2 AND m."status" = 'active'
         LEFT JOIN "companies" c ON c."id" = m."companyId"
        WHERE u."id" = $1`,
      [userId, companyId],
    )) as IdentityRow[];
    return rows[0] ?? null;
  }

  private async entitledModules(companyId: string | null): Promise<{ modules: ReadonlySet<string>; source: 'package' | 'installation' | null }> {
    if (companyId) {
      const r = await this.companyEntitlement.resolve(companyId);
      return { modules: r.modules, source: r.source };
    }
    const inst = this.installationEntitlement?.resolve();
    return { modules: inst?.modules ?? new Set<string>(), source: inst ? 'installation' : null };
  }

  /** Capability map + fingerprint for a context, memoized on a digest of what was just loaded (see COMPUTED_CACHE). */
  private compute(ctx: AuthorizationContext, modules: ReadonlySet<string>, companyId: string | null): Computed {
    const key = `${companyId ?? '-'}|${ctx.signature()}|${[...modules].sort().join(',')}`;
    const hit = COMPUTED_CACHE.get(key);
    if (hit) return hit;
    const eff = ctx.effectiveFor(permissionCatalogNodes());
    const capabilities: Record<string, Level> = {};
    for (const [node, level] of Object.entries(eff)) {
      const mod = moduleOfNode(node);
      if (mod && !modules.has(mod)) continue; // Entitlement ≠ Permission: a module outside the package yields no capability
      capabilities[node] = level;
    }
    // catalog order is sorted, so `capabilities` is deterministic without re-sorting
    const authzVersion = createHash('sha1')
      .update(JSON.stringify({ c: companyId, r: [...ctx.roleKeys].sort(), k: capabilities }))
      .digest('hex')
      .slice(0, 12);
    const computed = { capabilities, authzVersion };
    if (COMPUTED_CACHE.size >= COMPUTED_CACHE_MAX) COMPUTED_CACHE.delete(COMPUTED_CACHE.keys().next().value as string);
    COMPUTED_CACHE.set(key, computed);
    return computed;
  }

  private async orgUnitIds(userId: string, manager: EntityManager): Promise<string[]> {
    try {
      const rows: Array<{ orgUnitId: string }> = await manager.query(`SELECT "orgUnitId" FROM "org_memberships" WHERE "userId" = $1`, [userId]);
      return rows.map((r) => r.orgUnitId);
    } catch {
      return []; // a Company database without the org tables yet: no org scope, never a failure of /auth/me
    }
  }
}
