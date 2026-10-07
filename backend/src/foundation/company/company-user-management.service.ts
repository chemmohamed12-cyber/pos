import { randomUUID } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AuthorizationContext } from '../authorization/authorization-context';
import { AuditService } from '../audit/audit.service';
import { classifyRole, RoleType } from '../authorization/role-classification';
import { UsersService } from '../identity/users.service';
import { MembershipService } from './membership.service';
import { MembershipOperationService } from './membership-operation.service';
import {
  ADMIN_ROLE_KEYS,
  adminHolderUserIds,
  CompanyUserError,
  currentRoleKeys,
  grantsBeyondActor,
  loadRolesByKeys,
  lockAdministration,
  normalizeRoleKeys,
  primaryRoleKey,
  replaceUserRoles,
} from './company-user-roles';

/** Who is acting: the validated request user plus their request-scoped AuthorizationContext in THIS Company. */
export interface CompanyActor {
  userId: string;
  authz: AuthorizationContext;
}

export interface DirectoryRow {
  userId: string;
  fullName: string;
  email: string;
  identityStatus: string;
  membership: { id: string; status: string; joinedAt: string; lastAccessAt: string | null; invitedBy: string | null; authzVersion: number; kind: 'member' | 'support'; expiresAt: string | null; reason: string | null };
  roles: Array<{ key: string; type: RoleType }>;
  isAdministrator: boolean;
}

export interface AssignableRole {
  key: string;
  type: RoleType;
  nameEn: string | null;
  nameAr: string | null;
  /** Inactive roles cannot be newly assigned. */
  isActive: boolean;
  /** False when the actor does not hold every grant the role carries — assigning it would exceed the grantor's own authority. */
  assignable: boolean;
}

/**
 * Authorization Foundation F2 — Company user management. The Company being acted on is ALWAYS the one `CompanyContextGuard` validated for this
 * request (the caller passes its DataSource and id; nothing here accepts a client-supplied Company).
 *
 * Authority model: the Company database's `user_roles` is the single source of truth for what a member can do; the control-plane membership is
 * "belonging" (+ status) and a compatibility mirror of the primary role. Every role/status change therefore changes the AUTHORITY first, inside
 * one Company transaction that also holds the Company's administration lock, then syncs the mirror through the durable operation ledger.
 */
@Injectable()
export class CompanyUserManagementService {
  private readonly logger = new Logger(CompanyUserManagementService.name);

  constructor(
    private readonly memberships: MembershipService,
    private readonly operations: MembershipOperationService,
    private readonly users: UsersService,
    private readonly audit: AuditService,
  ) {}

  /** The directory: THIS Company's members only (control-plane rows keyed by the validated companyId → identities by those ids → roles from the Company DB). */
  async directory(companyId: string, companyDs: DataSource): Promise<DirectoryRow[]> {
    const members = await this.memberships.findByCompany(companyId);
    if (members.length === 0) return [];
    const ids = members.map((m) => m.userId);
    const [identities, roleRows] = await Promise.all([
      this.users.findByIds(ids),
      companyDs.manager.query(
        `SELECT ur."userId" AS "userId", r."key" AS "key", r."type" AS "type" FROM "user_roles" ur INNER JOIN "roles" r ON r."id" = ur."roleId" WHERE ur."userId" = ANY($1::uuid[]) ORDER BY r."key"`,
        [ids],
      ) as Promise<Array<{ userId: string; key: string; type: RoleType }>>,
    ]);
    const byId = new Map(identities.map((u) => [u.id, u]));
    const rolesBy = new Map<string, string[]>();
    const typeOf = new Map<string, RoleType>();
    for (const r of roleRows) {
      rolesBy.set(r.userId, [...(rolesBy.get(r.userId) ?? []), r.key]);
      typeOf.set(r.key, r.type);
    }
    return members
      .map((m) => {
        const u = byId.get(m.userId);
        if (!u) return null; // identity row gone: never surfaced
        const keys = rolesBy.get(m.userId) ?? [];
        return {
          userId: m.userId,
          fullName: u.fullName,
          email: u.email,
          identityStatus: u.status,
          membership: { id: m.id, status: m.status, joinedAt: new Date(m.joinedAt).toISOString(), lastAccessAt: m.lastAccessAt ? new Date(m.lastAccessAt).toISOString() : null, invitedBy: m.invitedBy, authzVersion: m.authzVersion, kind: m.kind ?? 'member', expiresAt: m.expiresAt ? new Date(m.expiresAt).toISOString() : null, reason: m.reason ?? null },
          roles: keys.map((key) => ({ key, type: typeOf.get(key) ?? classifyRole(key) })),
          isAdministrator: keys.some((k) => ADMIN_ROLE_KEYS.includes(k)),
        } as DirectoryRow;
      })
      .filter((r): r is DirectoryRow => r !== null)
      .sort((a, b) => a.fullName.localeCompare(b.fullName));
  }

