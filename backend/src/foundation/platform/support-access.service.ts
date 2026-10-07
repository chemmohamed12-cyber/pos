import { randomUUID } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { AuthorizationContextService } from '../authorization/authorization-context.service';
import { CompanyConnectionManagerService } from '../database-registry/company-connection-manager.service';
import { CompanyNotReadyException, isCompanyOperational } from '../company/company-operational-status';
import { CompanyService } from '../company/company.service';
import { CompanyUserError, replaceUserRoles } from '../company/company-user-roles';
import { MembershipService } from '../company/membership.service';
import { CompanyEntitlementService } from '../plans/company-entitlement.service';
import { UsersService } from '../identity/users.service';
import { PLATFORM_ROLE_KEYS } from './platform-nodes';

/** The ONLY role a support membership can carry: read-only across the Company's entitled modules, nothing critical, no administration. */
export const SUPPORT_ROLE_KEY = 'support_readonly';
export const SUPPORT_MAX_HOURS = 8;
export const SUPPORT_DEFAULT_HOURS = 4;
export const SUPPORT_MIN_REASON = 10;

export interface SupportAccessView {
  companyId: string;
  companyName: string | null;
  userId: string;
  userName: string | null;
  userEmail: string | null;
  reason: string;
  roleKey: string;
  grantedBy: string | null;
  grantedAt: string;
  expiresAt: string;
}

/**
 * Authorization Foundation F4 — support access (CTO: "Explicit + Time-boxed + Reason-required + Audited + Company-visible"). A platform user reaches a Company
 * ONLY through a `support` membership: created by an explicit act of someone holding `platform.support.grant`, with a mandatory reason (≥ 10 characters) and an
 * expiry (≤ 8 h), carrying exactly one limited role (`support_readonly`: read-only on the entitled modules). The expiry is enforced on EVERY request by the
 * access guards (an expired row is a missing row); a sweeper then removes the Company-side role and writes the closing audit. The Company sees the access in its
 * user directory and in ITS OWN audit chain (granted / revoked / expired), and its administrators can end it at any time — there is no standing back door,
 * and platform authority alone never reads Company data.
 */
@Injectable()
export class SupportAccessService {
  private readonly logger = new Logger(SupportAccessService.name);

  constructor(
    private readonly memberships: MembershipService,
    private readonly companies: CompanyService,
    private readonly connections: CompanyConnectionManagerService,
    private readonly users: UsersService,
    private readonly audit: AuditService,
    private readonly contexts: AuthorizationContextService,
    private readonly entitlement: CompanyEntitlementService,
    private readonly platform: DataSource,
  ) {}

  async grant(actorUserId: string, input: { companyId: string; userId?: string; reason: unknown; hours?: unknown }): Promise<SupportAccessView> {
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (reason.length < SUPPORT_MIN_REASON || reason.length > 500) throw new CompanyUserError('INVALID_INPUT', `A reason of ${SUPPORT_MIN_REASON}–500 characters is required for support access.`);
    const hoursRaw = input.hours === undefined || input.hours === null ? SUPPORT_DEFAULT_HOURS : Number(input.hours);
    if (!Number.isFinite(hoursRaw) || hoursRaw <= 0 || hoursRaw > SUPPORT_MAX_HOURS) throw new CompanyUserError('INVALID_INPUT', `Support access lasts at most ${SUPPORT_MAX_HOURS} hours.`);
    const expiresAt = new Date(Date.now() + hoursRaw * 3_600_000);
    const targetId = input.userId ?? actorUserId;
    const target = await this.users.findById(targetId);
    const company = await this.companies.findById(input.companyId);
    if (!company) throw new CompanyUserError('NOT_A_MEMBER', 'Company not found.');
    if (!isCompanyOperational(company.status)) throw new CompanyNotReadyException();
    // Only a PLATFORM user can hold support access (a person with no platform role has no business in another tenant).
    const targetCtx = await this.contexts.load(targetId, null);
    if (!targetCtx.roleKeys.some((k) => PLATFORM_ROLE_KEYS.includes(k))) throw new CompanyUserError('INVALID_INPUT', 'Support access can only be opened for a platform user.');

    const existing = await this.memberships.findByUserAndCompany(targetId, input.companyId);
    if (existing && existing.kind !== 'support') throw new CompanyUserError('ALREADY_MEMBER', 'That person is already a regular member of this Company; support access is not needed.');

    const ds = await this.connections.getDataSource(input.companyId);
    const correlationId = randomUUID();
    await ds.transaction(async (m) => {
      const roleId = await this.ensureSupportRole(m, input.companyId);
      await replaceUserRoles(m, targetId, [roleId]);
      await this.audit.record({ actorUserId, organizationId: null, action: 'support_access.granted', resource: 'membership', resourceId: targetId, result: 'success', correlationId, before: existing ? { expiresAt: existing.expiresAt?.toISOString() ?? null } : null, after: { userId: targetId, userEmail: target.email, roleKey: SUPPORT_ROLE_KEY, reason, expiresAt: expiresAt.toISOString(), hours: hoursRaw } }, m);
    });
    if (existing) {
      await this.platform.query(`UPDATE "user_company_memberships" SET "expiresAt" = $3, "reason" = $4, "grantedBy" = $5, "status" = 'active', "authzVersion" = "authzVersion" + 1 WHERE "userId" = $1 AND "companyId" = $2`, [targetId, input.companyId, expiresAt, reason, actorUserId]);
    } else {
      await this.memberships.create({ userId: targetId, companyId: input.companyId, roleKey: SUPPORT_ROLE_KEY, status: 'active', kind: 'support', expiresAt, reason, grantedBy: actorUserId });
    }
    await this.audit.record({ actorUserId, organizationId: null, action: 'platform.support_access.granted', resource: 'company', resourceId: input.companyId, result: 'success', correlationId, after: { userId: targetId, reason, expiresAt: expiresAt.toISOString(), roleKey: SUPPORT_ROLE_KEY } });
    return (await this.view(input.companyId, targetId))!;
  }

