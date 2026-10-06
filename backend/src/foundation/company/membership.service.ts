import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Membership } from './membership.entity';

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

  async create(data: Pick<Membership, 'userId' | 'companyId' | 'roleKey'>): Promise<Membership> {
    return this.memberships.save(this.memberships.create(data));
  }

  async findByUserAndCompany(userId: string, companyId: string): Promise<Membership | null> {
    return this.memberships.findOne({ where: { userId, companyId } });
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
