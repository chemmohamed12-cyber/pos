import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsIn, IsISO8601, IsNumberString, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { InventoryReconciliationService } from '../application/inventory-reconciliation.service';
import { InventoryAdjustmentService } from '../application/inventory-adjustment.service';
import { INVENTORY_ADJUSTMENT_KINDS } from '../domain/inventory';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';

class RunInventoryReconciliationDto {
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

class SubmitInventoryAdjustmentDto {
  @IsOptional()
  @IsUUID()
  productId?: string;

  @IsOptional()
  @IsUUID()
  warehouseId?: string;

  @IsIn(INVENTORY_ADJUSTMENT_KINDS as unknown as string[])
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

  @IsString()
  @MaxLength(32)
  counterAccountCode!: string;

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
 * F07 — Inventory Accounting (ADR-040, Blueprint §2.5). The same guard
 * stack as F02–F06: `@RequireModule('accounting')` (404 for un-entitled,
 * checked before permission) + a per-route `@RequirePermission`.
 * `reconcile` / `close` are gated by `accounting.inventory.create` (not an
 * ADR-024 verb — a run is a create; disclosed like F04/F05/F06).
 */
@Controller('accounting/inventory')
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard)
@RequireModule('accounting')
export class InventoryAccountingController {
  constructor(
    private readonly reconciliation: InventoryReconciliationService,
    private readonly adjustments: InventoryAdjustmentService,
  ) {}

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.inventory.view', 'read-only')
  @Get('reconciliations')
  async listReconciliations(@Req() req: CompanyScopedRequest, @Query('status') status?: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.reconciliation.listRuns({ status, from, to }, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.inventory.view', 'read-only')
  @Get('reconciliations/:id')
  async getReconciliation(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    return this.reconciliation.getRun(id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.inventory.create', 'editable')
  @Post('reconciliations')
  async runReconciliation(@Body() dto: RunInventoryReconciliationDto, @Req() req: CompanyScopedRequest) {
    return this.reconciliation.reconcile(dto, req.user.id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.inventory.create', 'editable')
  @Post('reconciliations/:id/close')
  async closeReconciliation(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    return this.reconciliation.closeRun(id, req.user.id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.inventory.adjust', 'editable')
  @Post('adjustments')
  async submitAdjustment(@Body() dto: SubmitInventoryAdjustmentDto, @Req() req: CompanyScopedRequest) {
    return this.adjustments.submitAdjustment(dto as never, req.user.id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('accounting.inventory.approve', 'editable')
  @Post('approvals/:id/decide')
  async decide(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DecideDto, @Req() req: CompanyScopedRequest) {
    return this.adjustments.decide(id, req.user.id, dto.decision as 'approved' | 'rejected', dto.note, req.companyContext!.dataSource.manager);
  }
}
