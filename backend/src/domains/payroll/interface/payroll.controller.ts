import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ArrayMinSize, IsArray, IsIn, IsISO8601, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { PayrollService } from '../application/payroll.service';
import { PayrollPayoutService } from '../application/payroll-payout.service';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';
import { PayrollAdjustmentKind } from '../domain/payroll-run-status';

class CreatePeriodDto {
  @IsString()
  @MinLength(1)
  code!: string;

  @IsISO8601()
  startDate!: string;

  @IsISO8601()
  endDate!: string;
}

class EarningLineDto {
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  componentCode!: string;

  @IsString()
  amount!: string;
}

class CreateCompensationDto {
  @IsUUID()
  employeeId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => EarningLineDto)
  earnings!: EarningLineDto[];

  /** YYYY-MM-DD — when the change takes effect (defaults to today). */
  @IsOptional()
  @IsISO8601({ strict: true })
  effectiveFrom?: string;

  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

class CalculateDto {
  @IsUUID()
  payrollPeriodId!: string;
}

class DisburseDto {
  @IsUUID()
  treasuryAccountId!: string;
}

class CreatePayoutBatchDto {
  @IsUUID()
  treasuryAccountId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(24)
  method?: string;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  lineIds?: string[];
}

class DecideDto {
  @IsIn(['approved', 'rejected'])
  decision!: 'approved' | 'rejected';

  @IsOptional()
  @IsString()
  @MaxLength(512)
  note?: string;
}

class AcknowledgeExceptionsDto {
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  exceptionIds?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(48)
  code?: string;

  /** The reference of the documented decision that allows approval despite the condition. */
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  decisionRef!: string;
}

class CreateAdjustmentDto {
  @IsUUID()
  originalPayrollRunLineId!: string;

  @IsIn(['adjustment', 'correction', 'recalculation'])
  kind!: PayrollAdjustmentKind;

  @IsString()
  @MinLength(1)
  reason!: string;

  @IsString()
  amountDelta!: string;
}

class SodProfileDto {
  @IsIn(['standard', 'strict'])
  profile!: 'standard' | 'strict';
}

/**
 * ADR-070 — `payroll`'s composition-root controller. Every route requires the module to be entitled (`@RequireModule('payroll')`); writes additionally require
 * the matching `payroll.*` permission node. No `payroll.run.post`/`approve`-as-a-direct-action route exists — `approved -> posted` is automatic (ADR-070 §5), fired
 * from the FA-01 approval event, never a second human-invoked endpoint. Separation of duties is NOT decided here: the service compares the recorded actor of each
 * stage (the permission only says who may *try*).
 */
@Controller('payroll')
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard)
@RequireModule('payroll')
export class PayrollController {
  constructor(
    private readonly payroll: PayrollService,
    private readonly payouts: PayrollPayoutService,
  ) {}

