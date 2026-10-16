import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { ProductMasterDataService } from '../application/product-master-data.service';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';

class CreateCategoryDto {
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  parentId?: string | null;
}

class UpdateCategoryDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  parentId?: string | null;
}

class SetCategoryStatusDto {
  @IsIn(['active', 'inactive'])
  status!: 'active' | 'inactive';
}

/**
 * Master data step 1 (approved 2026-10-15, M1) — item categories. Reads follow the catalog's own read policy (any authenticated
 * Company user, like `/products/all`); writes reuse the catalog edit node `sales.catalog.edit` (no new permission node).
 */
@Controller('product-categories')
export class ProductCategoriesController {
  constructor(private readonly masterData: ProductMasterDataService) {}

  @UseGuards(JwtAuthGuard, CompanyContextGuard)
  @Get()
  async list(@Req() req: CompanyScopedRequest) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.masterData.listCategories(req.companyContext.dataSource.manager);
  }

  @UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard, PermissionGuard)
  @RequireModule('sales')
  @RequirePermission('sales.catalog.edit', 'editable')
  @Post()
  async create(@Req() req: CompanyScopedRequest, @Body() dto: CreateCategoryDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.masterData.createCategory(dto, req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard, PermissionGuard)
  @RequireModule('sales')
  @RequirePermission('sales.catalog.edit', 'editable')
  @Post(':id/update')
  async update(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCategoryDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.masterData.updateCategory(id, dto, req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard, PermissionGuard)
  @RequireModule('sales')
  @RequirePermission('sales.catalog.edit', 'editable')
  @Post(':id/status')
  async setStatus(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetCategoryStatusDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.masterData.setCategoryStatus(id, dto.status, req.user.id, req.companyContext.dataSource.manager);
  }
}
