import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { IsString, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from './company-context.guard';
import { PermissionGuard } from '../permission/permission.guard';
import { RequirePermission } from '../permission/require-permission.decorator';
import { CompanyMembershipProvisioningService } from './company-membership-provisioning.service';
import { MembershipService } from './membership.service';
import { COMPANY_MEMBERS_MANAGE_NODE } from './company-role-seeding';

class GrantMembershipDto {
  @IsString()
  userId!: string;

  @IsString()
  @MinLength(1)
  roleKey!: string;
}

class ChangeMembershipRoleDto {
  @IsString()
  @MinLength(1)
  roleKey!: string;
}

/**
 * Membership HTTP Management (2026-09-24, D2). Company-scoped path — the
 * Company being acted on is ALWAYS `req.companyContext.companyId`, the one
 * `CompanyContextGuard` already validated fresh against `Membership` for
 * THIS request's token. There is deliberately no `:companyId` route
 * param: taking one and trusting it would let a caller's own validated
 * Company context be silently overridden by a URL value naming a
 * different Company (a confused-deputy shape), which no other endpoint in
 * this codebase permits either — every other Company-scoped operation
 * gets its Company exclusively from the validated request context, never
 * a client-supplied identifier.
 *
 * D1 (existing User only) and D9 (last-Administrator invariant) are
 * enforced by `CompanyMembershipProvisioningService` itself — this
 * controller adds no business logic beyond guard/permission wiring.
 */
@Controller('memberships')
@UseGuards(JwtAuthGuard, CompanyContextGuard, PermissionGuard)
@RequirePermission(COMPANY_MEMBERS_MANAGE_NODE, 'editable')
export class CompanyMembershipController {
  constructor(
    private readonly provisioning: CompanyMembershipProvisioningService,
    private readonly memberships: MembershipService,
  ) {}

  @Get()
  async list(@Req() req: CompanyScopedRequest) {
    if (!req.companyContext) throw new UnauthorizedException();
    const rows = await this.memberships.findByCompany(req.companyContext.companyId);
    return { success: true, data: rows };
  }

  @Post()
  async grant(@Req() req: CompanyScopedRequest, @Body() dto: GrantMembershipDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const membership = await this.provisioning.grantMembership(req.user.id, dto.userId, req.companyContext.companyId, dto.roleKey);
    return { success: true, data: membership };
  }

  @Delete(':userId')
  async revoke(@Req() req: CompanyScopedRequest, @Param('userId') userId: string) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    await this.provisioning.revokeMembership(req.user.id, userId, req.companyContext.companyId);
    return { success: true, data: { revoked: true } };
  }

  @Patch(':userId')
  async changeRole(@Req() req: CompanyScopedRequest, @Param('userId') userId: string, @Body() dto: ChangeMembershipRoleDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const membership = await this.provisioning.changeMembershipRole(req.user.id, userId, req.companyContext.companyId, dto.roleKey);
    return { success: true, data: membership };
  }
}
