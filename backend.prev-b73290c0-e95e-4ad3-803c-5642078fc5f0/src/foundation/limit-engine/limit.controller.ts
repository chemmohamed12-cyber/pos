import { Body, Controller, Delete, Get, Param, Put, Req, UseGuards } from '@nestjs/common';
import { IsInt, Min } from 'class-validator';
import { LimitService } from './limit.service';
import { JwtAuthGuard, AuthenticatedRequest } from '../authentication/jwt-auth.guard';
import { RolesGuard } from '../authorization/roles.guard';
import { PermissionGuard } from '../permission/permission.guard';
import { RequirePermission } from '../permission/require-permission.decorator';

class SetLimitDto {
  @IsInt()
  @Min(0)
  maxValue!: number;
}

/**
 * Limit Engine — ERP Foundation P5. Admin API. `core.limit.view` /
 * `core.limit.edit` are `core.*` permission nodes, resolved by the
 * Permission Engine's ancestor walk exactly like `core.config` /
 * `system.release.*` (grandfathered — not declared in any module
 * manifest, same as those two).
 */
@Controller('limits')
@UseGuards(JwtAuthGuard, RolesGuard)
export class LimitController {
  constructor(private readonly limits: LimitService) {}

  @Get('keys')
  @UseGuards(PermissionGuard)
  @RequirePermission('core.limit.view', 'read-only')
  listKeys() {
    return this.limits.listKeys();
  }

  @Get('usage/:key')
  @UseGuards(PermissionGuard)
  @RequirePermission('core.limit.view', 'read-only')
  getUsage(@Param('key') key: string) {
    return this.limits.getUsage(key);
  }

  @Put('profiles/:key')
  @UseGuards(PermissionGuard)
  @RequirePermission('core.limit.edit', 'editable')
  async setProfile(@Req() req: AuthenticatedRequest, @Param('key') key: string, @Body() dto: SetLimitDto) {
    await this.limits.setProfile(key, dto.maxValue, req.user.id);
    return { ok: true, usage: await this.limits.getUsage(key) };
  }

  @Delete('profiles/:key')
  @UseGuards(PermissionGuard)
  @RequirePermission('core.limit.edit', 'editable')
  async clearProfile(@Req() req: AuthenticatedRequest, @Param('key') key: string) {
    await this.limits.clearProfile(key, req.user.id);
    return { ok: true, usage: await this.limits.getUsage(key) };
  }
}
