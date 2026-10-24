import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { IsIn, IsInt, IsNumberString, IsOptional, IsPositive, IsString, IsUUID, MaxLength } from 'class-validator';
import { WorkOrderService } from '../application/work-order.service';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { RequireFeatureGuard, RequireFeature } from '../../../foundation/module-registry/require-feature.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';

class CreateWorkOrderDto {
  @IsUUID()
  finishedProductId!: string;

  @IsInt()
  @IsPositive()
  quantityPlanned!: number;

  @IsUUID()
  warehouseId!: string;
}

class MaterialQuantityDto {
  @IsUUID()
  componentProductId!: string;

  @IsInt()
  @IsPositive()
  quantity!: number;

  /** ADR-061 §16 — the caller's own idempotency key; a genuinely retried request MUST resend the same value. */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  requestId?: string;
}

class OutputQuantityDto {
  @IsInt()
  @IsPositive()
  quantity!: number;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  requestId?: string;
}


class ScrapDto {
  @IsInt()
  @IsPositive()
  quantity!: number;

  @IsString()
  @MaxLength(255)
  reason!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  requestId?: string;
}

class RecoveryDto {
  @IsUUID()
  productId!: string;

  @IsInt()
  @IsPositive()
  quantity!: number;

  @IsNumberString()
  valueBase!: string;

  @IsUUID()
  sourceResultId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  requestId?: string;
}

class TrackedOutcomeDto {
  @IsIn(['rework', 'rejected', 'held'])
  outcomeClass!: 'rework' | 'rejected' | 'held';

  @IsInt()
  @IsPositive()
  quantity!: number;

  @IsString()
  @MaxLength(255)
  reason!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  requestId?: string;
}

class ResolveOutcomeDto {
  @IsIn(['good', 'scrap', 'rework'])
  resolution!: 'good' | 'scrap' | 'rework';
}

/** ADR-061 §14 — Manufacturing/Work Order endpoints, feature-gated per §15 (`manufacturing.work_orders`, off by default). */
@Controller('manufacturing/work-orders')
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard)
@RequireModule('manufacturing')
export class WorkOrderController {
  constructor(private readonly workOrders: WorkOrderService) {}

