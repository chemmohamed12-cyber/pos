import { createHash, randomBytes, randomUUID } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { AuthorizationContextService } from '../authorization/authorization-context.service';
import { AuthService } from '../authentication/auth.service';
import { CompanyConnectionManagerService } from '../database-registry/company-connection-manager.service';
import { UsersService } from '../identity/users.service';
import { User } from '../identity/user.entity';
import { CompanyInvitation } from './company-invitation.entity';
import { CompanyService } from './company.service';
import { COMPANY_MEMBERS_MANAGE_NODE } from './company-role-seeding';
import { CompanyActor } from './company-user-management.service';
import { CompanyUserError, grantsBeyondActor, loadRolesByKeys, lockAdministration, normalizeRoleKeys, primaryRoleKey, replaceUserRoles } from './company-user-roles';
import { MembershipOperationService } from './membership-operation.service';
import { MembershipService } from './membership.service';

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const hashInvitationToken = (token: string): string => createHash('sha256').update(token).digest('hex');
const normalizeEmail = (email: unknown): string => {
  const e = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!e || e.length > 255 || !EMAIL_RE.test(e)) throw new CompanyUserError('INVALID_INPUT', 'A valid e-mail address is required.');
  return e;
};

export interface InvitationView {
  id: string;
  email: string;
  fullName: string | null;
  roleKeys: string[];
  status: string;
  expiresAt: string;
  createdAt: string;
  invitedBy: string;
}

/**
 * Authorization Foundation F2 — Company invitations and their acceptance.
 *
 * Properties (each covered by a spec):
 *  - An invitation is data, not an identity: nothing is created for the e-mail until it is accepted, and the creation response is IDENTICAL whether or
 *    not that e-mail already has an identity elsewhere (no identity enumeration — Blueprint §3/§21). The only thing a Company can learn is about its OWN
 *    directory (an e-mail that is already a member of THIS Company is refused).
 *  - The token is 256 random bits, single use, expires, and only its SHA-256 is stored. It is handed to the inviter once (`deliveryMode: 'manual'` —
 *    there is no mail system yet; with one, the same token is mailed instead).
 *  - Acceptance by an EXISTING identity requires being signed in as that identity (the invitation's e-mail must equal the account's e-mail). The token
 *    can never set a password on, or take over, an existing account. A new identity is created only for an e-mail with no account, with the invitee's
 *    own password and NO role other than what the Company membership grants.
 *  - Roles are re-validated at acceptance against the INVITER's current authority (no automatic elevation, no stale grant by a demoted inviter).
 *  - Acceptance is claimed atomically (`UPDATE … WHERE status='pending'`), so a token works exactly once even under concurrency.
 */
@Injectable()
export class CompanyInvitationService {
  private readonly logger = new Logger(CompanyInvitationService.name);

  constructor(
    @InjectRepository(CompanyInvitation) private readonly invitations: Repository<CompanyInvitation>,
    private readonly dataSource: DataSource,
    private readonly memberships: MembershipService,
    private readonly operations: MembershipOperationService,
    private readonly users: UsersService,
    private readonly auth: AuthService,
    private readonly companies: CompanyService,
    private readonly connections: CompanyConnectionManagerService,
    private readonly contexts: AuthorizationContextService,
    private readonly audit: AuditService,
  ) {}

  async create(actor: CompanyActor, companyId: string, companyDs: DataSource, input: { email: unknown; fullName?: unknown; roleKeys?: unknown }): Promise<{ invitation: InvitationView; token: string; acceptPath: string; deliveryMode: 'manual' }> {
    const email = normalizeEmail(input.email);
    const fullName = typeof input.fullName === 'string' && input.fullName.trim() ? input.fullName.trim().slice(0, 255) : null;
    const roleKeys = normalizeRoleKeys(Array.isArray(input.roleKeys) ? input.roleKeys : []);

    // The only existence fact revealed is about THIS Company's own directory.
    const existing = await this.users.findByEmailInsensitive(email);
    if (existing && (await this.memberships.findByUserAndCompany(existing.id, companyId))) {
      throw new CompanyUserError('ALREADY_MEMBER', 'This person is already a member of this Company.');
    }

    if (roleKeys.length) {
      const known = await loadRolesByKeys(companyDs.manager, roleKeys);
      const unknown = roleKeys.filter((k) => !known.some((r) => r.key === k));
      if (unknown.length) throw new CompanyUserError('UNKNOWN_ROLE', `Unknown role(s): ${unknown.join(', ')}.`, { unknown });
      const inactive = roleKeys.filter((k) => known.find((r) => r.key === k)?.isActive === false);
      if (inactive.length) throw new CompanyUserError('ROLE_INACTIVE', `Inactive role(s) cannot be offered: ${inactive.join(', ')}.`, { inactive });
      const beyond = await grantsBeyondActor(companyDs.manager, actor.authz, roleKeys);
      if (beyond.length) {
        await this.audit.record({ actorUserId: actor.userId, organizationId: null, action: 'invitation.denied', resource: 'invitation', resourceId: null, result: 'denied', correlationId: randomUUID(), after: { reason: 'role_exceeds_grantor', roleKeys } }, companyDs.manager).catch(() => undefined);
        throw new CompanyUserError('ROLE_EXCEEDS_GRANTOR', 'Roles that carry critical permissions can only be offered by someone who holds those permissions explicitly.', { roles: [...new Set(beyond.map((g) => g.roleKey))], criticalNodes: [...new Set(beyond.map((g) => g.nodeKey))] });
      }
    }

    const token = randomBytes(32).toString('base64url');
    const correlationId = randomUUID();
    const saved = await this.dataSource.transaction(async (m) => {
      await m.getRepository(CompanyInvitation).update({ companyId, email, status: 'pending' }, { status: 'revoked', revokedAt: new Date() }); // a re-invite supersedes
      return m.getRepository(CompanyInvitation).save(
        m.getRepository(CompanyInvitation).create({ companyId, email, fullName, roleKeys, tokenHash: hashInvitationToken(token), status: 'pending', invitedBy: actor.userId, deliveryMode: 'manual', expiresAt: new Date(Date.now() + INVITATION_TTL_MS) }),
      );
    });
    await this.auditBoth(companyDs, actor.userId, 'membership.invited', saved.id, correlationId, null, { email, roleKeys });
    return { invitation: this.view(saved), token, acceptPath: `/accept-invitation?token=${encodeURIComponent(token)}`, deliveryMode: 'manual' };
  }

