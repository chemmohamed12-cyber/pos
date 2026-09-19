import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { IsInt, IsOptional, IsPositive, IsString, IsUUID, MaxLength } from 'class-validator';
import { WorkOrderService } from '../application/work-order.service';
import { JwtAuthGuard, AuthenticatedRequest } from '../../../foundation/authentication/jwt-auth.guard';
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

/** ADR-061 §14 — Manufacturing/Work Order endpoints, feature-gated per §15 (`manufacturing.work_orders`, off by default). */
@Controller('manufacturing/work-orders')
@UseGuards(JwtAuthGuard, RequireModuleGuard)
@RequireModule('manufacturing')
export class WorkOrderController {
  constructor(private readonly workOrders: WorkOrderService) {}

  @UseGuards(RequireFeatureGuard, PermissionGuard)
  @RequireFeature('manufacturing.work_orders')
  @RequirePermission('manufacturing.work_order.view', 'read-only')
  @Get()
  async list() {
    return this.workOrders.listWorkOrders();
  }

  @UseGuards(RequireFeatureGuard, PermissionGuard)
  @RequireFeature('manufacturing.work_orders')
  @RequirePermission('manufacturing.work_order.view', 'read-only')
  @Get(':id')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    const [workOrder, state, components, wipValue] = await Promise.all([
      this.workOrders.getWorkOrderOrThrow(id),
      this.workOrders.getWorkOrderState(id),
      this.workOrders.getWorkOrderComponents(id),
      this.workOrders.computeWipValue(id),
    ]);
    return { ...workOrder, state, components, wipValue: wipValue.toFixed(4) };
  }

  @UseGuards(RequireFeatureGuard, PermissionGuard)
  @RequireFeature('manufacturing.work_orders')
  @RequirePermission('manufacturing.work_order.create', 'editable')
  @Post()
  async create(@Body() dto: CreateWorkOrderDto, @Req() req: AuthenticatedRequest) {
    return this.workOrders.createWorkOrder(dto.finishedProductId, dto.quantityPlanned, dto.warehouseId, req.user.id);
  }

  @UseGuards(RequireFeatureGuard, PermissionGuard)
  @RequireFeature('manufacturing.work_orders')
  @RequirePermission('manufacturing.work_order.release', 'editable')
  @Post(':id/release')
  async release(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    return this.workOrders.release(id, req.user.id);
  }

  @UseGuards(RequireFeatureGuard, PermissionGuard)
  @RequireFeature('manufacturing.work_orders')
  @RequirePermission('manufacturing.work_order.material_issue', 'editable')
  @Post(':id/material-issue')
  async materialIssue(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MaterialQuantityDto, @Req() req: AuthenticatedRequest) {
    await this.workOrders.materialIssue(id, dto.componentProductId, dto.quantity, req.user.id, dto.requestId);
    return { ok: true };
  }

  @UseGuards(RequireFeatureGuard, PermissionGuard)
  @RequireFeature('manufacturing.work_orders')
  @RequirePermission('manufacturing.work_order.material_return', 'editable')
  @Post(':id/material-return')
  async materialReturn(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MaterialQuantityDto, @Req() req: AuthenticatedRequest) {
    await this.workOrders.materialReturn(id, dto.componentProductId, dto.quantity, req.user.id, dto.requestId);
    return { ok: true };
  }

  @UseGuards(RequireFeatureGuard, PermissionGuard)
  @RequireFeature('manufacturing.work_orders')
  @RequirePermission('manufacturing.work_order.finished_goods_receive', 'editable')
  @Post(':id/finished-goods-output')
  async finishedGoodsOutput(@Param('id', ParseUUIDPipe) id: string, @Body() dto: OutputQuantityDto, @Req() req: AuthenticatedRequest) {
    await this.workOrders.finishedGoodsOutput(id, dto.quantity, req.user.id, dto.requestId);
    return { ok: true };
  }

  @UseGuards(RequireFeatureGuard, PermissionGuard)
  @RequireFeature('manufacturing.work_orders')
  @RequirePermission('manufacturing.work_order.hold', 'editable')
  @Post(':id/hold')
  async hold(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    await this.workOrders.hold(id, req.user.id);
    return { ok: true };
  }

  @UseGuards(RequireFeatureGuard, PermissionGuard)
  @RequireFeature('manufacturing.work_orders')
  @RequirePermission('manufacturing.work_order.hold', 'editable')
  @Post(':id/resume')
  async resume(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    await this.workOrders.resume(id, req.user.id);
    return { ok: true };
  }

  @UseGuards(RequireFeatureGuard, PermissionGuard)
  @RequireFeature('manufacturing.work_orders')
  @RequirePermission('manufacturing.work_order.complete', 'editable')
  @Post(':id/complete')
  async complete(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    await this.workOrders.complete(id, req.user.id);
    return { ok: true };
  }

  @UseGuards(RequireFeatureGuard, PermissionGuard)
  @RequireFeature('manufacturing.work_orders')
  @RequirePermission('manufacturing.work_order.cancel', 'editable')
  @Post(':id/cancel')
  async cancel(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    await this.workOrders.cancel(id, req.user.id);
    return { ok: true };
  }
}
