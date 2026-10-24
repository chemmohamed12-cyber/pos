import { Body, ConflictException, Controller, Delete, Get, NotFoundException, Param, ParseUUIDPipe, Post, Req, UnauthorizedException, UseGuards, Inject } from '@nestjs/common';
import { ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';
import { SALES_BOM_CONTRACT, SalesBomContract } from '../../../foundation/module-registry/contracts/sales.contract';
import { UnitConversionService } from '../application/unit-conversion.service';

class ManufacturingBomComponentDto {
  @IsUUID()
  componentProductId!: string;

  /** Whole base units per finished unit (the original input). Either this, or `quantity` (+ optional `unitCode`) - S2 / D-ME-2. */
  @IsOptional()
  @IsInt()
  @Min(1)
  quantityPerUnit?: number;

  /** A decimal quantity in `unitCode` (default: the component's base unit), converted EXACTLY to whole base units - refused when it is not a whole number of them. */
  @IsOptional()
  @IsString()
  @Matches(/^\d+(\.\d+)?$/)
  quantity?: string;

  @IsOptional()
  @IsString()
  unitCode?: string;
}

class DefineManufacturingBomDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ManufacturingBomComponentDto)
  components!: ManufacturingBomComponentDto[];
}

class SetBomStatusDto {
  @IsIn(['active', 'inactive'])
  status!: 'active' | 'inactive';
}

/**
 * ADR-061 Addendum 1 (A2) — BOM / Recipe management surfaced in the Manufacturing workspace under
 * manufacturing-owned permission nodes (`manufacturing.bom.*`). It is a FACADE over the single
 * commerce `BomService` (via the published `SALES_BOM_CONTRACT`) — one BOM store, one service; the
 * Catalog `/bom` surface remains for backward compatibility. Company-scoped (Area 21 stack).
 */
@Controller('manufacturing/boms')
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard)
@RequireModule('manufacturing')
export class ManufacturingBomController {
  constructor(@Inject(SALES_BOM_CONTRACT) private readonly bom: SalesBomContract, private readonly units: UnitConversionService) {}

  /** S2: turn each line into the integer `quantityPerUnit` the BOM store keeps. A line must give exactly one of `quantityPerUnit` or `quantity`. */
  private async resolveComponents(components: ManufacturingBomComponentDto[], manager: import('typeorm').EntityManager) {
    const out: Array<{ componentProductId: string; quantityPerUnit: number }> = [];
    for (const c of components) {
      if ((c.quantityPerUnit == null) === (c.quantity == null)) throw new ConflictException('Each component needs exactly one of quantityPerUnit or quantity.');
      out.push({ componentProductId: c.componentProductId, quantityPerUnit: c.quantityPerUnit ?? (await this.units.toBase(c.componentProductId, c.quantity!, c.unitCode, manager)) });
    }
    return out;
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('manufacturing.bom.view', 'read-only')
  @Get()
  async list(@Req() req: CompanyScopedRequest) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.bom.listBoms(req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('manufacturing.bom.view', 'read-only')
  @Get(':productId')
  async get(@Req() req: CompanyScopedRequest, @Param('productId', ParseUUIDPipe) productId: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    const bom = await this.bom.getBom(productId, req.companyContext.dataSource.manager);
    if (!bom) throw new NotFoundException(`No Bill of Materials defined for product "${productId}".`);
    return bom;
  }

  /** Create a NEW recipe (409 if one already exists — replacing needs `manufacturing.bom.edit`). */
  @UseGuards(PermissionGuard)
  @RequirePermission('manufacturing.bom.create', 'editable')
  @Post(':productId')
  async create(@Req() req: CompanyScopedRequest, @Param('productId', ParseUUIDPipe) productId: string, @Body() dto: DefineManufacturingBomDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    if (await this.bom.getBom(productId, manager)) {
      throw new ConflictException(`Product "${productId}" already has a Bill of Materials — edit it instead.`);
    }
    return this.bom.defineBom(productId, await this.resolveComponents(dto.components, manager), req.user.id, manager);
  }

  /** Replace an existing recipe's components as a whole (BOM edit semantics are create-or-replace). */
  @UseGuards(PermissionGuard)
  @RequirePermission('manufacturing.bom.edit', 'editable')
  @Post(':productId/replace')
  async replace(@Req() req: CompanyScopedRequest, @Param('productId', ParseUUIDPipe) productId: string, @Body() dto: DefineManufacturingBomDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    if (!(await this.bom.getBom(productId, manager))) throw new NotFoundException(`No Bill of Materials defined for product "${productId}".`);
    return this.bom.defineBom(productId, await this.resolveComponents(dto.components, manager), req.user.id, manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('manufacturing.bom.edit', 'editable')
  @Post(':productId/status')
  async setStatus(@Req() req: CompanyScopedRequest, @Param('productId', ParseUUIDPipe) productId: string, @Body() dto: SetBomStatusDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    await this.bom.setBomStatus(productId, dto.status, req.user.id, req.companyContext.dataSource.manager);
    return { ok: true, status: dto.status };
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('manufacturing.bom.delete', 'editable')
  @Delete(':productId')
  async remove(@Req() req: CompanyScopedRequest, @Param('productId', ParseUUIDPipe) productId: string) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    await this.bom.deleteBom(productId, req.user.id, req.companyContext.dataSource.manager);
    return { removed: true };
  }
}
