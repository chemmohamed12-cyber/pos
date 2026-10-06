import { Controller, Get, Param, ParseUUIDPipe, Post, Query, Body, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { IsISO8601, IsOptional, IsUUID } from 'class-validator';
import { WipReconciliationService } from '../application/wip-reconciliation.service';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';

class RunWipReconciliationDto {
  @IsOptional()
  @IsUUID()
  fiscalPeriodId?: string;

  @IsOptional()
  @IsISO8601()
  asOfDate?: string;

  @IsOptional()
  @IsUUID()
  orgUnitId?: string;
}

/**
 * ADR-061 (Manufacturing) Month-End dependency. Same guard stack and
 * `reconcile`/`close` shape as `GrniController` (`reconcile` is not an
 * ADR-024 verb — a run is a create, same disclosed exception).
 */
@Controller('accounting/wip')
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard)
@RequireModule('accounting')
export class WipController {
  constructor(private readonly reconciliation: WipReconciliationService) {}

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.wip.view', 'read-only')
  @Get('reconciliations')
  async listReconciliations(@Req() req: CompanyScopedRequest, @Query('status') status?: string, @Query('from') from?: string, @Query('to') to?: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.reconciliation.listRuns({ status, from, to }, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.wip.view', 'read-only')
  @Get('reconciliations/:id')
  async getReconciliation(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.reconciliation.getRun(id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.wip.create', 'editable')
  @Post('reconciliations')
  async runReconciliation(@Body() dto: RunWipReconciliationDto, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.reconciliation.reconcile(dto, req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.wip.create', 'editable')
  @Post('reconciliations/:id/close')
  async closeReconciliation(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.reconciliation.closeRun(id, req.user.id, req.companyContext.dataSource.manager);
  }
}