  async list(companyId: string): Promise<InvitationView[]> {
    await this.expireDue(companyId);
    const rows = await this.invitations.find({ where: { companyId }, order: { createdAt: 'DESC' }, take: 200 });
    return rows.map((r) => this.view(r));
  }

  async revoke(actor: CompanyActor, companyId: string, companyDs: DataSource, invitationId: string): Promise<void> {
    const res = await this.invitations.update({ id: invitationId, companyId, status: 'pending' }, { status: 'revoked', revokedAt: new Date() }); // scoped by the validated Company
    if (!res.affected) throw new CompanyUserError('INVITATION_INVALID', 'Invitation not found.');
    await this.auditBoth(companyDs, actor.userId, 'membership.invitation_revoked', invitationId, randomUUID(), { status: 'pending' }, { status: 'revoked' });
  }

  /** Public, token-only: the minimum the accept screen needs. Every invalid state (unknown, expired, used, revoked) answers identically. */
  async preview(token: string): Promise<{ companyName: string; email: string; fullName: string | null }> {
    const inv = await this.findLive(token);
    const company = await this.companies.findById(inv.companyId);
    if (!company) throw new CompanyUserError('INVITATION_INVALID', 'This invitation is not valid.');
    return { companyName: company.name, email: inv.email, fullName: inv.fullName };
  }

  /** An EXISTING, signed-in identity accepts. The invitation e-mail must equal the account e-mail. */
  async acceptAsUser(userId: string, token: string): Promise<{ companyId: string }> {
    const user = await this.users.findById(userId);
    const inv = await this.findLive(token);
    if (user.email.trim().toLowerCase() !== inv.email) throw new CompanyUserError('INVITATION_INVALID', 'This invitation is not valid.'); // never reveal that the invitation exists for another e-mail
    return this.complete(inv, user);
  }

  /** A NEW identity: allowed only when the e-mail has no account. An existing account must sign in instead (documented token-holder disclosure; see the F2 record). */
  async acceptAsNewIdentity(token: string, fullName: string, password: string): Promise<{ companyId: string }> {
    const inv = await this.findLive(token);
    if (await this.users.findByEmailInsensitive(inv.email)) throw new CompanyUserError('ACCOUNT_EXISTS_SIGN_IN', 'Sign in with your existing account to accept this invitation.');
    const name = (fullName ?? '').trim() || inv.fullName || inv.email;
    const user = await this.auth.createInvitedIdentity(inv.email, name.slice(0, 255), password);
    try {
      return await this.complete(inv, user);
    } catch (err) {
      // The identity was created for THIS invitation only; if acceptance cannot complete, do not leave a half-onboarded account behind.
      await this.users.setStatus(user.id, 'disabled').catch(() => undefined);
      throw err;
    }
  }

