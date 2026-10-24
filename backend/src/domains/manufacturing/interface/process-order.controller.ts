import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { IsIn, IsInt, IsObject, IsOptional, IsPositive, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { RequireFeatureGuard, RequireFeature } from '../../../foundation/module-registry/require-feature.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';
import { WorkOrderService } from '../application/work-order.service';
import { ProcessExecutionService } from '../application/process-execution.service';

class CreateProcessOrderDto {
  @IsUUID()
  finishedProductId!: string;

  @IsInt()
  @IsPositive()
  quantityPlanned!: number;

  @IsUUID()
  warehouseId!: string;

  /** `{ "<operationCode>|<group>": "<componentProductId>" }` - one explicit choice per alternate group. */
  @IsOptional()
  @IsObject()
  alternateChoices?: Record<string, string>;
}

class StartDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  requestId?: string;
}

class OutputUnitsDto {
  @IsInt()
  @IsPositive()
  units!: number;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  requestId?: string;
}

class RunScrapDto {
  @IsInt()
  @IsPositive()
  quantity!: number;

  @IsString()
  @MinLength(3)
  @MaxLength(255)
  reason!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  requestId?: string;
}

class RunOutcomeDto extends RunScrapDto {
  @IsIn(['rework', 'rejected', 'held'])
  outcomeClass!: 'rework' | 'rejected' | 'held';
}

class FlowDto {
  @IsUUID()
  productId!: string;

  @IsInt()
  @IsPositive()
  quantity!: number;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  requestId?: string;
}

/**
 * Manufacturing Engine S4 - process-bound Work Orders: creation against the product's active process version, and the graph-gated operation runs with per-operation consumption
 * and yields. The order lifecycle itself (release / material issue / output / scrap / complete) stays on `manufacturing/work-orders` unchanged. Feature-gated like the orders.
 */
@Controller('manufacturing/process-orders')
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard)
@RequireModule('manufacturing')
export class ProcessOrderController {
  constructor(
    private readonly workOrders: WorkOrderService,
    private readonly execution: ProcessExecutionService,
  ) {}

  @UseGuards(RequireFeatureGuard, PermissionGuard)
  @RequireFeature('manufacturing.work_orders')
  @RequirePermission('manufacturing.work_order.create', 'editable')
  @Post()
  async create(@Body() dto: CreateProcessOrderDto, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.workOrders.createProcessWorkOrder(dto.finishedProductId, dto.quantityPlanned, dto.warehouseId, dto.alternateChoices ?? null, req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(RequireFeatureGuard, PermissionGuard)
  @RequireFeature('manufacturing.work_orders')
  @RequirePermission('manufacturing.work_order.view', 'read-only')
  @Get(':id')
  async get(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.execution.getExecution(id, req.companyContext.dataSource.manager);
  }

  @UseGuards(RequireFeatureGuard, PermissionGuard)
  @RequireFeature('manufacturing.work_orders')
  @RequirePermission('manufacturing.work_order.operation_execute', 'editable')
  @Post(':id/operations/:code/start')
  async start(@Param('id', ParseUUIDPipe) id: string, @Param('code') code: string, @Body() dto: StartDto, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.execution.startOperation(id, code, req.user.id, dto.requestId, req.companyContext.dataSource.manager);
  }

  @UseGuards(RequireFeatureGuard, PermissionGuard)
  @RequireFeature('manufacturing.work_orders')
  @RequirePermission('manufacturing.work_order.operation_execute', 'editable')
  @Post(':id/operations/:code/skip')
  async skip(@Param('id', ParseUUIDPipe) id: string, @Param('code') code: string, @Body() dto: StartDto, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.execution.skipOperation(id, code, req.user.id, dto.requestId, req.companyContext.dataSource.manager);
  }

  @UseGuards(RequireFeatureGuard, PermissionGuard)
  @RequireFeature('manufacturing.work_orders')
  @RequirePermission('manufacturing.work_order.operation_execute', 'editable')
  @Post(':id/runs/:runId/consume')
  async consume(@Param('id', ParseUUIDPipe) id: string, @Param('runId', ParseUUIDPipe) runId: string, @Body() dto: FlowDto, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.execution.recordConsumption(id, runId, dto.productId, dto.quantity, req.user.id, dto.requestId, req.companyContext.dataSource.manager);
  }

  @UseGuards(RequireFeatureGuard, PermissionGuard)
  @RequireFeature('manufacturing.work_orders')
  @RequirePermission('manufacturing.work_order.operation_execute', 'editable')
  @Post(':id/runs/:runId/yield')
  async yield(@Param('id', ParseUUIDPipe) id: string, @Param('runId', ParseUUIDPipe) runId: string, @Body() dto: FlowDto, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.execution.recordYield(id, runId, dto.productId, dto.quantity, req.user.id, dto.requestId, req.companyContext.dataSource.manager);
  }

  @UseGuards(RequireFeatureGuard, PermissionGuard)
  @RequireFeature('manufacturing.work_orders')
  @RequirePermission('manufacturing.work_order.finished_goods_receive', 'editable')
  @Post(':id/output')
  async output(@Param('id', ParseUUIDPipe) id: string, @Body() dto: OutputUnitsDto, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.workOrders.receiveProcessOutputs(id, dto.units, req.user.id, dto.requestId, req.companyContext.dataSource.manager);
  }

  @UseGuards(RequireFeatureGuard, PermissionGuard)
  @RequireFeature('manufacturing.work_orders')
  @RequirePermission('manufacturing.work_order.outcome_record', 'editable')
  @Post(':id/runs/:runId/scrap')
  async scrap(@Param('id', ParseUUIDPipe) id: string, @Param('runId', ParseUUIDPipe) runId: string, @Body() dto: RunScrapDto, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.execution.recordScrapAt(id, runId, dto.quantity, dto.reason, req.user.id, dto.requestId, req.companyContext.dataSource.manager);
  }

  @UseGuards(RequireFeatureGuard, PermissionGuard)
  @RequireFeature('manufacturing.work_orders')
  @RequirePermission('manufacturing.work_order.outcome_record', 'editable')
  @Post(':id/runs/:runId/outcome')
  async outcome(@Param('id', ParseUUIDPipe) id: string, @Param('runId', ParseUUIDPipe) runId: string, @Body() dto: RunOutcomeDto, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.execution.recordOutcomeAt(id, runId, dto.outcomeClass, dto.quantity, dto.reason, req.user.id, dto.requestId, req.companyContext.dataSource.manager);
  }

  @UseGuards(RequireFeatureGuard, PermissionGuard)
  @RequireFeature('manufacturing.work_orders')
  @RequirePermission('manufacturing.work_order.operation_execute', 'editable')
  @Post(':id/runs/:runId/complete')
  async complete(@Param('id', ParseUUIDPipe) id: string, @Param('runId', ParseUUIDPipe) runId: string, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.execution.completeRun(id, runId, req.user.id, req.companyContext.dataSource.manager);
  }
}
