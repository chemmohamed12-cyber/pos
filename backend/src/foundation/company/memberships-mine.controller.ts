import { Controller, Get, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { JwtAuthGuard, AuthenticatedRequest } from '../authentication/jwt-auth.guard';
import { MembershipService } from './membership.service';
import { CompanyService } from './company.service';
import { CompanyStatus } from './company-status';

interface MembershipMineRow {
  companyId: string;
  companyName: string;
  status: CompanyStatus;
  roleKey: string;
}

/**
 * Backend Integration Dependency (2026-09-25, CTO-authorized). The one
 * platform-level discovery step the Login -> Company Selection flow needs
 * BEFORE any Company context exists: `Membership.findByUserAndCompany`
 * requires a `companyId` the caller doesn't have yet, and
 * `CompanyMembershipController` requires `CompanyContextGuard`, itself
 * requiring a Company context — the exact chicken-and-egg gap this closes.
 *
 * `JwtAuthGuard` ONLY — deliberately no `CompanyContextGuard`, no
 * `PermissionGuard`. The caller has not selected a Company yet; requiring
 * one here would make Company selection impossible. `userId` comes
 * exclusively from `req.user.id` (the validated JWT claim) — never a
 * query param, never any other client-suppliable input. Platform DB only;
 * no Company DataSource is ever created or selected by this endpoint.
 * Read-only — never creates, revokes, or changes a Membership.
 *
 * Response fields are exactly what already exists on `Membership`
 * (`companyId`, `roleKey`) and `Company` (`name`, `status`) — no new
 * metadata, no entitlement information, no company DB query. If the
 * Company Selector UI needs anything beyond these four fields, that is a
 * separate, explicitly-flagged dependency, not an invented extension of
 * this endpoint.
 */
@Controller('memberships/mine')
@UseGuards(JwtAuthGuard)
export class MembershipsMineController {
  constructor(
    private readonly memberships: MembershipService,
    private readonly companies: CompanyService,
  ) {}

  @Get()
  async list(@Req() req: AuthenticatedRequest): Promise<{ success: true; data: MembershipMineRow[] }> {
    if (!req.user) throw new UnauthorizedException();

    const rows = (await this.memberships.findByUserId(req.user.id)).filter((r) => r.status === 'active'); // F2: a suspended membership is not a selectable Company
    const companies = await this.companies.findByIds(rows.map((r) => r.companyId));
    const companyById = new Map(companies.map((c) => [c.id, c]));

    const data: MembershipMineRow[] = rows
      .map((r) => {
        const company = companyById.get(r.companyId);
        if (!company) return null; // orphaned membership row (company deleted) — never surfaced as a selectable option
        return { companyId: r.companyId, companyName: company.name, status: company.status, roleKey: r.roleKey };
      })
      .filter((r): r is MembershipMineRow => r !== null);

    return { success: true, data };
  }
}
