import { Controller, Get, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { OrgReportService } from '../application/org-report.service';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';

/**
 * Org engine Stage 7 — organizational roll-up report (Company / branch / organization unit / cost centre / period). It carries financial figures, so it sits behind
 * the accounting report permission; rows are limited to the branches inside the caller's scope.
 */
@Controller('reports/organization')
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard)
@RequireModule('reporting')
export class OrgReportController {
  constructor(private readonly orgReport: OrgReportService) {}

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.report.view', 'read-only')
  @Get('overview')
  async overview(@Req() req: CompanyScopedRequest, @Query('from') from?: string, @Query('to') to?: string, @Query('unitId') unitId?: string, @Query('includeDescendants') includeDescendants?: string) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.orgReport.overview(req, { from: from || undefined, to: to || undefined, unitId: unitId || undefined, includeDescendants: includeDescendants === undefined ? undefined : includeDescendants !== 'false' });
  }
}
