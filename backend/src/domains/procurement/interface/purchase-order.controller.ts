import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { IsArray, IsNumberString, IsOptional, IsString, IsUUID, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { PurchaseOrderService } from '../application/purchase-order.service';
import { JwtAuthGuard, AuthenticatedRequest } from '../../../foundation/authentication/jwt-auth.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';

class CreatePurchaseOrderLineDto {
  @IsUUID()
  productId!: string;

  @IsNumberString()
  quantity!: string;

  @IsNumberString()
  unitCostBase!: string;
}

class CreatePurchaseOrderDto {
  @IsUUID()
  supplierId!: string;

  @IsUUID()
  warehouseId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreatePurchaseOrderLineDto)
  lines!: CreatePurchaseOrderLineDto[];
}

/**
 * ADR-048 — Purchase Order routes. `procurement.purchase_order.approve`
 * is a separate, stricter node from `.create`/`.edit` (a maker can draft
 * a PO without also being the one who approves it — the same
 * segregation-of-duties spirit as the generic Approval Engine, expressed
 * here as a plain permission split since a PO approval is one role's
 * single decision, not a configurable multi-approver flow).
 */
@Controller('procurement/purchase-orders')
@UseGuards(JwtAuthGuard, RequireModuleGuard)
@RequireModule('procurement')
export class PurchaseOrderController {
  constructor(private readonly purchaseOrders: PurchaseOrderService) {}

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.purchase_order.view', 'read-only')
  @Get()
  async list() {
    return this.purchaseOrders.list();
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.purchase_order.view', 'read-only')
  @Get(':id')
  async getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.purchaseOrders.getById(id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.purchase_order.create', 'editable')
  @Post()
  async create(@Body() dto: CreatePurchaseOrderDto, @Req() req: AuthenticatedRequest) {
    return this.purchaseOrders.create(dto, req.user.id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.purchase_order.edit', 'editable')
  @Post(':id/submit')
  async submit(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    return this.purchaseOrders.transition(id, 'submit', req.user.id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.purchase_order.approve', 'editable')
  @Post(':id/approve')
  async approve(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    return this.purchaseOrders.transition(id, 'approve', req.user.id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.purchase_order.approve', 'editable')
  @Post(':id/reject')
  async reject(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    return this.purchaseOrders.transition(id, 'reject', req.user.id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.purchase_order.edit', 'editable')
  @Post(':id/cancel')
  async cancel(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    return this.purchaseOrders.transition(id, 'cancel', req.user.id);
  }
}
