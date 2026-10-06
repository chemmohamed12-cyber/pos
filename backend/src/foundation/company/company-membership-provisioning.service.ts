import { Injectable, NotFoundException } from '@nestjs/common';
import { MembershipService } from './membership.service';
import { Membership } from './membership.entity';
import { MembershipOperationService } from './membership-operation.service';
import { CompanyConnectionManagerService } from '../database-registry/company-connection-manager.service';
import { UsersService } from '../identity/users.service';
import { AuditService } from '../audit/audit.service';
import { provisionUserRoleForMembership, deprovisionUserRoleForMembership } from './membership-role-provisioning';

export class LastAdminError extends Error {}

const ADMIN_ROLE_KEY = 'admin';

/**
 * Multi-Company Area 6/5/20/Membership-Management (2026-09-24, D1/D4/D5/D6/D9
 * decisions). The orchestration `MembershipService` itself deliberately
 * does not do (it stays plain CRUD on the Platform-DB row) — granting,
 * revoking, or changing a Membership must ALSO keep the corresponding
 * `UserRole` in that Company's own database in sync, record a durable
 * operation for cross-DB reconciliation (D5 — no distributed transaction
 * exists or will exist across these two databases), and produce an audit
 * record on every attempt, success or failure (D6).
 *
 * D9 (last-Administrator invariant): revoking or role-changing away from
 * `'admin'` is rejected outright when it would leave a Company with zero
 * Administrators — checked BEFORE any write, Platform or Company-side.
 */
@Injectable()
export class CompanyMembershipProvisioningService {
  constructor(
    private readonly memberships: MembershipService,
    private readonly connections: CompanyConnectionManagerService,
    private readonly operations: MembershipOperationService,
    private readonly users: UsersService,
    private readonly audit: AuditService,
  ) {}

  private async countAdmins(companyId: string): Promise<number> {
    const all = await this.memberships.findByCompany(companyId);
    return all.filter((m) => m.roleKey === ADMIN_ROLE_KEY).length;
  }

  /** D1 — Membership Management never creates a `User`; it must already exist. Propagates `UsersService.findById`'s own `NotFoundException` unchanged. */
  async grantMembership(actorUserId: string | null, userId: string, companyId: string, roleKey: string): Promise<Membership> {
    await this.users.findById(userId);

    const membership = await this.memberships.create({ userId, companyId, roleKey });
    const operation = await this.operations.start(userId, companyId, 'grant', null, roleKey);

    try {
      await this.operations.markApplying(operation.id);
      const dataSource = await this.connections.getDataSource(companyId);
      await provisionUserRoleForMembership(dataSource, userId, roleKey);
      await this.operations.markCompleted(operation.id);
      await this.audit.record({
        actorUserId,
        organizationId: null,
        action: 'company.membership.granted',
        resource: 'membership',
        resourceId: membership.id,
        result: 'success',
        correlationId: operation.correlationId,
        after: { userId, companyId, roleKey },
      });
      // Area 14 (2026-09-25) — the Company-DB mutation (UserRole write) gets
      // its own Company-scoped audit record, same correlationId as the
      // Platform-side one above — two records, one operation, never a
      // duplicate (§S2/§4 of the Area 14 Specification).
      await this.audit.record(
        {
          actorUserId,
          organizationId: null,
          action: 'company.membership.granted',
          resource: 'user_role',
          resourceId: userId,
          result: 'success',
          correlationId: operation.correlationId,
          after: { userId, roleKey },
        },
        dataSource.manager,
      );
      return membership;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.operations.markFailed(operation.id, message);
      await this.audit.record({
        actorUserId,
        organizationId: null,
        action: 'company.membership.granted',
        resource: 'membership',
        resourceId: membership.id,
        result: 'failure',
        correlationId: operation.correlationId,
        after: { userId, companyId, roleKey },
      });
      // Re-thrown deliberately: an accepted-but-not-actually-effective grant
      // (Membership exists, no Company-DB role) is not a success from this
      // call's own point of view, even though `MembershipReconciliationScheduler`
      // will keep trying to complete it in the background (D5).
      throw err;
    }
  }

