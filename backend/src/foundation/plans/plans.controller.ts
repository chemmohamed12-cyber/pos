import { PlatformGuard, RequirePlatform } from '../platform/platform.guard';
import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { IsArray, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { JwtAuthGuard, AuthenticatedRequest } from '../authentication/jwt-auth.guard';
import { RolesGuard } from '../authorization/roles.guard';
import { RequireRole } from '../authorization/require-role.decorator';
import { PlanService } from './plan.service';
import { CompanyPackageService } from './company-package.service';

class CreatePlanDto {
  @IsString()
  @MinLength(2)
  @MaxLength(63)
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsArray()
  @IsString({ each: true })
  moduleCodes!: string[];
}

class UpdatePlanDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  moduleCodes?: string[];

  @IsOptional()
  @IsIn(['active', 'archived'])
  status?: 'active' | 'archived';
}

class AssignPackageDto {
  @IsString()
  @MinLength(1)
  planCode!: string;
}

/**
 * Company Plans / Packages — Super Admin (platform `admin` role) API. Same
 * Installation-level pattern as `InstallationMembershipController`: gated by the
 * platform `admin` role through `RolesGuard`, never by `CompanyContextGuard`,
 * because the Super Admin names a Company explicitly. Updates are POSTs, matching
 * the rest of the control plane (the shared `api` helper has no PATCH).
 */
@Controller('installation')
@UseGuards(JwtAuthGuard, PlatformGuard)
export class PlansController {
  constructor(
    private readonly plans: PlanService,
    private readonly packages: CompanyPackageService,
  ) {}

  /** Every module with its dependencies and whether the installation licence includes it. */
  @RequirePlatform('platform.plan.view')
  @Get('module-catalog')
  moduleCatalog() {
    return { success: true, data: this.plans.moduleCatalog() };
  }

  @RequirePlatform('platform.plan.view')
  @Get('plans')
  async list() {
    return { success: true, data: await this.plans.list() };
  }

  @RequirePlatform('platform.plan.view')
  @Get('plans/:code')
  async get(@Param('code') code: string) {
    return { success: true, data: await this.plans.get(code) };
  }

  @RequirePlatform('platform.plan.manage', 'editable')
  @Post('plans')
  async create(@Req() req: AuthenticatedRequest, @Body() dto: CreatePlanDto) {
    if (!req.user) throw new UnauthorizedException();
    return { success: true, data: await this.plans.create(dto, req.user.id) };
  }

  @RequirePlatform('platform.plan.manage', 'editable')
  @Post('plans/:code')
  async update(@Req() req: AuthenticatedRequest, @Param('code') code: string, @Body() dto: UpdatePlanDto) {
    if (!req.user) throw new UnauthorizedException();
    const result = await this.plans.update(code, dto, req.user.id);
    if (result.affectedCompanyIds.length > 0) await this.packages.syncPlanCompanies(code);
    return { success: true, data: result };
  }

  @RequirePlatform('platform.entitlement.view')
  @Get('companies/:companyId/package')
  async companyPackage(@Param('companyId', ParseUUIDPipe) companyId: string) {
    return { success: true, data: await this.packages.getForCompany(companyId) };
  }

  @RequirePlatform('platform.entitlement.manage', 'editable')
  @Post('companies/:companyId/package')
  async assignPackage(@Req() req: AuthenticatedRequest, @Param('companyId', ParseUUIDPipe) companyId: string, @Body() dto: AssignPackageDto) {
    if (!req.user) throw new UnauthorizedException();
    return { success: true, data: await this.packages.assign(companyId, dto.planCode, req.user.id) };
  }
}