  @UseGuards(PermissionGuard)
  @RequirePermission('payroll.period.create', 'editable')
  @Post('periods')
  async createPeriod(@Body() dto: CreatePeriodDto, @Req() req: CompanyScopedRequest) {
    return this.payroll.createPeriod(dto, req.user.id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('payroll.period.view', 'read-only')
  @Get('periods')
  async listPeriods(@Req() req: CompanyScopedRequest) {
    return this.payroll.listPeriods(req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('payroll.period.close', 'editable')
  @Post('periods/:id/close')
  async closePeriod(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    return this.payroll.closePeriod(id, req.user.id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('payroll.compensation.create', 'editable')
  @Post('compensations')
  async createCompensation(@Body() dto: CreateCompensationDto, @Req() req: CompanyScopedRequest) {
    return this.payroll.createCompensation(dto, req.user.id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('payroll.compensation.view', 'read-only')
  @Get('compensations')
  async listCompensations(@Req() req: CompanyScopedRequest, @Query('employeeId') employeeId?: string) {
    return this.payroll.listCompensations(employeeId, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('payroll.run.calculate', 'editable')
  @Post('runs/calculate')
  async calculate(@Body() dto: CalculateDto, @Req() req: CompanyScopedRequest) {
    return this.payroll.calculate(dto.payrollPeriodId, req.user.id, req.companyContext!.dataSource.manager);
  }

  /** Addendum A-4 R-3 — a delta-only run for a period that already has a posted run (also the post-close correction path). */
  @UseGuards(PermissionGuard)
  @RequirePermission('payroll.run.calculate', 'editable')
  @Post('runs/calculate-supplementary')
  async calculateSupplementary(@Body() dto: CalculateDto, @Req() req: CompanyScopedRequest) {
    return this.payroll.calculateSupplementary(dto.payrollPeriodId, req.user.id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('payroll.run.review', 'editable')
  @Post('runs/:id/review')
  async review(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    return this.payroll.review(id, req.user.id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('payroll.run.submit', 'editable')
  @Post('runs/:id/submit')
  async submitForApproval(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    return this.payroll.submitForApproval(id, req.user.id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('payroll.run.view', 'read-only')
  @Get('runs')
  async listRuns(@Req() req: CompanyScopedRequest) {
    return this.payroll.listRuns(req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('payroll.run.view', 'read-only')
  @Get('runs/:id')
  async getRun(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    return this.payroll.getRun(id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('payroll.run.view', 'read-only')
  @Get('runs/:id/financial-event-status')
  async getFinancialEventStatus(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    return this.payroll.getFinancialEventStatus(id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('payroll.run.view', 'read-only')
  @Get('runs/:id/exceptions')
  async listExceptions(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    return this.payroll.listExceptions(id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('payroll.exception.acknowledge', 'editable')
  @Post('runs/:id/exceptions/acknowledge')
  async acknowledgeExceptions(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AcknowledgeExceptionsDto, @Req() req: CompanyScopedRequest) {
    return this.payroll.acknowledgeExceptions(id, { exceptionIds: dto.exceptionIds, code: dto.code }, dto.decisionRef, req.user.id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('payroll.run.view', 'read-only')
  @Get('runs/:id/actors')
  async listActors(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    return this.payroll.listStageActors(id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('payroll.run.view', 'read-only')
  @Get('runs/:id/inputs')
  async listInputs(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    return this.payroll.listInputConsumptions(id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('payroll.run.view', 'read-only')
  @Get('runs/:id/reconciliation')
  async reconcile(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    return this.payroll.reconcile(id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('payroll.run.view', 'read-only')
  @Get('run-lines/:id/day-classifications')
  async listDayClassifications(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    return this.payroll.listDayClassifications(id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('payroll.run.view', 'read-only')
  @Get('reconciliation-gaps')
  async listReconciliationGaps(@Req() req: CompanyScopedRequest) {
    return this.payroll.listReconciliationGaps(req.companyContext!.dataSource.manager);
  }

  /** ADR-070 §9 — a distinct permission node from `payroll.run.approve`; the service additionally refuses the approver (and, under `strict`, others) as disburser. */
  @UseGuards(PermissionGuard)
  @RequirePermission('payroll.run.disburse', 'editable')
  @Post('runs/:id/disburse')
  async disburse(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DisburseDto, @Req() req: CompanyScopedRequest) {
    return this.payroll.disburse(id, dto.treasuryAccountId, req.user.id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('payroll.run.view', 'read-only')
  @Get('runs/:id/payouts')
  async listPayouts(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    return this.payouts.listBatches(id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('payroll.run.disburse', 'editable')
  @Post('runs/:id/payouts')
  async createPayoutBatch(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreatePayoutBatchDto, @Req() req: CompanyScopedRequest) {
    return this.payouts.createBatch(id, dto.treasuryAccountId, req.user.id, req.companyContext!.dataSource.manager, { method: dto.method ?? null, lineIds: dto.lineIds });
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('payroll.run.disburse', 'editable')
  @Post('payouts/:batchId/execute')
  async executePayoutBatch(@Param('batchId', ParseUUIDPipe) batchId: string, @Req() req: CompanyScopedRequest) {
    return this.payouts.executeBatch(batchId, req.user.id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('payroll.run.disburse', 'editable')
  @Post('payouts/:batchId/cancel')
  async cancelPayoutBatch(@Param('batchId', ParseUUIDPipe) batchId: string, @Req() req: CompanyScopedRequest) {
    return this.payouts.cancelBatch(batchId, req.user.id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('payroll.adjustment.create', 'editable')
  @Post('adjustments')
  async createAdjustment(@Body() dto: CreateAdjustmentDto, @Req() req: CompanyScopedRequest) {
    return this.payroll.createAdjustment(dto, req.user.id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('payroll.run.view', 'read-only')
  @Get('adjustments')
  async listAdjustments(@Req() req: CompanyScopedRequest, @Query('payrollRunLineId') payrollRunLineId?: string) {
    return this.payroll.listAdjustments(payrollRunLineId, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('payroll.settings.view', 'read-only')
  @Get('settings/sod-profile')
  async getSodProfile(@Req() req: CompanyScopedRequest) {
    return { profile: await this.payroll.getSodProfile(req.companyContext!.dataSource.manager) };
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('payroll.settings.manage', 'editable')
  @Put('settings/sod-profile')
  async setSodProfile(@Body() dto: SodProfileDto, @Req() req: CompanyScopedRequest) {
    return { profile: await this.payroll.setSodProfile(dto.profile, req.user.id, req.companyContext!.dataSource.manager) };
  }

  /** Same generic decide route shape every other FA-01 consumer in this codebase uses (e.g. Attendance) — `ApprovalEngineService.decide` needs only the request id, never a type discriminator. */
  @UseGuards(PermissionGuard)
  @RequirePermission('payroll.run.approve', 'editable')
  @Post('approvals/:requestId/decide')
  async decide(@Param('requestId', ParseUUIDPipe) requestId: string, @Body() dto: DecideDto, @Req() req: CompanyScopedRequest) {
    return this.payroll.decide(requestId, req.user.id, dto.decision, dto.note, req.companyContext!.dataSource.manager);
  }
}
