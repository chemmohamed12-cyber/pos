import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsObject, IsString } from 'class-validator';
import { EntitlementService } from './entitlement.service';
import { EntitlementManifest } from './manifest.type';
import { JwtAuthGuard, AuthenticatedRequest } from '../authentication/jwt-auth.guard';
import { RolesGuard } from '../authorization/roles.guard';
import { PermissionGuard } from '../permission/permission.guard';
import { RequirePermission } from '../permission/require-permission.decorator';

class ApplyManifestDto {
  @IsObject()
  manifest!: EntitlementManifest;

  @IsString()
  signature!: string;
}

@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class EntitlementController {
  constructor(private readonly entitlement: EntitlementService) {}

  /** For the current principal — feeds the P7 server-driven frontend nav. */
  @Get('me/entitlements')
  meEntitlements(@Req() _req: AuthenticatedRequest) {
    const e = this.entitlement.resolve();
    return {
      editionCode: e.editionCode,
      editionVersion: e.editionVersion,
      status: e.status,
      verificationState: e.verificationState,
      modules: [...e.modules].sort(),
      features: [...e.features].sort(),
      limits: Object.fromEntries(e.limits),
    };
  }

  @Get('admin/entitlement')
  @UseGuards(PermissionGuard)
  @RequirePermission('core.entitlement.view', 'read-only')
  adminView() {
    const e = this.entitlement.resolve();
    return { resolved: { ...e, modules: [...e.modules], features: [...e.features], limits: Object.fromEntries(e.limits) } };
  }

  /** The endpoint P6's deploy step calls to apply a freshly-issued signed manifest. */
  @Post('admin/entitlement/apply')
  @UseGuards(PermissionGuard)
  @RequirePermission('core.entitlement.apply', 'editable')
  async apply(
    @Req() req: AuthenticatedRequest,
    @Body() dto: ApplyManifestDto,
    @Query('expandClosure') expandClosure?: string,
  ) {
    const resolved = await this.entitlement.applyManifest(dto.manifest, dto.signature, req.user.id, {
      expandClosure: expandClosure === 'true',
    });
    return {
      ok: true,
      resolved: { ...resolved, modules: [...resolved.modules], features: [...resolved.features], limits: Object.fromEntries(resolved.limits) },
    };
  }
}
