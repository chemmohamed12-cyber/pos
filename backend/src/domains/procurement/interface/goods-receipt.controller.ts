import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { IsArray, IsNumberString, IsOptional, IsString, IsUUID, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { GoodsReceiptService } from '../application/goods-receipt.service';
import { JwtAuthGuard, AuthenticatedRequest } from '../../../foundation/authentication/jwt-auth.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
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

@Controller('procurement/goods-receipts')
@UseGuards(JwtAuthGuard, RequireModuleGuard)
@RequireModule('procurement')
export class GoodsReceiptController {
  constructor(private readonly goodsReceipts: GoodsReceiptService) {}

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.goods_receipt.view', 'read-only')
  @Get('by-purchase-order/:purchaseOrderId')
  async listForPurchaseOrder(@Param('purchaseOrderId', ParseUUIDPipe) purchaseOrderId: string) {
    return this.goodsReceipts.listForPurchaseOrder(purchaseOrderId);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.goods_receipt.create', 'editable')
  @Post()
  async post(@Body() dto: PostGoodsReceiptDto, @Req() req: AuthenticatedRequest) {
    return this.goodsReceipts.post(dto, req.user.id);
  }
}
