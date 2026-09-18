import { Controller, Get, Param, ParseUUIDPipe, Post, Query, Body, Req, UseGuards } from '@nestjs/common';
import { IsISO8601, IsOptional, IsUUID } from 'class-validator';
import { GrniReconciliationService } from '../application/grni-reconciliation.service';
import { JwtAuthGuard, AuthenticatedRequest } from '../../../foundation/authentication/jwt-auth.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';

class RunGrniReconciliationDto {
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
 * ADR-054/ADR-056 (Month-End Closing, Phase 8). Same guard stack and
 * `reconcile`/`close` shape as `ApController` (`reconcile` is not an
 * ADR-024 verb — a run is a create, same disclosed exception). No
 * adjustment/approval routes — those require a real GRNI ledger movement
 * capability that does not exist yet (Procurement-side, unowned,
 * ADR-056's explicit dependency note); building one now would be exactly
 * the placeholder ADR-056 says not to build.
 */
@Controller('accounting/grni')
@UseGuards(JwtAuthGuard, RequireModuleGuard)
@RequireModule('accounting')
export class GrniController {
  constructor(private readonly reconciliation: GrniReconciliationService) {}

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.grni.view', 'read-only')
  @Get('reconciliations')
  async listReconciliations(@Query('status') status?: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.reconciliation.listRuns({ status, from, to });
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.grni.view', 'read-only')
  @Get('reconciliations/:id')
  async getReconciliation(@Param('id', ParseUUIDPipe) id: string) {
    return this.reconciliation.getRun(id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.grni.create', 'editable')
  @Post('reconciliations')
  async runReconciliation(@Body() dto: RunGrniReconciliationDto, @Req() req: AuthenticatedRequest) {
    return this.reconciliation.reconcile(dto, req.user.id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.grni.create', 'editable')
  @Post('reconciliations/:id/close')
  async closeReconciliation(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    return this.reconciliation.closeRun(id, req.user.id);
  }
}
