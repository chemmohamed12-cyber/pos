import { BadRequestException, Controller, Get, NotFoundException, ParseUUIDPipe, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { InventoryValuationService } from '../application/inventory-valuation.service';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';
import { AccessScopeService } from '../../../foundation/scope/access-scope.service';
import { WarehouseScopeFiltered } from '../../../foundation/scope/warehouse-scope.decorator';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
  constructor(
    private readonly valuation: InventoryValuationService,
    private readonly scopes: AccessScopeService,
  ) {}

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

  /**
   * Slice C1 (ADR-INV-08) - READ-ONLY valuation report: the valued position per warehouse and item, now or AS OF a date, or per warehouse (`groupBy=warehouse`).
   * Names are not joined here (this module imports nothing from inventory-warehouse): rows carry ids and the screen resolves them like every other inventory
   * screen. Warehouse scope (F6): rows of warehouses the caller cannot see are never returned, and naming an invisible warehouse answers 404.
   * Never writes anything; a past date is rebuilt from the dated history and flagged when that history does not add up to the running state.
   */
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.valuation.view', 'read-only')
  @WarehouseScopeFiltered("valuation of the caller's visible warehouses only")
  @Get('report')
  async report(
    @Req() req: CompanyScopedRequest,
    @Query('warehouseId') warehouseId?: string,
    @Query('productId') productId?: string,
    @Query('asOf') asOf?: string,
    @Query('groupBy') groupBy?: string,
  ) {
    if (!req.companyContext) throw new UnauthorizedException();
    if (warehouseId !== undefined && !UUID_RE.test(warehouseId)) throw new BadRequestException('warehouseId must be a UUID.');
    if (productId !== undefined && !UUID_RE.test(productId)) throw new BadRequestException('productId must be a UUID.');
    if (asOf !== undefined && !DATE_RE.test(asOf)) throw new BadRequestException('asOf must be a date (YYYY-MM-DD).');
    if (groupBy !== undefined && groupBy !== 'warehouse' && groupBy !== 'item') throw new BadRequestException('groupBy must be "warehouse" or "item".');
    const manager = req.companyContext.dataSource.manager;
    const scope = await this.scopes.forRequest(req);
    const visible = await this.scopes.visibleWarehouseIds(scope, manager);
    if (warehouseId && visible !== 'ALL' && !visible.includes(warehouseId)) throw new NotFoundException();
    const warehouseIds = warehouseId ? [warehouseId] : visible === 'ALL' ? undefined : visible;
    const today = new Date().toISOString().slice(0, 10);
    const basis: 'current' | 'as_of' = asOf && asOf < today ? 'as_of' : 'current';
    const positions = await this.valuation.getValuedPositions(asOf, { warehouseIds, productId }, manager);
    let historyInconsistencies: number | null = null;
    if (basis === 'as_of') historyInconsistencies = (await this.valuation.checkHistoryConsistency(manager)).length;
    const mode = groupBy ?? 'item';
    let rows: Array<{ warehouseId: string; productId: string | null; quantity: number; totalValueBase: string; averageCostBase: string | null }>;
    if (mode === 'warehouse') {
      const byWarehouse = new Map<string, { quantity: number; scaled: number }>();
      for (const p of positions) {
        const cur = byWarehouse.get(p.warehouseId) ?? { quantity: 0, scaled: 0 };
        cur.quantity += p.quantity;
        cur.scaled += Math.round(Number(p.totalValueBase) * 10000);
        byWarehouse.set(p.warehouseId, cur);
      }
      rows = [...byWarehouse.entries()].map(([wh, v]) => ({ warehouseId: wh, productId: null, quantity: v.quantity, totalValueBase: this.fmt(v.scaled), averageCostBase: null }));
    } else {
      rows = positions.map((p) => ({ warehouseId: p.warehouseId, productId: p.productId, quantity: p.quantity, totalValueBase: p.totalValueBase, averageCostBase: p.averageCostBase }));
    }
    const totalScaled = positions.reduce((s, p) => s + Math.round(Number(p.totalValueBase) * 10000), 0);
    return {
      asOf: asOf ?? today,
      basis,
      groupBy: mode,
      rows,
      totals: { quantity: positions.reduce((s, p) => s + p.quantity, 0), valueBase: this.fmt(totalScaled) },
      historyInconsistencies,
      note: basis === 'as_of' ? 'Rebuilt from the dated valuation history; movements written before business dates were recorded carry their processing date.' : null,
    };
  }

  /** 4-decimal string from a scaled (x10000) integer. Values are numeric(20,4) money amounts well inside the exact-integer range of a double. */
  private fmt(scaled: number): string {
    const neg = scaled < 0;
    const abs = Math.abs(scaled);
    const whole = Math.floor(abs / 10000);
    const frac = String(abs % 10000).padStart(4, '0');
    return `${neg ? '-' : ''}${whole}.${frac}`;
  }
}
