import { Body, Controller, Delete, Get, Param, Put, Query, Req, UseGuards } from '@nestjs/common';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { ConfigurationEngineService } from './configuration-engine.service';
import { ConfigScopeLevel } from './config-key.entity';
import { JwtAuthGuard, AuthenticatedRequest } from '../authentication/jwt-auth.guard';
import { RolesGuard } from '../authorization/roles.guard';
import { PermissionGuard } from '../permission/permission.guard';
import { RequirePermission } from '../permission/require-permission.decorator';

const CUSTOMER_SCOPES = ['installation', 'user', 'org'] as const;

class SetValueDto {
  @IsIn(CUSTOMER_SCOPES as unknown as string[])
  scope_type!: (typeof CUSTOMER_SCOPES)[number];

  @IsOptional()
  @IsString()
  scope_id?: string;

  // `value` is validated by the engine against the key's type/range — accept unknown here.
  value!: unknown;
}

/**
 * Runtime Configuration Engine — ERP Foundation P2. Admin API.
 * `core.config.view` / `core.config.edit` are `core.*` permission nodes,
 * resolved by the Permission Engine's ancestor walk exactly like
 * `system.release.*`. The migration grants `admin` 'editable' at `core.config`.
 *
 * Daii-only scopes ('edition', 'platform') are NOT settable through this
 * customer-facing controller — they come from the Edition catalog (P3) / a
 * platform-operator path.
 */
@Controller('config')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ConfigurationController {
  constructor(private readonly config: ConfigurationEngineService) {}

  @Get('keys')
  @UseGuards(PermissionGuard)
  @RequirePermission('core.config.view', 'read-only')
  listKeys(@Req() req: AuthenticatedRequest, @Query('module') moduleCode?: string) {
    return this.config.keys(moduleCode).map((meta) => ({
      key: meta.key,
      ownerModule: meta.ownerModule,
      valueType: meta.valueType,
      allowed: meta.allowed,
      scopeLevels: meta.scopeLevels,
      platformLocked: meta.platformLocked,
      securitySensitive: meta.securitySensitive,
      isFeatureFlag: meta.isFeatureFlag,
      titleCode: meta.titleCode,
      description: meta.description,
      writableLevels: this.config.writableLevels(meta.key),
      current: this.config.inspect(meta.key, { userId: req.user.id }),
    }));
  }

  @Get('keys/:key')
  @UseGuards(PermissionGuard)
  @RequirePermission('core.config.view', 'read-only')
  getKey(@Req() req: AuthenticatedRequest, @Param('key') key: string) {
    const meta = this.config.describe(key);
    return {
      key: meta.key,
      valueType: meta.valueType,
      allowed: meta.allowed,
      scopeLevels: meta.scopeLevels,
      platformLocked: meta.platformLocked,
      writableLevels: this.config.writableLevels(key),
      resolved: this.config.inspect(key, { userId: req.user.id }),
    };
  }

  @Put('values/:key')
  @UseGuards(PermissionGuard)
  @RequirePermission('core.config.edit', 'editable')
  async setValue(@Req() req: AuthenticatedRequest, @Param('key') key: string, @Body() dto: SetValueDto) {
    await this.config.set(
      key,
      { scope_type: dto.scope_type as ConfigScopeLevel, scope_id: dto.scope_id ?? null },
      dto.value,
      { userId: req.user.id },
    );
    return { ok: true, resolved: this.config.inspect(key, { userId: req.user.id }) };
  }

  @Delete('values/:key')
  @UseGuards(PermissionGuard)
  @RequirePermission('core.config.edit', 'editable')
  async clearValue(
    @Req() req: AuthenticatedRequest,
    @Param('key') key: string,
    @Query('scope_type') scopeType: ConfigScopeLevel,
    @Query('scope_id') scopeId?: string,
  ) {
    await this.config.clear(key, { scope_type: scopeType, scope_id: scopeId ?? null }, { userId: req.user.id });
    return { ok: true, resolved: this.config.inspect(key, { userId: req.user.id }) };
  }
}
