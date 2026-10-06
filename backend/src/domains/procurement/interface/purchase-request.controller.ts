import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { IsArray, IsISO8601, IsNumberString, IsOptional, IsString, IsUUID, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { PurchaseRequestService } from '../application/purchase-request.service';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
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
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard)
@RequireModule('procurement')
export class PurchaseRequestController {
  constructor(private readonly purchaseRequests: PurchaseRequestService) {}

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.purchase_request.view', 'read-only')
  @Get()
  async list(@Req() req: CompanyScopedRequest) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.purchaseRequests.list(req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.purchase_request.view', 'read-only')
  @Get(':id')
  async getById(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.purchaseRequests.getById(id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.purchase_request.create', 'editable')
  @Post()
  async create(@Body() dto: CreatePurchaseRequestDto, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.purchaseRequests.create(dto, req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.purchase_request.edit', 'editable')
  @Post(':id/submit')
  async submit(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.purchaseRequests.transition(id, 'submit', req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.purchase_request.approve', 'editable')
  @Post(':id/approve')
  async approve(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.purchaseRequests.transition(id, 'approve', req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.purchase_request.approve', 'editable')
  @Post(':id/reject')
  async reject(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.purchaseRequests.transition(id, 'reject', req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.purchase_request.edit', 'editable')
  @Post(':id/cancel')
  async cancel(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.purchaseRequests.transition(id, 'cancel', req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.rfq.create', 'editable')
  @Post(':id/create-rfq')
  async createRfq(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateRfqDto, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.purchaseRequests.createRfqFromRequest(id, dto.supplierIds, dto.notes ?? null, req.user.id, req.companyContext.dataSource.manager);
  }
}
