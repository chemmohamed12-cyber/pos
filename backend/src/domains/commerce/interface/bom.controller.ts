import { Body, Controller, Delete, Get, NotFoundException, Param, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ArrayMinSize, IsArray, IsInt, IsString, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { BomService } from '../application/bom.service';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';

class BomComponentDto {
  @IsString()
  componentProductId!: string;

  @IsInt()
  @Min(1)
  quantityPerUnit!: number;
}

class DefineBomDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => BomComponentDto)
  components!: BomComponentDto[];
}

/**
 * Commerce / Bill of Materials — Gap G-2. Reads broadly available
 * (a warehouse worker needs to see a recipe to run an assembly); writes
 * admin-only — defining what a product is physically built from is an
 * engineering/production fact, not a day-to-day operational action
 * (distinct from Price Lists' admin+sales_manager tier, which is a
 * commercial-policy decision — this is a technical one).
 */
/**
 * Area 21 Operational Company Scoping Retrofit (2026-09-28, CTO-authorized,
 * controller #15). `CompanyContextGuard` added at the class level — every
 * route threads `req.companyContext.dataSource.manager` into `BomService`.
 */
@Controller('bom')
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard)
@RequireModule('sales')
export class BomController {
  constructor(private readonly bom: BomService) {}

  @Get()
  async list(@Req() req: CompanyScopedRequest) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.bom.listBoms(req.companyContext.dataSource.manager);
  }

  @Get(':productId')
  async get(@Req() req: CompanyScopedRequest, @Param('productId') productId: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    const bom = await this.bom.getBom(productId, req.companyContext.dataSource.manager);
    if (!bom) throw new NotFoundException(`No Bill of Materials defined for product "${productId}".`);
    return bom;
  }

  /**
   * P4 Tranche-2 ("remaining 9 domains" pass, 2026-09-06) — no dedicated
   * BOM node exists in `sales.manifest.ts`; reuses `sales.catalog.edit`
   * (a BOM is a per-product technical fact, same tier as Product's own
   * writes below). Safe: `sales.catalog.edit` is used ONLY by admin-only
   * routes across this entire Blueprint pass (this file's 2 sites +
   * `products.controller.ts`'s 4 — no sales_manager route ever touches
   * it), so reusing it here introduces no over-grant.
   */
  @UseGuards(PermissionGuard)
  @RequirePermission('sales.catalog.edit', 'editable')
  @Post(':productId')
  async define(@Req() req: CompanyScopedRequest, @Param('productId') productId: string, @Body() dto: DefineBomDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.bom.defineBom(productId, dto.components, req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('sales.catalog.edit', 'editable')
  @Delete(':productId')
  async remove(@Req() req: CompanyScopedRequest, @Param('productId') productId: string) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    await this.bom.deleteBom(productId, req.user.id, req.companyContext.dataSource.manager);
    return { removed: true };
  }
}