  @UseGuards(RequireFeatureGuard, PermissionGuard)
  @RequireFeature('manufacturing.work_orders')
  @RequirePermission('manufacturing.work_order.view', 'read-only')
  @Get()
  async list(@Req() req: CompanyScopedRequest) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.workOrders.listWorkOrdersWithSummary(req.companyContext.dataSource.manager);
  }

  @UseGuards(RequireFeatureGuard, PermissionGuard)
  @RequireFeature('manufacturing.work_orders')
  @RequirePermission('manufacturing.work_order.view', 'read-only')
  @Get(':id')
  async get(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    const [workOrder, state, components, operations, wipValue, financialTrail, auditTrail, results] = await Promise.all([
      this.workOrders.getWorkOrderOrThrow(id, manager),
      this.workOrders.getWorkOrderState(id, manager),
      this.workOrders.getWorkOrderComponents(id, manager),
      this.workOrders.getWorkOrderOperations(id, manager),
      this.workOrders.computeWipValue(id, manager),
      this.workOrders.getFinancialTrail(id, manager),
      this.workOrders.getAuditTrail(id, manager),
      this.workOrders.getResults(id, manager),
    ]);
    return { ...workOrder, state, components, operations, wipValue: wipValue.toFixed(4), financialTrail, auditTrail, results };
  }

  /** ADR-061 Addendum 1 (A1) — execution tracking of the routing snapshot; no inventory/GL effect. */
  @UseGuards(RequireFeatureGuard, PermissionGuard)
  @RequireFeature('manufacturing.work_orders')
  @RequirePermission('manufacturing.work_order.operation_execute', 'editable')
  @Post(':id/operations/:operationId/start')
  async startOperation(@Param('id', ParseUUIDPipe) id: string, @Param('operationId', ParseUUIDPipe) operationId: string, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.workOrders.startOperation(id, operationId, req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(RequireFeatureGuard, PermissionGuard)
  @RequireFeature('manufacturing.work_orders')
  @RequirePermission('manufacturing.work_order.operation_execute', 'editable')
  @Post(':id/operations/:operationId/complete')
  async completeOperation(@Param('id', ParseUUIDPipe) id: string, @Param('operationId', ParseUUIDPipe) operationId: string, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.workOrders.completeOperation(id, operationId, req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(RequireFeatureGuard, PermissionGuard)
  @RequireFeature('manufacturing.work_orders')
  @RequirePermission('manufacturing.work_order.create', 'editable')
  @Post()
  async create(@Body() dto: CreateWorkOrderDto, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.workOrders.createWorkOrder(dto.finishedProductId, dto.quantityPlanned, dto.warehouseId, req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(RequireFeatureGuard, PermissionGuard)
  @RequireFeature('manufacturing.work_orders')
  @RequirePermission('manufacturing.work_order.release', 'editable')
  @Post(':id/release')
  async release(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.workOrders.release(id, req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(RequireFeatureGuard, PermissionGuard)
  @RequireFeature('manufacturing.work_orders')
  @RequirePermission('manufacturing.work_order.material_issue', 'editable')
  @Post(':id/material-issue')
  async materialIssue(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MaterialQuantityDto, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    await this.workOrders.materialIssue(id, dto.componentProductId, dto.quantity, req.user.id, dto.requestId, req.companyContext.dataSource.manager);
    return { ok: true };
  }

  @UseGuards(RequireFeatureGuard, PermissionGuard)
  @RequireFeature('manufacturing.work_orders')
  @RequirePermission('manufacturing.work_order.material_return', 'editable')
  @Post(':id/material-return')
  async materialReturn(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MaterialQuantityDto, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    await this.workOrders.materialReturn(id, dto.componentProductId, dto.quantity, req.user.id, dto.requestId, req.companyContext.dataSource.manager);
    return { ok: true };
  }

  @UseGuards(RequireFeatureGuard, PermissionGuard)
  @RequireFeature('manufacturing.work_orders')
  @RequirePermission('manufacturing.work_order.finished_goods_receive', 'editable')
  @Post(':id/finished-goods-output')
  async finishedGoodsOutput(@Param('id', ParseUUIDPipe) id: string, @Body() dto: OutputQuantityDto, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    await this.workOrders.finishedGoodsOutput(id, dto.quantity, req.user.id, dto.requestId, req.companyContext.dataSource.manager);
    return { ok: true };
  }

  /** Manufacturing Engine S1 (D-ME-1) — scrap is its own result: components consumed from WIP, value to the configured loss account, no stock created. */
  @UseGuards(RequireFeatureGuard, PermissionGuard)
  @RequireFeature('manufacturing.work_orders')
  @RequirePermission('manufacturing.work_order.outcome_record', 'editable')
  @Post(':id/scrap')
  async scrap(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ScrapDto, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.workOrders.recordScrap(id, dto.quantity, dto.reason, req.user.id, dto.requestId, req.companyContext.dataSource.manager);
  }

  @UseGuards(RequireFeatureGuard, PermissionGuard)
  @RequireFeature('manufacturing.work_orders')
  @RequirePermission('manufacturing.work_order.outcome_record', 'editable')
  @Post(':id/recovery')
  async recovery(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RecoveryDto, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.workOrders.recordRecovery(id, dto.productId, dto.quantity, dto.valueBase, dto.sourceResultId, req.user.id, dto.requestId, req.companyContext.dataSource.manager);
  }

  @UseGuards(RequireFeatureGuard, PermissionGuard)
  @RequireFeature('manufacturing.work_orders')
  @RequirePermission('manufacturing.work_order.outcome_record', 'editable')
  @Post(':id/outcomes')
  async trackedOutcome(@Param('id', ParseUUIDPipe) id: string, @Body() dto: TrackedOutcomeDto, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.workOrders.recordTrackedOutcome(id, dto.outcomeClass, dto.quantity, dto.reason, req.user.id, dto.requestId, req.companyContext.dataSource.manager);
  }

  @UseGuards(RequireFeatureGuard, PermissionGuard)
  @RequireFeature('manufacturing.work_orders')
  @RequirePermission('manufacturing.work_order.outcome_record', 'editable')
  @Post(':id/outcomes/:resultId/resolve')
  async resolveOutcome(@Param('id', ParseUUIDPipe) id: string, @Param('resultId', ParseUUIDPipe) resultId: string, @Body() dto: ResolveOutcomeDto, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.workOrders.resolveTrackedOutcome(id, resultId, dto.resolution, req.user.id, req.companyContext.dataSource.manager);
  }


  @UseGuards(RequireFeatureGuard, PermissionGuard)
  @RequireFeature('manufacturing.work_orders')
  @RequirePermission('manufacturing.work_order.hold', 'editable')
  @Post(':id/hold')
  async hold(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    await this.workOrders.hold(id, req.user.id, req.companyContext.dataSource.manager);
    return { ok: true };
  }

  @UseGuards(RequireFeatureGuard, PermissionGuard)
  @RequireFeature('manufacturing.work_orders')
  @RequirePermission('manufacturing.work_order.hold', 'editable')
  @Post(':id/resume')
  async resume(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    await this.workOrders.resume(id, req.user.id, req.companyContext.dataSource.manager);
    return { ok: true };
  }

  @UseGuards(RequireFeatureGuard, PermissionGuard)
  @RequireFeature('manufacturing.work_orders')
  @RequirePermission('manufacturing.work_order.complete', 'editable')
  @Post(':id/complete')
  async complete(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    await this.workOrders.complete(id, req.user.id, req.companyContext.dataSource.manager);
    return { ok: true };
  }

  @UseGuards(RequireFeatureGuard, PermissionGuard)
  @RequireFeature('manufacturing.work_orders')
  @RequirePermission('manufacturing.work_order.cancel', 'editable')
  @Post(':id/cancel')
  async cancel(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    await this.workOrders.cancel(id, req.user.id, req.companyContext.dataSource.manager);
    return { ok: true };
  }
}
