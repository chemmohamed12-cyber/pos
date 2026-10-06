import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsIn, IsISO8601, IsNumberString, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { CashBankReconciliationService } from '../application/cash-bank-reconciliation.service';
import { CashBankAdjustmentService } from '../application/cash-bank-adjustment.service';
import { CASH_BANK_ADJUSTMENT_KINDS } from '../domain/cash-bank';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';

class RunReconciliationDto {
  @IsOptional()
  @IsUUID()
  treasuryAccountId?: string;

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

class SubmitCashBankAdjustmentDto {
  @IsOptional()
  @IsUUID()
  treasuryAccountId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  glAccountCode?: string;

  @IsIn(CASH_BANK_ADJUSTMENT_KINDS as unknown as string[])
  kind!: string;

  @IsNumberString()
  amount!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(250)
  reason!: string;

  @IsOptional()
  @IsIn(['debit', 'credit'])
  direction?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  counterAccountCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  contraAccountCode?: string;

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
 * F06 — Cash & Bank (ADR-038, Blueprint §11). The same guard stack as
 * F02/F03/F04/F05: `@RequireModule('accounting')` (404 for un-entitled,
 * checked before permission) + a per-route `@RequirePermission`.
 * `reconcile` / `close` are gated by `accounting.cash.create` (not an
 * ADR-024 verb — a run is a create; disclosed like F04/F05).
 */
@Controller('accounting/cash-bank')
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard)
@RequireModule('accounting')
export class CashBankController {
  constructor(
    private readonly reconciliation: CashBankReconciliationService,
    private readonly adjustments: CashBankAdjustmentService,
  ) {}

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.cash.view', 'read-only')
  @Get('reconciliations')
  async listReconciliations(@Req() req: CompanyScopedRequest, @Query('treasuryAccountId') treasuryAccountId?: string,
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,) {
    return this.reconciliation.listRuns({ treasuryAccountId, status, from, to }, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.cash.view', 'read-only')
  @Get('reconciliations/rollup')
  async rollup(@Req() req: CompanyScopedRequest) {
    return this.reconciliation.rollup(req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.cash.view', 'read-only')
  @Get('reconciliations/:id')
  async getReconciliation(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    return this.reconciliation.getRun(id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.cash.create', 'editable')
  @Post('reconciliations')
  async runReconciliation(@Body() dto: RunReconciliationDto, @Req() req: CompanyScopedRequest) {
    return this.reconciliation.reconcile(dto, req.user.id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.cash.create', 'editable')
  @Post('reconciliations/:id/close')
  async closeReconciliation(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    return this.reconciliation.closeRun(id, req.user.id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.cash.view', 'read-only')
  @Get('statement')
  async positionStatement(@Req() req: CompanyScopedRequest, @Query('treasuryAccountId', ParseUUIDPipe) treasuryAccountId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,) {
    return this.reconciliation.cashBankPositionStatement({ treasuryAccountId, from, to }, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.cash.adjust', 'editable')
  @Post('adjustments')
  async submitAdjustment(@Body() dto: SubmitCashBankAdjustmentDto, @Req() req: CompanyScopedRequest) {
    return this.adjustments.submitAdjustment(dto as never, req.user.id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.cash.approve', 'editable')
  @Post('approvals/:id/decide')
  async decide(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DecideDto, @Req() req: CompanyScopedRequest) {
    return this.adjustments.decide(id, req.user.id, dto.decision as 'approved' | 'rejected', dto.note, req.companyContext!.dataSource.manager);
  }
}