  /** Ends a support access now. `by` records who: a platform user or the Company's own administrator. */
  async revoke(actorUserId: string, companyId: string, userId: string, by: 'platform' | 'company'): Promise<void> {
    const m = await this.memberships.findByUserAndCompany(userId, companyId);
    if (!m || m.kind !== 'support') throw new CompanyUserError('NOT_A_MEMBER', 'No support access for that user in this Company.');
    await this.close(m.userId, m.companyId, m.reason ?? '', actorUserId, 'support_access.revoked', { by });
  }

  /** Closes every support access whose time is up. Idempotent; safe to call from a timer and before reads. */
  async expireDue(): Promise<number> {
    const rows: Array<{ userId: string; companyId: string; reason: string | null }> = await this.platform.query(
      `SELECT "userId", "companyId", "reason" FROM "user_company_memberships" WHERE "kind" = 'support' AND "expiresAt" <= now()`,
    );
    for (const r of rows) {
      try {
        await this.close(r.userId, r.companyId, r.reason ?? '', null, 'support_access.expired', {});
      } catch (err) {
        this.logger.error(`Could not close expired support access ${r.userId}@${r.companyId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return rows.length;
  }

  async list(companyId?: string): Promise<SupportAccessView[]> {
    await this.expireDue();
    const rows: Array<{ userId: string; companyId: string }> = await this.platform.query(
      `SELECT "userId", "companyId" FROM "user_company_memberships" WHERE "kind" = 'support' AND "expiresAt" > now() ${companyId ? 'AND "companyId" = $1' : ''} ORDER BY "expiresAt"`,
      companyId ? [companyId] : [],
    );
    const out: SupportAccessView[] = [];
    for (const r of rows) {
      const v = await this.view(r.companyId, r.userId);
      if (v) out.push(v);
    }
    return out;
  }

  private async view(companyId: string, userId: string): Promise<SupportAccessView | null> {
    const m = await this.memberships.findByUserAndCompany(userId, companyId);
    if (!m || m.kind !== 'support' || !m.expiresAt) return null;
    const [company, user] = await Promise.all([this.companies.findById(companyId), this.users.findById(userId).catch(() => null)]);
    return { companyId, companyName: company?.name ?? null, userId, userName: user?.fullName ?? null, userEmail: user?.email ?? null, reason: m.reason ?? '', roleKey: m.roleKey, grantedBy: m.grantedBy, grantedAt: m.joinedAt.toISOString(), expiresAt: m.expiresAt.toISOString() };
  }

  /** Company-side removal of the role first (the authority), then the membership; the Company chain gets its own closing record. */
  private async close(userId: string, companyId: string, reason: string, actorUserId: string | null, action: 'support_access.revoked' | 'support_access.expired', extra: Record<string, unknown>): Promise<void> {
    const correlationId = randomUUID();
    try {
      const ds = await this.connections.getDataSource(companyId);
      await ds.transaction(async (m) => {
        await replaceUserRoles(m, userId, []);
        await this.audit.record({ actorUserId, organizationId: null, action, resource: 'membership', resourceId: userId, result: 'success', correlationId, before: { reason }, after: { ...extra } }, m);
      });
    } catch (err) {
      // The Company database is unreachable: the membership is still removed below (access is refused either way); the role row is left for the next sweep of that Company.
      this.logger.warn(`Support access ${action} for ${userId}@${companyId}: Company-side cleanup failed (${err instanceof Error ? err.message : String(err)})`);
    }
    await this.memberships.revoke(userId, companyId);
    await this.audit.record({ actorUserId, organizationId: null, action: `platform.${action}`, resource: 'company', resourceId: companyId, result: 'success', correlationId, before: { userId, reason }, after: { ...extra } });
  }

  /** Creates (or refreshes the grants of) the Company's `support_readonly` role: read-only on every module the Company is entitled to. Never grants an editable or critical node. */
  private async ensureSupportRole(m: EntityManager, companyId: string): Promise<string> {
    const found = await m.query(`SELECT "id" FROM "roles" WHERE "key" = $1`, [SUPPORT_ROLE_KEY]);
    let id: string;
    if (found.length) id = found[0].id;
    else {
      const [row] = await m.query(
        `INSERT INTO "roles" ("key", "type", "nameEn", "nameAr", "descriptionEn", "descriptionAr") VALUES ($1, 'system', 'Support (read-only)', 'دعم (قراءة فقط)', 'Time-boxed platform support access: read-only on the Company modules. Cannot change anything.', 'وصول دعم المنصة المحدد المدة: قراءة فقط على وحدات الشركة. لا يغيّر شيئًا.') RETURNING "id"`,
        [SUPPORT_ROLE_KEY],
      );
      id = row.id;
    }
    const modules = (await this.entitlement.resolve(companyId)).modules;
    for (const mod of modules) {
      await m.query(`INSERT INTO "role_permissions" ("roleId", "nodeKey", "access") VALUES ($1, $2, 'read-only') ON CONFLICT ("roleId", "nodeKey") DO NOTHING`, [id, mod]);
    }
    return id;
  }
}
