import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { IsArray, IsISO8601, IsNumberString, IsOptional, IsString, IsUUID, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { PurchaseRequestService } from '../application/purchase-request.service';
import { JwtAuthGuard, AuthenticatedRequest } from '../../../foundation/authentication/jwt-auth.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';

class CreatePurchaseRequestLineDto {
  @IsUUID()
  productId!: string;

  @IsNumberString()
  quantity!: string;

  @IsOptional()
  @IsISO8601()
  neededByDate?: string;
}

class CreatePurchaseRequestDto {
  @IsUUID()
  warehouseId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreatePurchaseRequestLineDto)
  lines!: CreatePurchaseRequestLineDto[];
}

class CreateRfqDto {
  @IsArray()
  @IsUUID('4', { each: true })
  supplierIds!: string[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

/** ADR-048 — Path B, step 1: Purchase Request. */
@Controller('procurement/purchase-requests')
@UseGuards(JwtAuthGuard, RequireModuleGuard)
@RequireModule('procurement')
export class PurchaseRequestController {
  constructor(private readonly purchaseRequests: PurchaseRequestService) {}

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.purchase_request.view', 'read-only')
  @Get()
  async list() {
    return this.purchaseRequests.list();
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.purchase_request.view', 'read-only')
  @Get(':id')
  async getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.purchaseRequests.getById(id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.purchase_request.create', 'editable')
  @Post()
  async create(@Body() dto: CreatePurchaseRequestDto, @Req() req: AuthenticatedRequest) {
    return this.purchaseRequests.create(dto, req.user.id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.purchase_request.edit', 'editable')
  @Post(':id/submit')
  async submit(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    return this.purchaseRequests.transition(id, 'submit', req.user.id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.purchase_request.approve', 'editable')
  @Post(':id/approve')
  async approve(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    return this.purchaseRequests.transition(id, 'approve', req.user.id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.purchase_request.approve', 'editable')
  @Post(':id/reject')
  async reject(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    return this.purchaseRequests.transition(id, 'reject', req.user.id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.purchase_request.edit', 'editable')
  @Post(':id/cancel')
  async cancel(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    return this.purchaseRequests.transition(id, 'cancel', req.user.id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.rfq.create', 'editable')
  @Post(':id/create-rfq')
  async createRfq(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateRfqDto, @Req() req: AuthenticatedRequest) {
    return this.purchaseRequests.createRfqFromRequest(id, dto.supplierIds, dto.notes ?? null, req.user.id);
  }
}