  /** The Company's roles with whether THIS actor may assign each (anti-elevation preview — the server re-checks on every write). */
  async assignableRoles(companyDs: DataSource, actor: CompanyActor): Promise<AssignableRole[]> {
    const rows: Array<{ key: string; type: RoleType; nameEn: string | null; nameAr: string | null; isActive: boolean }> = await companyDs.manager.query(`SELECT "key", "type", "nameEn", "nameAr", "isActive" FROM "roles" ORDER BY "key"`);
    const beyond = new Set((await grantsBeyondActor(companyDs.manager, actor.authz, rows.map((r) => r.key))).map((g) => g.roleKey));
    return rows.map((r) => ({ key: r.key, type: r.type, nameEn: r.nameEn, nameAr: r.nameAr, isActive: r.isActive, assignable: r.isActive && !beyond.has(r.key) }));
  }

  /**
   * Replaces the member's FULL role set (0..n roles). `roleKeys = []` leaves the member with no roles — they see nothing (least privilege).
   * Refused: changing your own roles; adding/removing a role carrying grants you do not hold; unknown roles; removing the last administrator.
   */
  async setRoles(actor: CompanyActor, companyId: string, companyDs: DataSource, targetUserId: string, roleKeysInput: readonly unknown[]): Promise<{ roleKeys: string[]; changed: boolean }> {
    const target = normalizeRoleKeys(roleKeysInput);
    if (actor.userId === targetUserId) {
      await this.denied(actor, companyId, companyDs, 'role.assignment.denied', targetUserId, { reason: 'self_role_change', requested: target });
      throw new CompanyUserError('SELF_ROLE_CHANGE', 'You cannot change your own roles; ask another administrator.');
    }
    const membership = await this.memberships.findByUserAndCompany(targetUserId, companyId);
    if (!membership) throw new CompanyUserError('NOT_A_MEMBER', 'That user is not a member of this Company.');
    if (membership.kind === 'support') throw new CompanyUserError('SUPPORT_ACCESS_FIXED', 'Support access carries a fixed read-only role; end the access instead.');

    const correlationId = randomUUID();
    let previous: string[] = [];
    let committed = false;
    const operation = await this.operations.start(targetUserId, companyId, 'role_set', membership.roleKey, null, { previousRoleKeys: null, targetRoleKeys: target });
    try {
      await this.operations.markApplying(operation.id);
      await companyDs.transaction(async (manager) => {
        await lockAdministration(manager, companyId);
        previous = await currentRoleKeys(manager, targetUserId);
        const added = target.filter((k) => !previous.includes(k));
        const removed = previous.filter((k) => !target.includes(k));
        if (added.length === 0 && removed.length === 0) return;

        const known = await loadRolesByKeys(manager, target);
        const unknown = target.filter((k) => !known.some((r) => r.key === k));
        if (unknown.length) throw new CompanyUserError('UNKNOWN_ROLE', `Unknown role(s): ${unknown.join(', ')}.`, { unknown });
        const inactive = added.filter((k) => known.find((r) => r.key === k)?.isActive === false);
        if (inactive.length) throw new CompanyUserError('ROLE_INACTIVE', `Inactive role(s) cannot be newly assigned: ${inactive.join(', ')}.`, { inactive });

        const beyond = await grantsBeyondActor(manager, actor.authz, [...added, ...removed]);
        if (beyond.length) {
          throw new CompanyUserError('ROLE_EXCEEDS_GRANTOR', 'Roles that carry critical permissions can only be assigned or removed by someone who holds those permissions explicitly.', { roles: [...new Set(beyond.map((g) => g.roleKey))], criticalNodes: [...new Set(beyond.map((g) => g.nodeKey))] });
        }

        if (previous.some((k) => ADMIN_ROLE_KEYS.includes(k)) && !target.some((k) => ADMIN_ROLE_KEYS.includes(k))) {
          await this.assertAnotherActiveAdmin(companyId, manager, targetUserId);
        }

        await replaceUserRoles(manager, targetUserId, known.map((r) => r.id));
        for (const key of added) await this.companyAudit(manager, actor.userId, 'role.assigned', targetUserId, correlationId, null, { roleKey: key });
        for (const key of removed) await this.companyAudit(manager, actor.userId, 'role.removed', targetUserId, correlationId, { roleKey: key }, null);
        committed = true;
      });
    } catch (err) {
      await this.operations.markAborted(operation.id, err instanceof Error ? err.message : String(err));
      if (err instanceof CompanyUserError && (err.code === 'ROLE_EXCEEDS_GRANTOR' || err.code === 'LAST_ADMIN')) {
        await this.denied(actor, companyId, companyDs, err.code === 'LAST_ADMIN' ? 'role.assignment.blocked_last_admin' : 'role.assignment.denied', targetUserId, { reason: err.code.toLowerCase(), requested: target, detail: err.details ?? null });
      }
      throw err;
    }

    if (!committed) {
      await this.operations.markAborted(operation.id, 'no change');
      return { roleKeys: previous, changed: false };
    }

    // Mirror + platform audit AFTER the authority committed. A failure here never undoes the (already effective) authority change: the ledger
    // row stays FAILED and the reconciler recomputes the mirror from the Company DB.
    try {
      await this.memberships.setRoleMirror(targetUserId, companyId, primaryRoleKey(target, membership.roleKey));
      await this.operations.markCompleted(operation.id);
    } catch (err) {
      await this.operations.markFailed(operation.id, err instanceof Error ? err.message : String(err));
      this.logger.error(`Role-set mirror sync failed for ${targetUserId} in ${companyId}; left to reconciliation`, err instanceof Error ? err.stack : String(err));
    }
    await this.audit.record({
      actorUserId: actor.userId,
      organizationId: null,
      action: 'company.membership.roles_changed',
      resource: 'membership',
      resourceId: membership.id,
      result: 'success',
      correlationId,
      before: { roleKeys: previous },
      after: { roleKeys: target },
    });
    return { roleKeys: target, changed: true };
  }