  /**
   * D9 checked before any write. If the Company-DB deprovision step fails
   * after the Platform-DB row is already gone, this does NOT re-throw —
   * the security-relevant effect (access revoked) has already happened;
   * `CompanyContextGuard` denies this user's very next request regardless
   * of whether the Company-DB grant row was cleaned up yet. The orphaned
   * grant is a reconciliation concern (D5), not a caller-visible failure.
   */
  async revokeMembership(actorUserId: string | null, userId: string, companyId: string): Promise<void> {
    const membership = await this.memberships.findByUserAndCompany(userId, companyId);
    if (!membership) return; // nothing to revoke — idempotent

    if (membership.roleKey === ADMIN_ROLE_KEY && (await this.countAdmins(companyId)) <= 1) {
      throw new LastAdminError(`Cannot revoke the last Administrator of Company ${companyId}.`);
    }

    const operation = await this.operations.start(userId, companyId, 'revoke', membership.roleKey, null);
    await this.memberships.revoke(userId, companyId);

    try {
      await this.operations.markApplying(operation.id);
      const dataSource = await this.connections.getDataSource(companyId);
      await deprovisionUserRoleForMembership(dataSource, userId, membership.roleKey);
      await this.operations.markCompleted(operation.id);
      await this.audit.record({
        actorUserId,
        organizationId: null,
        action: 'company.membership.revoked',
        resource: 'membership',
        resourceId: membership.id,
        result: 'success',
        correlationId: operation.correlationId,
        before: { roleKey: membership.roleKey },
      });
      // Area 14 (2026-09-25) — Company-DB mutation gets its own Company-scoped record.
      await this.audit.record(
        {
          actorUserId,
          organizationId: null,
          action: 'company.membership.revoked',
          resource: 'user_role',
          resourceId: userId,
          result: 'success',
          correlationId: operation.correlationId,
          before: { roleKey: membership.roleKey },
        },
        dataSource.manager,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.operations.markFailed(operation.id, message);
      await this.audit.record({
        actorUserId,
        organizationId: null,
        action: 'company.membership.revoked',
        resource: 'membership',
        resourceId: membership.id,
        result: 'failure',
        correlationId: operation.correlationId,
        before: { roleKey: membership.roleKey },
      });
      // Not re-thrown — see doc comment above.
    }
  }

  /**
   * D4 — a dedicated primitive, never `revoke`+`grant` from the HTTP
   * layer (that would create a real "neither role" window). D9 checked
   * before any write, exactly like `revokeMembership`.
   */
  async changeMembershipRole(actorUserId: string | null, userId: string, companyId: string, newRoleKey: string): Promise<Membership> {
    const membership = await this.memberships.findByUserAndCompany(userId, companyId);
    if (!membership) {
      throw new NotFoundException(`No Membership for user ${userId} in Company ${companyId}.`);
    }
    if (membership.roleKey === newRoleKey) {
      return membership; // idempotent no-op
    }
    if (membership.roleKey === ADMIN_ROLE_KEY && newRoleKey !== ADMIN_ROLE_KEY && (await this.countAdmins(companyId)) <= 1) {
      throw new LastAdminError(`Cannot change the last Administrator of Company ${companyId} away from '${ADMIN_ROLE_KEY}'.`);
    }

    const previousRoleKey = membership.roleKey;
    const operation = await this.operations.start(userId, companyId, 'role_change', previousRoleKey, newRoleKey);
    const updated = await this.memberships.updateRole(userId, companyId, newRoleKey);

    try {
      await this.operations.markApplying(operation.id);
      const dataSource = await this.connections.getDataSource(companyId);
      // D4 — one Company-DB transaction, not two independent writes: a crash or
      // failure between deprovision and provision must never leave the user with
      // no role in this Company at all, the exact "no role window" D4 forbids.
      await dataSource.transaction(async (manager) => {
        await deprovisionUserRoleForMembership(manager, userId, previousRoleKey);
        await provisionUserRoleForMembership(manager, userId, newRoleKey);
        // Area 14 (2026-09-25) — same transaction as the role swap itself:
        // the Company-scoped audit record for this mutation is atomic with
        // the mutation it describes, not a separate best-effort write after.
        await this.audit.record(
          {
            actorUserId,
            organizationId: null,
            action: 'company.membership.role_changed',
            resource: 'user_role',
            resourceId: userId,
            result: 'success',
            correlationId: operation.correlationId,
            before: { roleKey: previousRoleKey },
            after: { roleKey: newRoleKey },
          },
          manager,
        );
      });
      await this.operations.markCompleted(operation.id);
      await this.audit.record({
        actorUserId,
        organizationId: null,
        action: 'company.membership.role_changed',
        resource: 'membership',
        resourceId: updated.id,
        result: 'success',
        correlationId: operation.correlationId,
        before: { roleKey: previousRoleKey },
        after: { roleKey: newRoleKey },
      });
      return updated;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.operations.markFailed(operation.id, message);
      await this.audit.record({
        actorUserId,
        organizationId: null,
        action: 'company.membership.role_changed',
        resource: 'membership',
        resourceId: updated.id,
        result: 'failure',
        correlationId: operation.correlationId,
        before: { roleKey: previousRoleKey },
        after: { roleKey: newRoleKey },
      });
      // Re-thrown — same reasoning as grantMembership: the caller asked for a
      // specific role and the Company DB does not yet reflect it.
      throw err;
    }
  }
}
