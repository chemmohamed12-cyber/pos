import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ArrayMinSize, IsArray, IsNumberString, IsString, IsUUID, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { PurchaseReturnService } from '../application/purchase-return.service';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';

class ReturnLineDto {
  @IsUUID()
  goodsReceiptLineId!: string;

  @IsNumberString()
  quantity!: string;
}

class CreatePurchaseReturnDto {
  @IsString()
  @MaxLength(255)
  reason!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReturnLineDto)
  lines!: ReturnLineDto[];
}

class ReasonDto {
  @IsString()
  @MaxLength(500)
  reason!: string;
}

/** Phase D-1 (D7) - Purchase Returns of goods received but not yet invoiced. Company-scoped; every write on the caller's own Company connection. */
@Controller('procurement/purchase-returns')
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard)
@RequireModule('procurement')
export class PurchaseReturnController {
  constructor(private readonly returns: PurchaseReturnService) {}

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.purchase_return.view', 'read-only')
  @Get()
  async list(@Req() req: CompanyScopedRequest) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.returns.list(req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.purchase_return.view', 'read-only')
  @Get('returnable')
  async returnable(@Req() req: CompanyScopedRequest, @Query('supplierId', ParseUUIDPipe) supplierId: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.returns.returnableLines(supplierId, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.purchase_return.view', 'read-only')
  @Get(':id')
  async get(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.returns.get(id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.purchase_return.create', 'editable')
  @Post()
  async create(@Body() dto: CreatePurchaseReturnDto, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.returns.createDraft(dto, req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.purchase_return.submit', 'editable')
  @Post(':id/submit')
  async submit(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.returns.submit(id, req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.purchase_return.approve', 'editable')
  @Post(':id/approve')
  async approve(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.returns.approve(id, req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.purchase_return.approve', 'editable')
  @Post(':id/reject')
  async reject(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.returns.reject(id, dto.reason, req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.purchase_return.create', 'editable')
  @Post(':id/reopen')
  async reopen(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.returns.reopen(id, req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.purchase_return.create', 'editable')
  @Post(':id/cancel')
  async cancel(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.returns.cancel(id, dto.reason, req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.purchase_return.post', 'editable')
  @Post(':id/post')
  async post(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.returns.post(id, req.user.id, req.companyContext.dataSource.manager);
  }
}
