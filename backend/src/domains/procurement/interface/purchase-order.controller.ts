import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { IsArray, IsNumberString, IsOptional, IsString, IsUUID, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { PurchaseOrderService } from '../application/purchase-order.service';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { AccessScopeService } from '../../../foundation/scope/access-scope.service';
import { WarehouseScopeGuard } from '../../../foundation/scope/warehouse-scope.guard';
import { WarehouseScopeFiltered, WarehouseScoped } from '../../../foundation/scope/warehouse-scope.decorator';
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
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard, WarehouseScopeGuard)
@RequireModule('procurement')
export class PurchaseOrderController {
  constructor(
    private readonly purchaseOrders: PurchaseOrderService,
    private readonly scopes: AccessScopeService,
  ) {}

  /** F6 — the caller's visible warehouses for the list filter (`undefined` = unrestricted). */
  private async visibleOnly(req: CompanyScopedRequest): Promise<string[] | undefined> {
    const scope = await this.scopes.forRequest(req);
    const visible = await this.scopes.visibleWarehouseIds(scope, req.companyContext!.dataSource.manager);
    return visible === 'ALL' ? undefined : visible;
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.purchase_order.view', 'read-only')
  @WarehouseScopeFiltered('purchase orders of the caller\'s visible warehouses only')
  @Get()
  async list(@Req() req: CompanyScopedRequest, @Query('supplierId', new ParseUUIDPipe({ optional: true })) supplierId?: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.purchaseOrders.list(req.companyContext.dataSource.manager, await this.visibleOnly(req), supplierId);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.purchase_order.view', 'read-only')
  @WarehouseScoped({ recordOf: 'purchase_orders', param: 'id' })
  @Get(':id')
  async getById(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.purchaseOrders.getById(id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.purchase_order.create', 'editable')
  @WarehouseScoped({ body: 'warehouseId' })
  @Post()
  async create(@Body() dto: CreatePurchaseOrderDto, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.purchaseOrders.create(dto, req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.purchase_order.edit', 'editable')
  @WarehouseScoped({ recordOf: 'purchase_orders', param: 'id' })
  @Post(':id/submit')
  async submit(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.purchaseOrders.transition(id, 'submit', req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.purchase_order.approve', 'editable')
  @WarehouseScoped({ recordOf: 'purchase_orders', param: 'id' })
  @Post(':id/approve')
  async approve(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.purchaseOrders.transition(id, 'approve', req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.purchase_order.approve', 'editable')
  @WarehouseScoped({ recordOf: 'purchase_orders', param: 'id' })
  @Post(':id/reject')
  async reject(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.purchaseOrders.transition(id, 'reject', req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.purchase_order.edit', 'editable')
  @WarehouseScoped({ recordOf: 'purchase_orders', param: 'id' })
  @Post(':id/cancel')
  async cancel(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.purchaseOrders.transition(id, 'cancel', req.user.id, req.companyContext.dataSource.manager);
  }
}
