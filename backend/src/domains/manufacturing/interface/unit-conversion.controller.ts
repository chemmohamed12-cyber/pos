import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { IsInt, IsString, MaxLength, Min, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';
import { UnitConversionService } from '../application/unit-conversion.service';

class SetUnitConversionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  unitCode!: string;

  @IsInt()
  @Min(2)
  factor!: number;
}

/**
 * Manufacturing Engine S2 (decision D-ME-2) — per-product unit conversions (integer base-unit scaling). Reuses the BOM permission nodes (view / edit): a conversion is part of
 * how a recipe quantity is expressed, not a separate capability. Company-scoped (Area 21 stack).
 */
@Controller('manufacturing/unit-conversions')
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard)
@RequireModule('manufacturing')
export class UnitConversionController {
  constructor(private readonly units: UnitConversionService) {}

  @UseGuards(PermissionGuard)
  @RequirePermission('manufacturing.bom.view', 'read-only')
  @Get(':productId')
  async list(@Req() req: CompanyScopedRequest, @Param('productId', ParseUUIDPipe) productId: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.units.list(productId, req.companyContext.dataSource.manager);
  }

  /** Dry-run conversion for the screens: `?quantity=0.25&unitCode=kg` -> `{ baseQuantity }` (409 when not an exact whole number of base units). */
  @UseGuards(PermissionGuard)
  @RequirePermission('manufacturing.bom.view', 'read-only')
  @Get(':productId/convert')
  async convert(@Req() req: CompanyScopedRequest, @Param('productId', ParseUUIDPipe) productId: string, @Query('quantity') quantity: string, @Query('unitCode') unitCode?: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    return { baseQuantity: await this.units.toBase(productId, quantity, unitCode, req.companyContext.dataSource.manager) };
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('manufacturing.bom.edit', 'editable')
  @Post(':productId')
  async set(@Req() req: CompanyScopedRequest, @Param('productId', ParseUUIDPipe) productId: string, @Body() dto: SetUnitConversionDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.units.set(productId, dto.unitCode, dto.factor, req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('manufacturing.bom.edit', 'editable')
  @Delete(':productId/:unitCode')
  async remove(@Req() req: CompanyScopedRequest, @Param('productId', ParseUUIDPipe) productId: string, @Param('unitCode') unitCode: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    await this.units.remove(productId, unitCode, req.companyContext.dataSource.manager);
    return { ok: true };
  }
}
