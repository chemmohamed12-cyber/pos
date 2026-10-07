import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { MembershipService } from '../company/membership.service';
import { CompanyConnectionManagerService } from '../database-registry/company-connection-manager.service';

export interface CompanyViewContext {
  companyId: string;
  /** The validated Company's own database manager (roles / permissions live there). */
  manager: EntityManager;
}

/**
 * For the read-only "what can I see" endpoints (`GET /me/navigation`,
 * `GET /me/entitlements`) that are guarded by `JwtAuthGuard` only, so they also
 * serve platform users who have no Company at all.
 *
 * The JWT `companyId` is a transport claim, never proof. It is accepted here
 * only after the SAME Membership re-validation `CompanyContextGuard` performs;
 * anything that does not validate (no claim, revoked Membership, Company DB not
 * ACTIVE) resolves to `null` and the caller falls back to the platform view.
 * That can never widen what a caller sees or does, because every actual route
 * is still guarded on its own.
 */
@Injectable()
export class CompanyViewContextService {
  constructor(
    private readonly memberships: MembershipService,
    private readonly connections: CompanyConnectionManagerService,
  ) {}

  async resolve(user: { id: string; companyId?: string | null }): Promise<CompanyViewContext | null> {
    if (!user.companyId) return null;
    const membership = await this.memberships.findActiveByUserAndCompany(user.id, user.companyId);
    if (!membership) return null;
    try {
      const ds = await this.connections.getDataSource(user.companyId);
      return { companyId: user.companyId, manager: ds.manager };
    } catch {
      return null;
    }
  }
}