  private async complete(inv: CompanyInvitation, user: User): Promise<{ companyId: string }> {
    const companyId = inv.companyId;
    const company = await this.companies.findById(companyId);
    if (!company) throw new CompanyUserError('INVITATION_INVALID', 'This invitation is not valid.');
    if (await this.memberships.findByUserAndCompany(user.id, companyId)) throw new CompanyUserError('ALREADY_MEMBER', 'You are already a member of this Company.');

    const companyDs = await this.connections.getDataSource(companyId);

    // The inviter must STILL hold the authority to have issued this invitation (members.manage) and every grant of every invited role.
    const inviterCtx = await this.contexts.load(inv.invitedBy, companyId, companyDs.manager);
    const stillAllowed = inviterCtx.hasAtLeast(COMPANY_MEMBERS_MANAGE_NODE, 'editable') && (await grantsBeyondActor(companyDs.manager, inviterCtx, inv.roleKeys)).length === 0;
    if (!stillAllowed) throw new CompanyUserError('INVITATION_INVALID', 'This invitation is not valid.');
    const known = await loadRolesByKeys(companyDs.manager, inv.roleKeys);
    if (known.length !== inv.roleKeys.length) throw new CompanyUserError('INVITATION_INVALID', 'This invitation is not valid.');

    // Atomic single-use claim.
    const claimed = await this.invitations.createQueryBuilder().update(CompanyInvitation).set({ status: 'accepted', acceptedAt: new Date(), acceptedUserId: user.id }).where('"id" = :id AND "status" = \'pending\' AND "expiresAt" > now()', { id: inv.id }).execute();
    if (!claimed.affected) throw new CompanyUserError('INVITATION_INVALID', 'This invitation is not valid.');

    const correlationId = randomUUID();
    try {
      await this.memberships.create({ userId: user.id, companyId, roleKey: primaryRoleKey(inv.roleKeys), status: 'active', invitedBy: inv.invitedBy });
    } catch (err) {
      // Nothing was granted: give the invitation back so it can still be used (e.g. after a transient failure).
      await this.invitations.update({ id: inv.id }, { status: 'pending', acceptedAt: null, acceptedUserId: null }).catch(() => undefined);
      throw err;
    }
    const operation = await this.operations.start(user.id, companyId, 'grant', null, null, { previousRoleKeys: [], targetRoleKeys: inv.roleKeys });
    try {
      await this.operations.markApplying(operation.id);
      await companyDs.transaction(async (manager) => {
        await lockAdministration(manager, companyId);
        await replaceUserRoles(manager, user.id, known.map((r) => r.id));
        for (const key of inv.roleKeys) await this.audit.record({ actorUserId: inv.invitedBy, organizationId: null, action: 'role.assigned', resource: 'user_role', resourceId: user.id, result: 'success', correlationId, before: null, after: { roleKey: key } }, manager);
        await this.audit.record({ actorUserId: user.id, organizationId: null, action: 'membership.accepted', resource: 'membership', resourceId: user.id, result: 'success', correlationId, before: null, after: { roleKeys: inv.roleKeys, invitationId: inv.id } }, manager);
      });
      await this.operations.markCompleted(operation.id);
    } catch (err) {
      await this.operations.markFailed(operation.id, err instanceof Error ? err.message : String(err));
      this.logger.error(`Invitation ${inv.id} accepted but the Company-side role write failed; left to reconciliation`, err instanceof Error ? err.stack : String(err));
      // The membership exists with no roles yet: least privilege (sees nothing). The reconciler replays `targetRoleKeys`.
    }
    await this.audit.record({ actorUserId: user.id, organizationId: null, action: 'company.membership.accepted', resource: 'membership', resourceId: user.id, result: 'success', correlationId, after: { companyId, roleKeys: inv.roleKeys, invitationId: inv.id } });
    return { companyId };
  }

  /** Unknown, expired, accepted and revoked tokens are indistinguishable to the caller. */
  private async findLive(token: string): Promise<CompanyInvitation> {
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) throw new CompanyUserError('INVITATION_INVALID', 'This invitation is not valid.');
    const inv = await this.invitations.findOne({ where: { tokenHash: hashInvitationToken(token) } });
    if (!inv || inv.status !== 'pending' || inv.expiresAt.getTime() <= Date.now()) throw new CompanyUserError('INVITATION_INVALID', 'This invitation is not valid.');
    return inv;
  }

  private async expireDue(companyId: string): Promise<void> {
    await this.invitations.createQueryBuilder().update(CompanyInvitation).set({ status: 'expired' }).where('"companyId" = :companyId AND "status" = \'pending\' AND "expiresAt" <= now()', { companyId }).execute();
  }

  private view(i: CompanyInvitation): InvitationView {
    return { id: i.id, email: i.email, fullName: i.fullName, roleKeys: i.roleKeys, status: i.status, expiresAt: new Date(i.expiresAt).toISOString(), createdAt: new Date(i.createdAt).toISOString(), invitedBy: i.invitedBy };
  }

  private async auditBoth(companyDs: DataSource, actorUserId: string, action: string, resourceId: string, correlationId: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null): Promise<void> {
    await this.audit.record({ actorUserId, organizationId: null, action: `company.${action}`, resource: 'invitation', resourceId, result: 'success', correlationId, before, after });
    await this.audit.record({ actorUserId, organizationId: null, action, resource: 'invitation', resourceId, result: 'success', correlationId, before, after }, companyDs.manager as EntityManager);
  }
}
