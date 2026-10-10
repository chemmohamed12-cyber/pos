import { PlatformGuard, RequirePlatform } from '../platform/platform.guard';
import { Body, Controller, Delete, Get, Param, Put, Req, UseGuards } from '@nestjs/common';
import { IsInt, Min } from 'class-validator';
import { LimitService } from './limit.service';
import { JwtAuthGuard, AuthenticatedRequest } from '../authentication/jwt-auth.guard';
import { RolesGuard } from '../authorization/roles.guard';

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
  @UseGuards(PlatformGuard)
  @RequirePlatform('platform.limit.view', 'read-only', { legacyNodes: ['core.limit.view'] })
  listKeys() {
    return this.limits.listKeys();
  }

  @Get('usage/:key')
  @UseGuards(PlatformGuard)
  @RequirePlatform('platform.limit.view', 'read-only', { legacyNodes: ['core.limit.view'] })
  getUsage(@Param('key') key: string) {
    return this.limits.getUsage(key);
  }

  @Put('profiles/:key')
  @UseGuards(PlatformGuard)
  @RequirePlatform('platform.limit.edit', 'editable', { legacyNodes: ['core.limit.edit'] })
  async setProfile(@Req() req: AuthenticatedRequest, @Param('key') key: string, @Body() dto: SetLimitDto) {
    await this.limits.setProfile(key, dto.maxValue, req.user.id);
    return { ok: true, usage: await this.limits.getUsage(key) };
  }

  @Delete('profiles/:key')
  @UseGuards(PlatformGuard)
  @RequirePlatform('platform.limit.edit', 'editable', { legacyNodes: ['core.limit.edit'] })
  async clearProfile(@Req() req: AuthenticatedRequest, @Param('key') key: string) {
    await this.limits.clearProfile(key, req.user.id);
    return { ok: true, usage: await this.limits.getUsage(key) };
  }
}
