import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Membership, MembershipStatus } from './membership.entity';

/**
 * Multi-Company Phase 3 V7, Area 6. Plain CRUD only — no role-existence
 * validation here. `roleKey` cannot be FK-validated (it names a row in a
 * different physical database per Company); V7's own invariant text says
 * this is guaranteed by provisioning SEQUENCING (role catalog seeded
 * before membership becomes active), not by a runtime check on this
 * entity. See `company-role-seeding.ts` and `DatabaseProvisioningService`.
 */
@Injectable()
export class MembershipService {
  constructor(@InjectRepository(Membership) private readonly memberships: Repository<Membership>) {}

  async create(data: Pick<Membership, 'userId' | 'companyId' | 'roleKey'> & Partial<Pick<Membership, 'status' | 'invitedBy' | 'kind' | 'expiresAt' | 'reason' | 'grantedBy'>>): Promise<Membership> {
    return this.memberships.save(this.memberships.create(data));
  }

  /** The membership row in ANY status (provisioning / management paths). Access decisions use `findActiveByUserAndCompany`. */
  async findByUserAndCompany(userId: string, companyId: string): Promise<Membership | null> {
    return this.memberships.findOne({ where: { userId, companyId } });
  }

  /**
   * F2: the membership that GRANTS ACCESS — `status = 'active'` only. A `suspended` member is a member (the row, history and roles stay) but is
   * refused by `CompanyContextGuard`, `select-company`, refresh and the Company view on the very next request. Every access-deciding read uses this.
   */
  async findActiveByUserAndCompany(userId: string, companyId: string): Promise<Membership | null> {
    // F4: an EXPIRED support membership is refused exactly like a missing one (time-boxed access has no grace period).
    return this.memberships
      .createQueryBuilder('m')
      .where('m."userId" = :userId AND m."companyId" = :companyId AND m."status" = :status AND (m."expiresAt" IS NULL OR m."expiresAt" > now())', { userId, companyId, status: 'active' })
      .getOne();
  }

  async findByCompany(companyId: string): Promise<Membership[]> {
    return this.memberships.find({ where: { companyId } });
  }

  /**
   * Backend Integration Dependency (2026-09-25, CTO-authorized —
   * `GET /memberships/mine`). The one query that must run BEFORE any
   * Company context exists — `userId` only, never `companyId`, since the
   * caller hasn't selected one yet. Platform DB only, exactly like every
   * other method on this service.
   */
  async findByUserId(userId: string): Promise<Membership[]> {
    return this.memberships.find({ where: { userId } });
  }

  /** F2 — suspend / re-activate the member's access to THIS Company only (never the identity). Bumps the authorization version. */
  async setStatus(userId: string, companyId: string, status: MembershipStatus): Promise<void> {
    await this.memberships.createQueryBuilder().update(Membership).set({ status, authzVersion: () => '"authzVersion" + 1' }).where('"userId" = :userId AND "companyId" = :companyId', { userId, companyId }).execute();
  }

  /** F2 — refreshes the compatibility mirror (`roleKey`) from the authority and bumps the authorization version. */
  async setRoleMirror(userId: string, companyId: string, roleKey: string): Promise<void> {
    await this.memberships.createQueryBuilder().update(Membership).set({ roleKey, authzVersion: () => '"authzVersion" + 1' }).where('"userId" = :userId AND "companyId" = :companyId', { userId, companyId }).execute();
  }

  /** F2 — `lastAccessAt` at `select-company`. Best effort by the caller (never blocks a login). */
  async touchLastAccess(userId: string, companyId: string): Promise<void> {
    await this.memberships.update({ userId, companyId }, { lastAccessAt: new Date() });
  }

  /** Multi-Company Area 6/5 (2026-09-23) — removes the platform-DB membership row. Callers needing the corresponding Company-DB `UserRole` deprovisioned too should use `CompanyMembershipProvisioningService.revokeMembership` instead of calling this directly. */
  async revoke(userId: string, companyId: string): Promise<void> {
    await this.memberships.delete({ userId, companyId });
  }

  /** Membership HTTP Management (2026-09-24, D4) — the Platform-DB half of a role change. Callers needing the Company-DB `UserRole` transitioned too should use `CompanyMembershipProvisioningService.changeMembershipRole` instead of calling this directly. */
  async updateRole(userId: string, companyId: string, roleKey: string): Promise<Membership> {
    await this.memberships.update({ userId, companyId }, { roleKey });
    const updated = await this.findByUserAndCompany(userId, companyId);
    if (!updated) {
      throw new Error(`Membership not found after role update: userId=${userId} companyId=${companyId}`);
    }
    return updated;
  }
}
