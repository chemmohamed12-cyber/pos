import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ArrayMinSize, IsArray, IsIn, IsISO8601, IsString, IsUUID, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { PayrollService } from '../application/payroll.service';
import { JwtAuthGuard, AuthenticatedRequest } from '../../../foundation/authentication/jwt-auth.guard';
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
}

class CalculateDto {
  @IsUUID()
  payrollPeriodId!: string;
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

/**
 * ADR-070 — `payroll`'s composition-root controller. Every route requires
 * the module to be entitled (`@RequireModule('payroll')`); writes
 * additionally require the matching `payroll.*` permission node. No
 * `payroll.run.post`/`approve`-as-a-direct-action route exists — `approved
 * -> posted` is automatic (ADR-070 §5), fired from the FA-01 approval
 * event, never a second human-invoked endpoint.
 */
@Controller('payroll')
@UseGuards(JwtAuthGuard, RequireModuleGuard)
@RequireModule('payroll')
export class PayrollController {
  constructor(private readonly payroll: PayrollService) {}

  @UseGuards(PermissionGuard)
  @RequirePermission('payroll.period.create', 'editable')
  @Post('periods')
  async createPeriod(@Body() dto: CreatePeriodDto, @Req() req: AuthenticatedRequest) {
    return this.payroll.createPeriod(dto, req.user.id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('payroll.period.view', 'read-only')
  @Get('periods')
  async listPeriods() {
    return this.payroll.listPeriods();
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('payroll.compensation.create', 'editable')
  @Post('compensations')
  async createCompensation(@Body() dto: CreateCompensationDto, @Req() req: AuthenticatedRequest) {
    return this.payroll.createCompensation(dto, req.user.id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('payroll.compensation.view', 'read-only')
  @Get('compensations')
  async listCompensations(@Query('employeeId') employeeId?: string) {
    return this.payroll.listCompensations(employeeId);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('payroll.run.calculate', 'editable')
  @Post('runs/calculate')
  async calculate(@Body() dto: CalculateDto, @Req() req: AuthenticatedRequest) {
    return this.payroll.calculate(dto.payrollPeriodId, req.user.id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('payroll.run.review', 'editable')
  @Post('runs/:id/review')
  async review(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    return this.payroll.review(id, req.user.id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('payroll.run.approve', 'editable')
  @Post('runs/:id/submit')
  async submitForApproval(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    return this.payroll.submitForApproval(id, req.user.id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('payroll.run.view', 'read-only')
  @Get('runs')
  async listRuns() {
    return this.payroll.listRuns();
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('payroll.run.view', 'read-only')
  @Get('runs/:id')
  async getRun(@Param('id', ParseUUIDPipe) id: string) {
    return this.payroll.getRun(id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('payroll.run.view', 'read-only')
  @Get('run-lines/:id/day-classifications')
  async listDayClassifications(@Param('id', ParseUUIDPipe) id: string) {
    return this.payroll.listDayClassifications(id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('payroll.run.view', 'read-only')
  @Get('reconciliation-gaps')
  async listReconciliationGaps() {
    return this.payroll.listReconciliationGaps();
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('payroll.adjustment.create', 'editable')
  @Post('adjustments')
  async createAdjustment(@Body() dto: CreateAdjustmentDto, @Req() req: AuthenticatedRequest) {
    return this.payroll.createAdjustment(dto, req.user.id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('payroll.run.view', 'read-only')
  @Get('adjustments')
  async listAdjustments(@Query('payrollRunLineId') payrollRunLineId?: string) {
    return this.payroll.listAdjustments(payrollRunLineId);
  }
}
