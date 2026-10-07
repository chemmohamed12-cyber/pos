import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsArray, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { DataSource } from 'typeorm';
import { AuthorizationContextService } from '../authorization/authorization-context.service';
import { JwtAuthGuard } from '../authentication/jwt-auth.guard';
import { PermissionGuard } from '../permission/permission.guard';
import { RequirePermission } from '../permission/require-permission.decorator';
import { CompanyContextGuard, CompanyScopedRequest } from './company-context.guard';
import { CompanyInvitationService } from './company-invitation.service';
import { COMPANY_MEMBERS_MANAGE_NODE } from './company-role-seeding';
import { CompanyActor, CompanyUserManagementService } from './company-user-management.service';

class SetRolesDto {
  @IsArray()
  roleKeys!: unknown[];
}

class SetStatusDto {
  @IsIn(['active', 'suspended'])
  status!: 'active' | 'suspended';
}

class CreateInvitationDto {
  @IsString()
  @MaxLength(255)
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  fullName?: string;

  @IsOptional()
  @IsArray()
  roleKeys?: unknown[];
}

/**
 * Authorization Foundation F2 — the Company Users surface. Takes NO company identifier from the client: the Company is the one
 * `CompanyContextGuard` validated for this request's token (membership active + Company READY), so a Company administrator can only ever see and
 * manage THIS Company's members (Blueprint §4.3). Reads need `core.company.members.manage` read-only, writes editable.
 *
 * Replaces the pre-F2 `POST /memberships` that attached any existing identity by raw user id: users now join a Company only by invitation
 * acceptance (or, for support/bootstrap, the platform-admin installation route).
 */
@Controller('company/users')
@UseGuards(JwtAuthGuard, CompanyContextGuard, PermissionGuard)
@RequirePermission(COMPANY_MEMBERS_MANAGE_NODE, 'read-only')
export class CompanyUsersController {
  constructor(
    private readonly management: CompanyUserManagementService,
    private readonly invitations: CompanyInvitationService,
    private readonly contexts: AuthorizationContextService,
  ) {}

  private async actor(req: CompanyScopedRequest): Promise<{ actor: CompanyActor; companyId: string; ds: DataSource }> {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const authz = await this.contexts.forRequest(req, req.companyContext.dataSource.manager); // memoized: the same load PermissionGuard used
    return { actor: { userId: req.user.id, authz }, companyId: req.companyContext.companyId, ds: req.companyContext.dataSource };
  }

  @Get()
  async list(@Req() req: CompanyScopedRequest) {
    if (!req.companyContext) throw new UnauthorizedException();
    return { success: true, data: await this.management.directory(req.companyContext.companyId, req.companyContext.dataSource) };
  }

  /** The Company's roles + whether this actor may assign each (anti-elevation preview). */
  @Get('roles')
  async roles(@Req() req: CompanyScopedRequest) {
    const { actor, ds } = await this.actor(req);
    return { success: true, data: await this.management.assignableRoles(ds, actor) };
  }

  @Get('invitations')
  async listInvitations(@Req() req: CompanyScopedRequest) {
    if (!req.companyContext) throw new UnauthorizedException();
    return { success: true, data: await this.invitations.list(req.companyContext.companyId) };
  }

  @RequirePermission(COMPANY_MEMBERS_MANAGE_NODE, 'editable')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('invitations')
  async invite(@Req() req: CompanyScopedRequest, @Body() dto: CreateInvitationDto) {
    const { actor, companyId, ds } = await this.actor(req);
    const result = await this.invitations.create(actor, companyId, ds, dto);
    return { success: true, data: result };
  }

  @RequirePermission(COMPANY_MEMBERS_MANAGE_NODE, 'editable')
  @Delete('invitations/:invitationId')
  async revokeInvitation(@Req() req: CompanyScopedRequest, @Param('invitationId', ParseUUIDPipe) invitationId: string) {
    const { actor, companyId, ds } = await this.actor(req);
    await this.invitations.revoke(actor, companyId, ds, invitationId);
    return { success: true, data: { revoked: true } };
  }

  @RequirePermission(COMPANY_MEMBERS_MANAGE_NODE, 'editable')
  @Put(':userId/roles')
  async setRoles(@Req() req: CompanyScopedRequest, @Param('userId', ParseUUIDPipe) userId: string, @Body() dto: SetRolesDto) {
    const { actor, companyId, ds } = await this.actor(req);
    return { success: true, data: await this.management.setRoles(actor, companyId, ds, userId, dto.roleKeys) };
  }

  @RequirePermission(COMPANY_MEMBERS_MANAGE_NODE, 'editable')
  @Patch(':userId')
  async setStatus(@Req() req: CompanyScopedRequest, @Param('userId', ParseUUIDPipe) userId: string, @Body() dto: SetStatusDto) {
    const { actor, companyId, ds } = await this.actor(req);
    await this.management.setStatus(actor, companyId, ds, userId, dto.status);
    return { success: true, data: { status: dto.status } };
  }

  @RequirePermission(COMPANY_MEMBERS_MANAGE_NODE, 'editable')
  @Delete(':userId')
  async remove(@Req() req: CompanyScopedRequest, @Param('userId', ParseUUIDPipe) userId: string) {
    const { actor, companyId, ds } = await this.actor(req);
    await this.management.removeMember(actor, companyId, ds, userId);
    return { success: true, data: { removed: true } };
  }
}
