import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { IsArray, IsBoolean, IsOptional, IsString } from 'class-validator';
import { OrgLegacyService } from './org-legacy.service';
import { JwtAuthGuard } from '../authentication/jwt-auth.guard';
import { PermissionGuard } from '../permission/permission.guard';
import { RequirePermission } from '../permission/require-permission.decorator';
import { COMPANY_ORGANIZATION_MANAGE_NODE } from '../permission/company-nodes';
import { CompanyContextGuard, CompanyScopedRequest } from '../company/company-context.guard';
import { AuditService } from '../audit/audit.service';

class BackfillDto {
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  /** The impact report was reviewed: required to write (a dry run never needs it). */
  @IsOptional()
  @IsBoolean()
  confirm?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tables?: string[];
}

/** Org engine Stage 8 — the legacy reconciliation surface: read-only inventory, dry-run / confirmed backfill of the DERIVABLE references, and the audit log of a run. */
@Controller('organization/legacy')
@UseGuards(JwtAuthGuard, CompanyContextGuard, PermissionGuard)
@RequirePermission(COMPANY_ORGANIZATION_MANAGE_NODE, 'editable')
export class OrgLegacyController {
  constructor(
    private readonly legacy: OrgLegacyService,
    private readonly audit: AuditService,
  ) {}

  private manager(req: CompanyScopedRequest) {
    if (!req.companyContext) throw new UnauthorizedException();
    return req.companyContext.dataSource.manager;
  }

  @Get('inventory')
  inventory(@Req() req: CompanyScopedRequest) {
    return this.legacy.inventory(this.manager(req));
  }

  @Post('backfill')
  async backfill(@Req() req: CompanyScopedRequest, @Body() dto: BackfillDto) {
    if (!req.user) throw new UnauthorizedException();
    if (!dto.dryRun && !dto.confirm) throw new BadRequestException('Run a dry run first, review it, then confirm. / نفّذ تجربة أولاً ثم أكّد.');
    const result = await this.legacy.backfill({ dryRun: dto.dryRun, tables: dto.tables, actorUserId: req.user.id }, this.manager(req));
    if (!result.dryRun) {
      await this.audit.record({ actorUserId: req.user.id, organizationId: null, action: 'organization.legacy.backfill', resource: 'org_migration_run', resourceId: result.runId, result: 'success', correlationId: null, after: result as never }, this.manager(req));
    }
    return result;
  }

  @Get('runs/:runId')
  log(@Req() req: CompanyScopedRequest, @Param('runId', ParseUUIDPipe) runId: string) {
    return this.legacy.log(runId, this.manager(req));
  }
}
