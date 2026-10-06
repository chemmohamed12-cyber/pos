import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ArrayMinSize, IsArray, IsIn, IsISO8601, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { CommissionService } from '../application/commission.service';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';
import { CommissionAdjustmentKind, CommissionBasis, CommissionPolicyScope, CommissionRateModel } from '../domain/commission-status';

class CreateTierDto {
  tierOrder!: number;

  @IsString()
  fromPercent!: string;

  @IsOptional()
  @IsString()
  toPercent?: string | null;

  @IsString()
  rate!: string;
}

class CreatePolicyDto {
  @IsIn(['sales_rep', 'customer', 'customer_group'])
  scope!: CommissionPolicyScope;

  @IsUUID()
  scopeRefId!: string;

  @IsIn(['gross_sales', 'net_sales', 'collected_amount'])
  basis!: CommissionBasis;

  @IsIn(['flat', 'target_tiered'])
  rateModel!: CommissionRateModel;

  @IsOptional()
  @IsString()
  flatRate?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateTierDto)
  tiers?: CreateTierDto[];
}

class SubmitBatchDto {
  @IsISO8601()
  periodStart!: string;

  @IsISO8601()
  periodEnd!: string;
}

class DecideDto {
  @IsIn(['approved', 'rejected'])
  decision!: 'approved' | 'rejected';

  @IsOptional()
  @IsString()
  @MaxLength(512)
  note?: string;
}

class CreateAdjustmentDto {
  @IsUUID()
  originalCommissionResultId!: string;

  @IsIn(['adjustment', 'correction', 'recalculation'])
  kind!: CommissionAdjustmentKind;

  @IsString()
  @MinLength(1)
  reason!: string;

  @IsString()
  amountDelta!: string;
}

/** ADR-071 — `commission`'s composition-root controller. No manual "calculate" route exists — the Resolution Engine is event-driven off `finance.invoice.posted`/`collection.remitted`, never a human-invoked action (ADR-068 §C). */
@Controller('commission')
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard)
@RequireModule('commission')
export class CommissionController {
  constructor(private readonly commission: CommissionService) {}

  @UseGuards(PermissionGuard)
  @RequirePermission('commission.policy.create', 'editable')
  @Post('policies')
  async createPolicy(@Body() dto: CreatePolicyDto, @Req() req: CompanyScopedRequest) {
    return this.commission.createPolicy({ ...dto, flatRate: dto.flatRate ?? null, tiers: dto.tiers?.map((t) => ({ ...t, toPercent: t.toPercent ?? null })) },
      req.user.id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('commission.policy.view', 'read-only')
  @Get('policies')
  async listPolicies(@Req() req: CompanyScopedRequest) {
    return this.commission.listPolicies(req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('commission.policy.view', 'read-only')
  @Get('policies/:id/tiers')
  async listTiers(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    return this.commission.listTiers(id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('commission.result.view', 'read-only')
  @Get('results')
  async listResults(@Req() req: CompanyScopedRequest, @Query('employeeId') employeeId?: string) {
    return this.commission.listResults(employeeId, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('commission.result.view', 'read-only')
  @Get('results/approved')
  async listApprovedCommissionResults(@Query('employeeId', ParseUUIDPipe) employeeId: string,
    @Query('periodStart') periodStart: string,
    @Query('periodEnd') periodEnd: string, @Req() req: CompanyScopedRequest) {
    return this.commission.listApprovedCommissionResults(employeeId, periodStart, periodEnd, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('commission.batch.submit', 'editable')
  @Post('batches/submit')
  async submitApprovalBatch(@Body() dto: SubmitBatchDto, @Req() req: CompanyScopedRequest) {
    return this.commission.submitApprovalBatch(dto.periodStart, dto.periodEnd, req.user.id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('commission.batch.submit', 'read-only')
  @Get('batches')
  async listApprovalBatches(@Req() req: CompanyScopedRequest) {
    return this.commission.listApprovalBatches(req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('commission.adjustment.create', 'editable')
  @Post('adjustments')
  async createAdjustment(@Body() dto: CreateAdjustmentDto, @Req() req: CompanyScopedRequest) {
    return this.commission.createAdjustment(dto, req.user.id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('commission.result.view', 'read-only')
  @Get('adjustments')
  async listAdjustments(@Req() req: CompanyScopedRequest, @Query('originalCommissionResultId') originalCommissionResultId?: string) {
    return this.commission.listAdjustments(originalCommissionResultId, req.companyContext!.dataSource.manager);
  }

  /** Same generic decide route shape every other FA-01 consumer in this codebase uses. */
  @UseGuards(PermissionGuard)
  @RequirePermission('commission.batch.approve', 'editable')
  @Post('approvals/:requestId/decide')
  async decide(@Param('requestId', ParseUUIDPipe) requestId: string, @Body() dto: DecideDto, @Req() req: CompanyScopedRequest) {
    return this.commission.decide(requestId, req.user.id, dto.decision, dto.note, req.companyContext!.dataSource.manager);
  }
}
