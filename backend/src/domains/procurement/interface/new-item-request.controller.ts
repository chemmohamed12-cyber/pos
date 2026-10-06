import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { NewItemRequestService } from '../application/new-item-request.service';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';

class CreateNewItemRequestDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  unit?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

/**
 * D7 (2026-10-05) — New Item Request. Anyone who may create a Purchase Request may ask for a new item; the item stays a `draft`
 * Product until ONE approver holding `sales.catalog.edit` approves it through the Approval Engine (decided on the Approvals screen).
 * Company-scoped from the start: every call uses `req.companyContext.dataSource.manager`.
 */
@Controller('procurement/item-requests')
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard)
@RequireModule('procurement')
export class NewItemRequestController {
  constructor(private readonly itemRequests: NewItemRequestService) {}

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.purchase_request.view', 'read-only')
  @Get()
  async list(@Req() req: CompanyScopedRequest, @Query('status') status?: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.itemRequests.list(status, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.purchase_request.view', 'read-only')
  @Get(':id')
  async getById(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.itemRequests.getById(id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.purchase_request.create', 'editable')
  @Post()
  async create(@Body() dto: CreateNewItemRequestDto, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.itemRequests.create(dto, req.user.id, req.companyContext.dataSource.manager);
  }
}
