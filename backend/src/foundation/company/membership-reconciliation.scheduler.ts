import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { MembershipOperationService } from './membership-operation.service';
import { MembershipService } from './membership.service';
import { CompanyConnectionManagerService } from '../database-registry/company-connection-manager.service';
import { AuditService } from '../audit/audit.service';
import { provisionUserRoleForMembership, deprovisionUserRoleForMembership } from './membership-role-provisioning';
import { MembershipOperation } from './membership-operation.entity';
import { currentRoleKeys, primaryRoleKey } from './company-user-roles';

const MAX_ATTEMPTS = 5;
const POLL_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Membership HTTP Management (2026-09-24, D5). Same `OnModuleInit` +
 * `setInterval` + `OnModuleDestroy` shape as `ApprovalExpiryScheduler`/
 * `PreliminaryHoldExpiryScheduler`/`ClosingSnapshotRecoveryScheduler` —
 * the established scheduling precedent in this codebase.
 *
 * D5's decided substitute for a distributed transaction: sweeps every
 * `MembershipOperation` still `FAILED` and under the attempt cap, resolves
 * THAT operation's own `companyId` via `CompanyConnectionManagerService`
 * (never ambient), and retries exactly the Company-DB step that didn't
 * land the first time. An operation that exhausts `MAX_ATTEMPTS` simply
 * stops being picked up (`MembershipOperationService.findRetryable`'s own
 * `attempts < max` filter) — it stays `FAILED`, visible for manual/ops
 * follow-up, rather than retrying forever.
 *
 * Staleness guard (`grant`/`role_change` only): the current `Membership`
 * is re-checked against `targetRoleKey` before touching the Company DB.
 * If it was revoked, or moved on to yet another role since this operation
 * was recorded, blindly retrying would re-apply a decision that is no
 * longer current — this operation is marked `COMPLETED` (there is nothing
 * left for it to correctly do) WITHOUT ever opening a Company connection.
 * `revoke` needs no such check — the Platform-DB Membership row is
 * already gone by the time a revoke operation exists at all, so
 * deprovisioning is always still the correct action to retry.
 *
 * `role_change` retries wrap deprovision-old + provision-new in ONE real
 * Company-DB transaction — stricter than the live/synchronous path
 * (`CompanyMembershipProvisioningService.changeMembershipRole`, which
 * accepts a brief cross-write risk healed by this very reconciliation).
 * This retry pass IS the healing mechanism, so it holds itself to a
 * higher bar: it must not itself create a new partial state needing yet
 * another retry.
 */
@Injectable()
export class MembershipReconciliationScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MembershipReconciliationScheduler.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly operations: MembershipOperationService,
    private readonly memberships: MembershipService,
    private readonly connections: CompanyConnectionManagerService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => {
      this.runOnce().catch((err) => this.logger.error('Membership reconciliation sweep failed', err instanceof Error ? err.stack : String(err)));
    }, POLL_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<void> {
    const retryable = await this.operations.findRetryable(MAX_ATTEMPTS);
    for (const op of retryable) {
      try {
        if (op.operationType === 'role_set') {
          // F2: the Company DB (`user_roles`) is the authority and is already committed; the only thing left to heal is the platform MIRROR, which is
          // always recomputed from the authority (never from the ledger), so a stale/duplicate operation can never overwrite a newer decision.
          const current = await this.memberships.findByUserAndCompany(op.userId, op.companyId);
          if (current) {
            await this.operations.markRetrying(op.id);
            const ds = await this.connections.getDataSource(op.companyId);
            await this.memberships.setRoleMirror(op.userId, op.companyId, primaryRoleKey(await currentRoleKeys(ds.manager, op.userId), current.roleKey));
          }
          await this.operations.markCompleted(op.id);
          continue;
        }
        if (op.operationType === 'grant' && op.targetRoleKeys) {
          // F2 invitation acceptance: replay the full role set (idempotent) while the membership still exists.
          const current = await this.memberships.findByUserAndCompany(op.userId, op.companyId);
          if (!current) {
            await this.operations.markCompleted(op.id);
            continue;
          }
          await this.operations.markRetrying(op.id);
          const ds = await this.connections.getDataSource(op.companyId);
          await ds.transaction(async (manager) => {
            for (const key of op.targetRoleKeys!) await provisionUserRoleForMembership(manager, op.userId, key);
            await this.recordCompanyAudit(op, 'company.membership.granted', manager, { after: { userId: op.userId, roleKeys: op.targetRoleKeys } });
          });
          await this.operations.markCompleted(op.id);
          continue;
        }
        if (op.operationType === 'grant' || op.operationType === 'role_change') {
          const current = await this.memberships.findByUserAndCompany(op.userId, op.companyId);
          if (!current || current.roleKey !== op.targetRoleKey) {
            await this.operations.markCompleted(op.id);
            continue;
          }
        }

        await this.operations.markRetrying(op.id);
        const dataSource = await this.connections.getDataSource(op.companyId);

        if (op.operationType === 'grant') {
          await provisionUserRoleForMembership(dataSource, op.userId, op.targetRoleKey!);
          await this.recordCompanyAudit(op, 'company.membership.granted', dataSource.manager, { after: { userId: op.userId, roleKey: op.targetRoleKey } });
        } else if (op.operationType === 'revoke') {
          await deprovisionUserRoleForMembership(dataSource, op.userId, op.previousRoleKey!);
          await this.recordCompanyAudit(op, 'company.membership.revoked', dataSource.manager, { before: { roleKey: op.previousRoleKey } });
        } else {
          await dataSource.transaction(async (manager) => {
            await deprovisionUserRoleForMembership(manager, op.userId, op.previousRoleKey!);
            await provisionUserRoleForMembership(manager, op.userId, op.targetRoleKey!);
            // Area 14 (2026-09-25) — same transaction as the replayed mutation itself.
            await this.recordCompanyAudit(op, 'company.membership.role_changed', manager, { before: { roleKey: op.previousRoleKey }, after: { roleKey: op.targetRoleKey } });
          });
        }

        await this.operations.markCompleted(op.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.operations.markFailed(op.id, message);
        this.logger.error(`Membership reconciliation failed for operation ${op.id} (Company ${op.companyId})`, message);
      }
    }
  }

  /** Area 14 (2026-09-25) — the Company-DB side of a replayed mutation gets its own Company-scoped audit record, same `correlationId` the operation itself already carries. */
  private async recordCompanyAudit(
    op: MembershipOperation,
    action: 'company.membership.granted' | 'company.membership.revoked' | 'company.membership.role_changed',
    manager: EntityManager,
    payload: { before?: Record<string, unknown>; after?: Record<string, unknown> },
  ): Promise<void> {
    await this.audit.record(
      {
        actorUserId: null,
        organizationId: null,
        action,
        resource: 'user_role',
        resourceId: op.userId,
        result: 'success',
        correlationId: op.correlationId,
        ...payload,
      },
      manager,
    );
  }
}
