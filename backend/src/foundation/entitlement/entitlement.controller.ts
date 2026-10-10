import { PlatformGuard, RequirePlatform } from '../platform/platform.guard';
import { Body, Controller, Get, Optional, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsObject, IsString } from 'class-validator';
import { EntitlementService } from './entitlement.service';
import { EntitlementManifest } from './manifest.type';
import { JwtAuthGuard, AuthenticatedRequest } from '../authentication/jwt-auth.guard';
import { RolesGuard } from '../authorization/roles.guard';
import { CompanyEntitlementService } from '../plans/company-entitlement.service';
import { CompanyViewContextService } from '../plans/company-view-context.service';

class ApplyManifestDto {
  @IsObject()
  manifest!: EntitlementManifest;

  @IsString()
  signature!: string;
}

@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class EntitlementController {
  constructor(
    private readonly entitlement: EntitlementService,
    @Optional() private readonly companyView?: CompanyViewContextService,
    @Optional() private readonly companyEntitlement?: CompanyEntitlementService,
  ) {}

  /** For the current principal — feeds the P7 server-driven frontend nav. */
  @Get('me/entitlements')
  async meEntitlements(@Req() req: AuthenticatedRequest) {
    const e = this.entitlement.resolve();
    // Company Plans / Packages: when the caller has a Membership-validated Company, report THAT Company's
    // effective entitlement (package ∩ installation licence) so the UI and the guards agree.
    const company = this.companyView && this.companyEntitlement ? await this.companyView.resolve(req.user) : null;
    if (company && this.companyEntitlement) {
      const c = await this.companyEntitlement.resolve(company.companyId);
      return {
        editionCode: e.editionCode,
        editionVersion: e.editionVersion,
        status: c.status,
        verificationState: e.verificationState,
        modules: [...c.modules].sort(),
        features: [...c.features].sort(),
        limits: Object.fromEntries(e.limits),
        companyId: company.companyId,
        source: c.source,
        planCode: c.planCode,
      };
    }
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
  @UseGuards(PlatformGuard)
  @RequirePlatform('platform.entitlement.view', 'read-only', { legacyNodes: ['core.entitlement.view'] })
  adminView() {
    const e = this.entitlement.resolve();
    return { resolved: { ...e, modules: [...e.modules], features: [...e.features], limits: Object.fromEntries(e.limits) } };
  }

  /** The endpoint P6's deploy step calls to apply a freshly-issued signed manifest. */
  @Post('admin/entitlement/apply')
  @UseGuards(PlatformGuard)
  @RequirePlatform('platform.entitlement.manage', 'editable', { legacyNodes: ['core.entitlement.apply'] })
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