  /** Suspend or re-activate THIS Company's membership only (never the identity). A suspended member is refused at the guard on the next request. */
  async setStatus(actor: CompanyActor, companyId: string, companyDs: DataSource, targetUserId: string, status: 'active' | 'suspended'): Promise<void> {
    if (actor.userId === targetUserId) throw new CompanyUserError('SELF_ROLE_CHANGE', 'You cannot change your own membership status.');
    const membership = await this.memberships.findByUserAndCompany(targetUserId, companyId);
    if (!membership) throw new CompanyUserError('NOT_A_MEMBER', 'That user is not a member of this Company.');
    if (membership.kind === 'support') throw new CompanyUserError('SUPPORT_ACCESS_FIXED', 'Support access cannot be suspended; end the access instead.');
    if (membership.status === status) return;
    const correlationId = randomUUID();
    await companyDs.transaction(async (manager) => {
      await lockAdministration(manager, companyId);
      if (status === 'suspended') {
        const keys = await currentRoleKeys(manager, targetUserId);
        if (keys.some((k) => ADMIN_ROLE_KEYS.includes(k))) await this.assertAnotherActiveAdmin(companyId, manager, targetUserId);
      } else {
        // Re-activation restores access with the roles the member still holds — it never grants anything new (no automatic elevation).
      }
      await this.memberships.setStatus(targetUserId, companyId, status);
      await this.companyAudit(manager, actor.userId, status === 'suspended' ? 'membership.suspended' : 'membership.reactivated', targetUserId, correlationId, { status: membership.status }, { status });
    });
    await this.audit.record({
      actorUserId: actor.userId,
      organizationId: null,
      action: status === 'suspended' ? 'company.membership.suspended' : 'company.membership.reactivated',
      resource: 'membership',
      resourceId: membership.id,
      result: 'success',
      correlationId,
      before: { status: membership.status },
      after: { status },
    });
  }

