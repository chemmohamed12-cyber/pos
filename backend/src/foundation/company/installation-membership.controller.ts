import { PlatformGuard, RequirePlatform } from '../platform/platform.guard';
import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { IsString, MinLength } from 'class-validator';
import { JwtAuthGuard, AuthenticatedRequest } from '../authentication/jwt-auth.guard';
import { CompanyMembershipProvisioningService } from './company-membership-provisioning.service';
import { MembershipService } from './membership.service';

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
 * Membership HTTP Management (2026-09-24, D2). The SEPARATE
 * Installation-level administrative path — gated by the PLATFORM `admin`
 * role via the existing `RolesGuard` (the same guard/role
 * `AdminController` already uses), never by `CompanyContextGuard`. This is
 * deliberate, not a bypass of the Company authorization boundary: a
 * platform admin is trusted to name any Company explicitly (hence
 * `:companyId` as a real route param here, unlike the Company-scoped
 * controller), for control-plane/provisioning purposes — Area 6's Model B
 * boundary (Company-scoped `RolesGuard`/`PermissionGuard` reading
 * `req.companyContext`) is entirely untouched by this controller's
 * existence, since it never sets or reads `companyContext` at all.
 */
@Controller('installation/companies/:companyId/memberships')
@UseGuards(JwtAuthGuard, PlatformGuard)
export class InstallationMembershipController {
  constructor(
    private readonly provisioning: CompanyMembershipProvisioningService,
    private readonly memberships: MembershipService,
  ) {}

  @RequirePlatform('platform.membership.view')
  @Get()
  async list(@Param('companyId') companyId: string) {
    const rows = await this.memberships.findByCompany(companyId);
    return { success: true, data: rows };
  }

  @RequirePlatform('platform.membership.grant', 'editable')
  @Post()
  async grant(@Req() req: AuthenticatedRequest, @Param('companyId') companyId: string, @Body() dto: GrantMembershipDto) {
    if (!req.user) throw new UnauthorizedException();
    const membership = await this.provisioning.grantMembership(req.user.id, dto.userId, companyId, dto.roleKey);
    return { success: true, data: membership };
  }

  @RequirePlatform('platform.membership.revoke', 'editable')
  @Delete(':userId')
  async revoke(@Req() req: AuthenticatedRequest, @Param('companyId') companyId: string, @Param('userId') userId: string) {
    if (!req.user) throw new UnauthorizedException();
    await this.provisioning.revokeMembership(req.user.id, userId, companyId);
    return { success: true, data: { revoked: true } };
  }

  @RequirePlatform('platform.membership.update', 'editable')
  @Patch(':userId')
  async changeRole(@Req() req: AuthenticatedRequest, @Param('companyId') companyId: string, @Param('userId') userId: string, @Body() dto: ChangeMembershipRoleDto) {
    if (!req.user) throw new UnauthorizedException();
    const membership = await this.provisioning.changeMembershipRole(req.user.id, userId, companyId, dto.roleKey);
    return { success: true, data: membership };
  }
}
