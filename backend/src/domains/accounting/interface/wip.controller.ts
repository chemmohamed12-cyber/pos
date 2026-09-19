import { Controller, Get, Param, ParseUUIDPipe, Post, Query, Body, Req, UseGuards } from '@nestjs/common';
import { IsISO8601, IsOptional, IsUUID } from 'class-validator';
import { WipReconciliationService } from '../application/wip-reconciliation.service';
import { JwtAuthGuard, AuthenticatedRequest } from '../../../foundation/authentication/jwt-auth.guard';
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
@UseGuards(JwtAuthGuard, RequireModuleGuard)
@RequireModule('accounting')
export class WipController {
  constructor(private readonly reconciliation: WipReconciliationService) {}

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.wip.view', 'read-only')
  @Get('reconciliations')
  async listReconciliations(@Query('status') status?: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.reconciliation.listRuns({ status, from, to });
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.wip.view', 'read-only')
  @Get('reconciliations/:id')
  async getReconciliation(@Param('id', ParseUUIDPipe) id: string) {
    return this.reconciliation.getRun(id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.wip.create', 'editable')
  @Post('reconciliations')
  async runReconciliation(@Body() dto: RunWipReconciliationDto, @Req() req: AuthenticatedRequest) {
    return this.reconciliation.reconcile(dto, req.user.id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.wip.create', 'editable')
  @Post('reconciliations/:id/close')
  async closeReconciliation(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    return this.reconciliation.closeRun(id, req.user.id);
  }
}