  /** Removes the member from THIS Company: roles first (authority), then the membership. History stays in the audit chain. */
  async removeMember(actor: CompanyActor, companyId: string, companyDs: DataSource, targetUserId: string): Promise<void> {
    if (actor.userId === targetUserId) throw new CompanyUserError('SELF_ROLE_CHANGE', 'You cannot remove yourself from the Company.');
    const membership = await this.memberships.findByUserAndCompany(targetUserId, companyId);
    if (!membership) return; // idempotent
    const correlationId = randomUUID();
    let removedRoles: string[] = [];
    await companyDs.transaction(async (manager) => {
      await lockAdministration(manager, companyId);
      removedRoles = await currentRoleKeys(manager, targetUserId);
      if (removedRoles.some((k) => ADMIN_ROLE_KEYS.includes(k))) await this.assertAnotherActiveAdmin(companyId, manager, targetUserId);
      const beyond = await grantsBeyondActor(manager, actor.authz, removedRoles);
      if (beyond.length) throw new CompanyUserError('ROLE_EXCEEDS_GRANTOR', 'You can only remove members whose critical permissions you hold explicitly yourself.', { roles: [...new Set(beyond.map((g) => g.roleKey))], criticalNodes: [...new Set(beyond.map((g) => g.nodeKey))] });
      await replaceUserRoles(manager, targetUserId, []);
      // F6: explicit access-scope grants die with the membership — a person invited again later must not silently regain a scope they were removed with
      if ((await manager.query(`SELECT to_regclass('access_scopes')::text AS "t"`))[0]?.t) await manager.query(`DELETE FROM "access_scopes" WHERE "userId" = $1`, [targetUserId]);
      await this.memberships.revoke(targetUserId, companyId);
      await this.companyAudit(manager, actor.userId, membership.kind === 'support' ? 'support_access.revoked' : 'membership.removed', targetUserId, correlationId, { roleKeys: removedRoles, status: membership.status, reason: membership.reason ?? null }, membership.kind === 'support' ? { by: 'company' } : null);
    });
    await this.audit.record({
      actorUserId: actor.userId,
      organizationId: null,
      action: membership.kind === 'support' ? 'platform.support_access.revoked' : 'company.membership.removed',
      resource: 'membership',
      resourceId: membership.id,
      result: 'success',
      correlationId,
      before: { roleKeys: removedRoles, status: membership.status },
    });
  }

  /** Last-administrator protection, counted on the AUTHORITY: holders of an administrator role in the Company DB who still have an ACTIVE membership, excluding the one being changed. */
  async assertAnotherActiveAdmin(companyId: string, manager: EntityManager, excludeUserId: string): Promise<void> {
    const holders = (await adminHolderUserIds(manager)).filter((id) => id !== excludeUserId);
    if (holders.length > 0) {
      const active = new Set((await this.memberships.findByCompany(companyId)).filter((m) => m.status === 'active').map((m) => m.userId));
      if (holders.some((id) => active.has(id))) return;
    }
    throw new CompanyUserError('LAST_ADMIN', 'A Company must always keep at least one active administrator.');
  }

  private async companyAudit(manager: EntityManager, actorUserId: string, action: string, targetUserId: string, correlationId: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null): Promise<void> {
    await this.audit.record({ actorUserId, organizationId: null, action, resource: 'user_role', resourceId: targetUserId, result: 'success', correlationId, before, after }, manager);
  }

  /** A refused sensitive action is itself audited (result `denied`), in the Company's own audit chain. */
  private async denied(actor: CompanyActor, _companyId: string, companyDs: DataSource, action: string, targetUserId: string, detail: Record<string, unknown>): Promise<void> {
    try {
      await this.audit.record({ actorUserId: actor.userId, organizationId: null, action, resource: 'user_role', resourceId: targetUserId, result: 'denied', correlationId: randomUUID(), after: detail }, companyDs.manager);
    } catch (err) {
      this.logger.warn(`Could not record denied-action audit: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
