import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { IsEmail, IsIn, IsString, MinLength } from 'class-validator';
import { AuthorizationService } from '../authorization/authorization.service';
import { UsersService } from '../identity/users.service';
import { UserStatus } from '../identity/user.entity';
import { AuthService } from '../authentication/auth.service';
import { JwtAuthGuard } from '../authentication/jwt-auth.guard';
import { RolesGuard } from '../authorization/roles.guard';
import { RequireRole } from '../authorization/require-role.decorator';

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
@UseGuards(JwtAuthGuard, RolesGuard)
@RequireRole('admin')
export class AdminController {
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly users: UsersService,
    private readonly auth: AuthService,
  ) {}

  /**
   * `roles` appended per-user (additive — every existing consumer of this
   * endpoint destructures individual fields, never the whole object, so
   * this doesn't change their behavior) — the Admin screen needs to show
   * what a user already holds before offering to assign/revoke, not just
   * blindly re-assign.
   */
  @Get('users')
  async listUsers() {
    const all = await this.users.listAll();
    return Promise.all(
      all.map(async (u) => ({ ...u, roles: await this.authorization.getRoleKeysForUser(u.id) })),
    );
  }

  /**
   * Backs the Sales Order rep-selector (CTO instruction — customer
   * visibility must filter by the SELECTED rep). Narrower than
   * `GET /admin/users` on purpose, on two axes: role (admin/sales_manager
   * only, not the class-level admin-only default — see the override
   * below) and result shape (only users holding `sales_rep`, not the
   * whole user table, which would leak drivers/warehouse workers into a
   * rep picker for no reason).
   */
  @RequireRole('admin', 'sales_manager')
  @Get('sales-reps')
  async listSalesReps() {
    const ids = await this.authorization.getUserIdsForRole('sales_rep');
    return this.users.findByIds(ids);
  }

  @Post('roles/assign')
  async assignRole(@Body() dto: AssignRoleDto) {
    await this.authorization.assignRole(dto.userId, dto.roleKey);
    return { success: true, data: { userId: dto.userId, roleKey: dto.roleKey } };
  }

  /** Reverse of assign — same DTO shape, same idempotent-on-the-service-side discipline (`AuthorizationService.revokeRole` already no-ops on an unknown role/unassigned pair). */
  @Post('roles/revoke')
  async revokeRole(@Body() dto: AssignRoleDto) {
    await this.authorization.revokeRole(dto.userId, dto.roleKey);
    return { success: true, data: { userId: dto.userId, roleKey: dto.roleKey } };
  }

  /**
   * Never a hard delete (same never-delete discipline this codebase uses
   * everywhere else — warehouses, vehicles, shipping companies are
   * deactivated, not removed) — an admin locks a departed/suspended user
   * out via status, their history (orders, audit trail, movements they
   * created) stays intact and attributable.
   */
  @Post('users/:id/status')
  async setUserStatus(@Param('id') id: string, @Body() dto: SetUserStatusDto) {
    const user = await this.users.setStatus(id, dto.status);
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
  @Post('users/:id/reset-password')
  async resetPassword(@Param('id') id: string, @Body() dto: ResetPasswordDto) {
    await this.users.findById(id); // 404s on an unknown user before touching Credentials
    await this.auth.setPassword(id, dto.newPassword);
    return { success: true, data: { id, reset: true } };
  }

  /** Admin edit of a user's own name/email from the Assign-Role screen (شاشة الاسناد) — admin's "grant admin" ask is already just `roles/assign` with roleKey 'admin' above; this closes the actual gap, which was that name/email had no edit path at all. */
  @Post('users/:id/profile')
  async updateProfile(@Param('id') id: string, @Body() dto: UpdateUserProfileDto) {
    const user = await this.users.updateProfile(id, { fullName: dto.fullName, email: dto.email });
    return { success: true, data: { id: user.id, fullName: user.fullName, email: user.email } };
  }
}
