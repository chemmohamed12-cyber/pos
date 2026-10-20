import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { IsArray, IsNumberString, IsOptional, IsString, IsUUID, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { GoodsReceiptService } from '../application/goods-receipt.service';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { WarehouseScopeGuard } from '../../../foundation/scope/warehouse-scope.guard';
import { WarehouseScopeFiltered, WarehouseScoped } from '../../../foundation/scope/warehouse-scope.decorator';
import { AccessScopeService } from '../../../foundation/scope/access-scope.service';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';

class PostGoodsReceiptLineDto {
  @IsUUID()
  purchaseOrderLineId!: string;

  @IsNumberString()
  quantityReceived!: string;
}

class PostGoodsReceiptDto {
  @IsUUID()
  purchaseOrderId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PostGoodsReceiptLineDto)
  lines!: PostGoodsReceiptLineDto[];
}

/**
 * Area 21 Operational Company Scoping Retrofit (2026-09-28, CTO-authorized,
 * controller #18). `CompanyContextGuard` added at the class level — both
 * routes thread `req.companyContext.dataSource.manager` into
 * `GoodsReceiptService`.
 */
@Controller('procurement/goods-receipts')
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard, WarehouseScopeGuard)
@RequireModule('procurement')
export class GoodsReceiptController {
  constructor(
    private readonly goodsReceipts: GoodsReceiptService,
    private readonly scopes: AccessScopeService,
  ) {}

  /** Goods received and not yet invoiced (the work-list behind "create supplier invoice"), limited to the caller's visible warehouses. */
  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.goods_receipt.view', 'read-only')
  @WarehouseScopeFiltered('purchase orders of the caller\'s visible warehouses only')
  @Get('uninvoiced')
  async listUninvoiced(@Req() req: CompanyScopedRequest) {
    if (!req.companyContext) throw new UnauthorizedException();
    const scope = await this.scopes.forRequest(req);
    const visible = await this.scopes.visibleWarehouseIds(scope, req.companyContext.dataSource.manager);
    return this.goodsReceipts.listUninvoiced(req.companyContext.dataSource.manager, visible === 'ALL' ? undefined : visible);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.goods_receipt.view', 'read-only')
  @WarehouseScoped({ recordOf: 'purchase_orders', param: 'purchaseOrderId' })
  @Get('by-purchase-order/:purchaseOrderId')
  async listForPurchaseOrder(@Req() req: CompanyScopedRequest, @Param('purchaseOrderId', ParseUUIDPipe) purchaseOrderId: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.goodsReceipts.listForPurchaseOrder(purchaseOrderId, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.goods_receipt.create', 'editable')
  @WarehouseScoped({ recordOf: 'purchase_orders', body: 'purchaseOrderId' })
  @Post()
  async post(@Body() dto: PostGoodsReceiptDto, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.goodsReceipts.post(dto, req.user.id, req.companyContext.dataSource.manager);
  }
}
