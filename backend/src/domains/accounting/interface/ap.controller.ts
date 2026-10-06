import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsIn, IsISO8601, IsNumberString, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { ApReconciliationService } from '../application/ap-reconciliation.service';
import { ApAdjustmentService } from '../application/ap-adjustment.service';
import { AP_ADJUSTMENT_KINDS } from '../domain/ap';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
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

class SubmitApAdjustmentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  supplierRef!: string;

  @IsIn(AP_ADJUSTMENT_KINDS as unknown as string[])
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
  @IsString()
  @MaxLength(32)
  apAccountCode?: string;

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
 * F05 — Accounts Payable (ADR-037, Blueprint §11). Same guard stack as
 * F01/F02/F03/F04: `@RequireModule('accounting')` (404 for un-entitled,
 * checked before permission) + a per-route `@RequirePermission`.
 * `reconcile` / `close` are gated by `accounting.ap.create` (`reconcile`
 * is not an ADR-024 verb — a run is a create; disclosed like F02's
 * `.import` / F04's).
 */
@Controller('accounting/ap')
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard)
@RequireModule('accounting')
export class ApController {
  constructor(
    private readonly reconciliation: ApReconciliationService,
    private readonly adjustments: ApAdjustmentService,
  ) {}

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.ap.view', 'read-only')
  @Get('reconciliations')
  async listReconciliations(@Req() req: CompanyScopedRequest, @Query('status') status?: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.reconciliation.listRuns({ status, from, to }, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.ap.view', 'read-only')
  @Get('reconciliations/:id')
  async getReconciliation(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    return this.reconciliation.getRun(id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.ap.create', 'editable')
  @Post('reconciliations')
  async runReconciliation(@Body() dto: RunReconciliationDto, @Req() req: CompanyScopedRequest) {
    return this.reconciliation.reconcile(dto, req.user.id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.ap.create', 'editable')
  @Post('reconciliations/:id/close')
  async closeReconciliation(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    return this.reconciliation.closeRun(id, req.user.id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.ap.view', 'read-only')
  @Get('statement')
  async apStatement(@Req() req: CompanyScopedRequest, @Query('from') from?: string, @Query('to') to?: string, @Query('orgUnitId') orgUnitId?: string) {
    return this.reconciliation.apStatement({ from, to, orgUnitId: orgUnitId ?? null }, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.ap.adjust', 'editable')
  @Post('adjustments')
  async submitAdjustment(@Body() dto: SubmitApAdjustmentDto, @Req() req: CompanyScopedRequest) {
    return this.adjustments.submitAdjustment(dto as never, req.user.id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.ap.approve', 'editable')
  @Post('approvals/:id/decide')
  async decide(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DecideDto, @Req() req: CompanyScopedRequest) {
    return this.adjustments.decide(id, req.user.id, dto.decision as 'approved' | 'rejected', dto.note, req.companyContext!.dataSource.manager);
  }
}
