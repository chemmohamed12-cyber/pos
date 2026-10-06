import { Controller, Get, NotFoundException, ParseUUIDPipe, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { InventoryValuationService } from '../application/inventory-valuation.service';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';

/**
 * F08 — Inventory Valuation (ADR-041 D11/D24). Exactly ONE read-only
 * route — a human FA-01 maker referencing the current cost before typing
 * an adjustment amount into F07's EXISTING `physical_count_variance`/
 * `valuation_write_down` flow (Blueprint §8). No write route here at all
 * — F08 submits nothing to FA-01 itself (D11/D21).
 *
 * Area 21 Operational Company Scoping Retrofit (2026-09-27, CTO-authorized).
 * `CompanyContextGuard` added — `InventoryValuationService.getUnitCost`
 * was already fully `manager?`-capable before this pass (confirmed while
 * retrofitting `inventory.controller.ts`'s `assembleProduct`, which
 * already threads a manager into it), so this controller needed only the
 * guard + one call-site update, no service-layer work at all.
 */
@Controller('inventory/valuation')
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard)
@RequireModule('inventory')
export class InventoryValuationController {
  constructor(private readonly valuation: InventoryValuationService) {}

  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.valuation.view', 'read-only')
  @Get('current-cost')
  async currentCost(
    @Req() req: CompanyScopedRequest,
    @Query('productId', ParseUUIDPipe) productId: string,
    @Query('warehouseId', ParseUUIDPipe) warehouseId: string,
  ) {
    if (!req.companyContext) throw new UnauthorizedException();
    const result = await this.valuation.getUnitCost(productId, warehouseId, undefined, req.companyContext.dataSource.manager);
    if (!result) throw new NotFoundException('no_valuation_source');
    return result;
  }
}
