import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuthenticatedRequest } from '../authentication/jwt-auth.guard';
import { MembershipService } from './membership.service';
import { CompanyService } from './company.service';
import { CompanyNotReadyException, isCompanyOperational } from './company-operational-status';
import { CompanyConnectionManagerService } from '../database-registry/company-connection-manager.service';

export interface CompanyContext {
  companyId: string;
  dataSource: DataSource;
}

export interface CompanyScopedRequest extends AuthenticatedRequest {
  companyContext?: CompanyContext;
}

/**
 * Multi-Company Area 5/6 (2026-09-23, locked decision). Must run AFTER
 * `JwtAuthGuard` (relies on `req.user` being populated) and BEFORE
 * `RolesGuard`/`PermissionGuard` on any route that needs a company-scoped
 * authorization decision — the mandatory link in:
 *
 *   JWT userId + companyId → Membership validation → Company context
 *   → CompanyConnectionManagerService → Company DataSource
 *   → Role/UserRole/RolePermission → Authorization
 *
 * The JWT's `companyId` claim is a transport mechanism ONLY — never
 * authorization proof by itself. This guard re-validates `Membership`
 * against the database on EVERY request (a revoked Membership takes
 * effect on the very next request, never cached), and only resolves a
 * Company `DataSource` — via `CompanyConnectionManagerService`, which
 * itself refuses anything but an `'ACTIVE'` registry — AFTER that
 * validation passes. An unauthorized Company's database is therefore
 * never even connected to, let alone queried.
 */
@Injectable()
export class CompanyContextGuard implements CanActivate {
  constructor(
    private readonly memberships: MembershipService,
    private readonly companies: CompanyService,
    private readonly connections: CompanyConnectionManagerService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<CompanyScopedRequest>();
    if (!request.user) {
      throw new UnauthorizedException('Authentication required before Company context can be validated.');
    }

    const companyId = request.user.companyId;
    if (!companyId) {
      throw new ForbiddenException('This route requires a Company context. Call POST /auth/select-company first.');
    }

    // The Membership check and the control-plane registry row are independent READS, issued together (one round trip of latency instead of two). Reading the registry
    // opens no Company database; the Company DataSource is still requested only after the Membership AND the Company status have been validated, in the original order,
    // so every refusal, its precedence and its message are unchanged. Both reads stay live on EVERY request (no cache).
    const [membership, registry] = await Promise.all([
      this.memberships.findActiveByUserAndCompany(request.user.id, companyId), // F2: a suspended member is refused exactly like a non-member
      this.connections.readRegistry(companyId),
    ]);
    if (!membership) {
      throw new ForbiddenException('You are not a member of this Company.');
    }

    // WP-4.1 / DP-9 Layer 1 (D-3, D-5, O-5): read the CURRENT Company.status on
    // EVERY request — no cache, so Suspension/Decommission takes effect on the
    // very next request even for an already-issued JWT. Runs AFTER the
    // Membership check (a non-member never learns anything about the Company's
    // state) and BEFORE any DataSource is resolved, so a non-READY Company's
    // database is never connected to. A missing Company row is reported exactly
    // like a missing Membership (no existence leak).
    const company = await this.companies.findById(companyId);
    if (!company) {
      throw new ForbiddenException('You are not a member of this Company.');
    }
    if (!isCompanyOperational(company.status)) {
      throw new CompanyNotReadyException();
    }

    const dataSource = await this.connections.getDataSource(companyId, registry);
    request.companyContext = { companyId, dataSource };
    return true;
  }
}
