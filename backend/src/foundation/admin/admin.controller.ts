import { Body, ConflictException, Controller, ForbiddenException, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { IsEmail, IsIn, IsString, MinLength } from 'class-validator';
import { AuthorizationService } from '../authorization/authorization.service';
import { UsersService } from '../identity/users.service';
import { UserStatus } from '../identity/user.entity';
import { AuthService } from '../authentication/auth.service';
import { JwtAuthGuard, AuthenticatedRequest } from '../authentication/jwt-auth.guard';
import { AuthorizationContextService } from '../authorization/authorization-context.service';
import { AuditService } from '../audit/audit.service';
import { PlatformGuard, RequirePlatform } from '../platform/platform.guard';
import { PLATFORM_ROLE_KEYS } from '../platform/platform-nodes';

class AssignRoleDto {
  @IsString()
  userId!: string;

  @IsString()
  roleKey!: string;
}

class SetUserStatusDto {
  @IsIn(['pending', 'active', 'disabled', 'suspended'])
  status!: UserStatus;
}

class ResetPasswordDto {
  @IsString()
  @MinLength(8)
  newPassword!: string;
}

class UpdateUserProfileDto {
  @IsString()
  @MinLength(1)
  fullName!: string;

  @IsEmail()
  email!: string;
}

/**
 * Admin-only bootstrap/ops endpoints — list users and assign roles. Its
 * own module (not folded into Authorization) specifically to avoid a
 * circular dependency: Authentication already imports Authorization for
 * the register() bootstrap, so this controller (which needs both
 * Authentication's guard and Authorization's service) lives one level
 * up instead.
 */
@Controller('admin')
@UseGuards(JwtAuthGuard, PlatformGuard)
export class AdminController {
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly users: UsersService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    private readonly contexts: AuthorizationContextService,
  ) {}

  /** F4 (AZ-07): every platform user/role write is audited in the platform hash chain. */
  private async record(actorUserId: string, action: string, resourceId: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null): Promise<void> {
    await this.audit.record({ actorUserId, organizationId: null, action, resource: 'user', resourceId, result: 'success', correlationId: randomUUID(), before, after });
  }

  /** Platform roles (and the legacy `admin`) are PLATFORM authority: assigning or revoking them needs `platform.role.manage`; any other (legacy ambient) role key needs only `platform.role.assign`. */
  private async assertMayChangeRole(req: AuthenticatedRequest, roleKey: string): Promise<void> {
    if (!PLATFORM_ROLE_KEYS.includes(roleKey)) return;
    const ctx = await this.contexts.load(req.user!.id, null);
    if (!(ctx.hasAtLeast('platform.role.manage', 'editable') || ctx.hasRole('admin'))) {
      throw new ForbiddenException('Assigning or revoking a platform role needs platform.role.manage.');
    }
  }

  /**
   * `roles` appended per-user (additive — every existing consumer of this
   * endpoint destructures individual fields, never the whole object, so
   * this doesn't change their behavior) — the Admin screen needs to show
   * what a user already holds before offering to assign/revoke, not just
   * blindly re-assign.
   */
  @RequirePlatform('platform.user.view')
  @Get('users')
  async listUsers() {
    const all = await this.users.listAll();
    return Promise.all(
      all.map(async (u) => ({ ...u, roles: await this.authorization.getRoleKeysForUser(u.id) })),
    );
  }

  // `GET /admin/sales-reps` (the Sales Order rep-selector) moved out in F5: it is a COMPANY surface (`SalesRepsDirectoryController`) — the reps of the CURRENT Company, never the platform's.

  @RequirePlatform('platform.role.assign', 'editable')
  @Post('roles/assign')
  async assignRole(@Req() req: AuthenticatedRequest, @Body() dto: AssignRoleDto) {
    await this.assertMayChangeRole(req, dto.roleKey);
    const before = await this.authorization.getRoleKeysForUser(dto.userId);
    await this.authorization.assignRole(dto.userId, dto.roleKey);
    await this.record(req.user!.id, 'platform.role.assigned', dto.userId, { roleKeys: before }, { roleKeys: [...new Set([...before, dto.roleKey])], roleKey: dto.roleKey });
    return { success: true, data: { userId: dto.userId, roleKey: dto.roleKey } };
  }

  /** Reverse of assign — same DTO shape, same idempotent-on-the-service-side discipline (`AuthorizationService.revokeRole` already no-ops on an unknown role/unassigned pair). */
  @RequirePlatform('platform.role.assign', 'editable')
  @Post('roles/revoke')
  async revokeRole(@Req() req: AuthenticatedRequest, @Body() dto: AssignRoleDto) {
    await this.assertMayChangeRole(req, dto.roleKey);
    // Last-super-admin protection: the platform must always keep at least one holder of the Super Admin authority (`admin` alias or `platform_super_admin`).
    if (dto.roleKey === 'admin' || dto.roleKey === 'platform_super_admin') {
      const holders = new Set([...(await this.authorization.getUserIdsForRole('admin')), ...(await this.authorization.getUserIdsForRole('platform_super_admin'))]);
      if (holders.has(dto.userId) && holders.size <= 1) throw new ConflictException('The platform must keep at least one Super Admin.');
    }
    const before = await this.authorization.getRoleKeysForUser(dto.userId);
    await this.authorization.revokeRole(dto.userId, dto.roleKey);
    await this.record(req.user!.id, 'platform.role.revoked', dto.userId, { roleKeys: before, roleKey: dto.roleKey }, { roleKeys: before.filter((k) => k !== dto.roleKey) });
    return { success: true, data: { userId: dto.userId, roleKey: dto.roleKey } };
  }

  /**
   * Never a hard delete (same never-delete discipline this codebase uses
   * everywhere else — warehouses, vehicles, shipping companies are
   * deactivated, not removed) — an admin locks a departed/suspended user
   * out via status, their history (orders, audit trail, movements they
   * created) stays intact and attributable.
   */
  @RequirePlatform('platform.user.disable', 'editable')
  @Post('users/:id/status')
  async setUserStatus(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: SetUserStatusDto) {
    const prior = await this.users.findById(id);
    const user = await this.users.setStatus(id, dto.status);
    await this.record(req.user!.id, 'platform.user.status_changed', id, { status: prior.status }, { status: user.status });
    return { success: true, data: { id: user.id, status: user.status } };
  }

  /**
   * Admin-initiated reset (no knowledge of the old password required) —
   * distinct from `POST /auth/change-password`, which is self-service
   * only. Reuses `AuthService.setPassword` exactly as that self-service
   * path does, including its side effect of revoking every existing
   * session for the target user (a real security property here too: a
   * reset should force sign-out everywhere, not just change the hash).
   */
  @RequirePlatform('platform.user.reset_password', 'editable')
  @Post('users/:id/reset-password')
  async resetPassword(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: ResetPasswordDto) {
    await this.users.findById(id); // 404s on an unknown user before touching Credentials
    await this.auth.setPassword(id, dto.newPassword);
    await this.record(req.user!.id, 'platform.user.password_reset', id, null, { reset: true }); // never the password itself
    return { success: true, data: { id, reset: true } };
  }

  /** Admin edit of a user's own name/email from the Assign-Role screen (شاشة الاسناد) — admin's "grant admin" ask is already just `roles/assign` with roleKey 'admin' above; this closes the actual gap, which was that name/email had no edit path at all. */
  @RequirePlatform('platform.user.update', 'editable')
  @Post('users/:id/profile')
  async updateProfile(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: UpdateUserProfileDto) {
    const prior = await this.users.findById(id);
    const user = await this.users.updateProfile(id, { fullName: dto.fullName, email: dto.email });
    await this.record(req.user!.id, 'platform.user.profile_changed', id, { fullName: prior.fullName, email: prior.email }, { fullName: user.fullName, email: user.email });
    return { success: true, data: { id: user.id, fullName: user.fullName, email: user.email } };
  }
}
