import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsIn, IsISO8601, IsNumberString, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { ArReconciliationService } from '../application/ar-reconciliation.service';
import { ArAdjustmentService } from '../application/ar-adjustment.service';
import { AR_ADJUSTMENT_KINDS } from '../domain/ar';
import { JwtAuthGuard, AuthenticatedRequest } from '../../../foundation/authentication/jwt-auth.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';

class RunReconciliationDto {
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

class SubmitArAdjustmentDto {
  @IsUUID()
  customerId!: string;

  @IsIn(AR_ADJUSTMENT_KINDS as unknown as string[])
  kind!: string;

  @IsNumberString()
  amount!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(250)
  reason!: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  contraAccountCode?: string;

  @IsOptional()
  @IsIn(['debit', 'credit'])
  direction?: string;

  @IsOptional()
  @IsISO8601()
  businessDate?: string;

  @IsOptional()
  @IsUUID()
  orgUnitId?: string;
}

class DecideDto {
  @IsIn(['approved', 'rejected'])
  decision!: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  note?: string;
}

/**
 * F04 — Accounts Receivable (ADR-036, Blueprint §14). Same guard stack as
 * F01/F02/F03: `@RequireModule('accounting')` (404 for un-entitled,
 * checked before permission) + a per-route `@RequirePermission`.
 * `reconcile` is gated by `accounting.ar.create` (`reconcile` is not an
 * ADR-024 verb — a run is a create; disclosed like F02's `.import`).
 */
@Controller('accounting/ar')
@UseGuards(JwtAuthGuard, RequireModuleGuard)
@RequireModule('accounting')
export class ArController {
  constructor(
    private readonly reconciliation: ArReconciliationService,
    private readonly adjustments: ArAdjustmentService,
  ) {}

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.ar.view', 'read-only')
  @Get('reconciliations')
  async listReconciliations(@Query('status') status?: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.reconciliation.listRuns({ status, from, to });
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.ar.view', 'read-only')
  @Get('reconciliations/:id')
  async getReconciliation(@Param('id', ParseUUIDPipe) id: string) {
    return this.reconciliation.getRun(id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.ar.create', 'editable')
  @Post('reconciliations')
  async runReconciliation(@Body() dto: RunReconciliationDto, @Req() req: AuthenticatedRequest) {
    return this.reconciliation.reconcile(dto, req.user.id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.ar.create', 'editable')
  @Post('reconciliations/:id/close')
  async closeReconciliation(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    return this.reconciliation.closeRun(id, req.user.id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.ar.view', 'read-only')
  @Get('statement/:customerId')
  async customerStatement(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.reconciliation.customerStatement(customerId, { from, to });
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.ar.adjust', 'editable')
  @Post('adjustments')
  async submitAdjustment(@Body() dto: SubmitArAdjustmentDto, @Req() req: AuthenticatedRequest) {
    return this.adjustments.submitAdjustment(dto as never, req.user.id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.ar.approve', 'editable')
  @Post('approvals/:id/decide')
  async decide(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DecideDto, @Req() req: AuthenticatedRequest) {
    return this.adjustments.decide(id, req.user.id, dto.decision as 'approved' | 'rejected', dto.note);
  }
}
