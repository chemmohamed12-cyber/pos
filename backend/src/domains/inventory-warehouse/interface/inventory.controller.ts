import { Body, Controller, Delete, Get, Inject, Param, ParseUUIDPipe, Post, Query, Req, Res, UnauthorizedException, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Response } from 'express';
import type { EntityManager } from 'typeorm';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsNumberString, IsOptional, IsString, IsUUID, Min } from 'class-validator';
import { InventoryService } from '../application/inventory.service';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';
import { MovementType } from '../domain/movement-type';
import { WarehouseStatus } from '../domain/warehouse-status';
import { ExcelService, ColumnSpec } from '../../../foundation/excel/excel.service';
import { SALES_PRODUCTS_CONTRACT, SalesProductsContract } from '../../../foundation/module-registry/contracts/sales.contract';

const MOVEMENTS_EXPORT_COLUMNS: ColumnSpec[] = [
  { key: 'occurredAt', header: 'Date', width: 20 },
  { key: 'warehouse', header: 'Warehouse', width: 20 },
  { key: 'sku', header: 'Product Code', width: 20 },
  { key: 'productName', header: 'Product Name', width: 26 },
  { key: 'movementType', header: 'Movement Type', width: 20 },
  { key: 'quantity', header: 'Quantity', width: 12 },
];

const STOCK_REPORT_EXPORT_COLUMNS: ColumnSpec[] = [
  { key: 'warehouse', header: 'Warehouse', width: 20 },
  { key: 'sku', header: 'Product Code', width: 20 },
  { key: 'productName', header: 'Product Name', width: 26 },
  { key: 'onHand', header: 'On Hand', width: 12 },
  { key: 'reserved', header: 'Reserved', width: 12 },
  { key: 'available', header: 'Available', width: 12 },
];

const WAREHOUSE_IMPORT_COLUMNS: ColumnSpec[] = [
  { key: 'code', header: 'Warehouse Code', width: 18, example: 'WH-01' },
  { key: 'name', header: 'Warehouse Name', width: 30, example: 'Main Warehouse' },
];
const WAREHOUSE_EXPORT_COLUMNS: ColumnSpec[] = [
  { key: 'code', header: 'Warehouse Code', width: 18 },
  { key: 'name', header: 'Warehouse Name', width: 30 },
];
const OPENING_STOCK_IMPORT_COLUMNS: ColumnSpec[] = [
  { key: 'warehouseCode', header: 'Warehouse Code', width: 18, example: 'WH-01' },
  { key: 'productSku', header: 'Product SKU', width: 20, example: 'SKU-0001' },
  { key: 'quantity', header: 'Quantity', width: 14, example: 100 },
  // F-1 fix (CTO directive, 2026-09-12) — required, so this import's quantity is never invisible to
  // F08's Moving Average valuation. No default/fallback anywhere in the chain that consumes this.
  { key: 'unitCost', header: 'Unit Cost', width: 14, example: 10 },
];

class CreateWarehouseDto {
  @IsString()
  code!: string;

  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsString()
  responsibleUserId?: string;
}

class SetWarehouseStatusDto {
  @IsIn(['active', 'inactive'])
  status!: WarehouseStatus;
}

class RecordMovementDto {
  @IsString()
  warehouseId!: string;

  @IsString()
  productId!: string;

  @IsInt()
  quantity!: number;

  @IsIn(['receipt', 'dispatch', 'adjustment', 'transfer_in', 'transfer_out', 'return'])
  movementType!: MovementType;

  /**
   * F08 (ADR-041 D3/D7/D20/D18c) — the ONE approved opening-stock/receipt cost-input field.
   * Optional; applied only when `movementType === 'receipt'` and F08 is bound — ignored otherwise.
   */
  @IsOptional()
  @IsNumberString()
  unitCostBase?: string;

  /** D3-B — controlled reason code (a key of `accounting.inventory_manual_receipt_reason_accounts`); required for `receipt`. */
  @IsOptional()
  @IsString()
  reasonCode?: string;
}

class AssignItemsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  productIds!: string[];
}

class AssembleProductDto {
  @IsString()
  warehouseId!: string;

  @IsString()
  finishedProductId!: string;

  @IsInt()
  @Min(1)
  quantity!: number;
}

class ReserveStockDto {
  @IsString()
  warehouseId!: string;

  @IsString()
  productId!: string;

  @IsInt()
  @Min(1)
  quantity!: number;

  @IsString()
  salesOrderId!: string;
}

/**
 * Area 21 Operational Company Scoping Retrofit (2026-09-27, CTO-authorized).
 * `CompanyContextGuard` added at the class level — `Warehouse`/
 * `StockMovement`/`StockReservation` are genuinely Company-owned data.
 * Every route threads `req.companyContext.dataSource.manager` into
 * `InventoryService`, which in turn threads it into every nested
 * `AuditService`/`NumberingService`/`EventBusService` call and into the
 * cross-domain `SalesProductsContract`/`SalesBomContract` reads
 * (`ProductsService`/`BomService`) — none of those stop at this
 * controller's own boundary. `SalesBomContract.getBomForAssembly` and
 * `SalesProductsContract.getProductSnapshot`/`getProductSnapshotBySku`
 * gained `manager?` on their published INTERFACES during this pass (the
 * concrete services already had it) — `BillOfMaterial`/`BomComponent`
 * were also newly registered in `commerce-company-entities.ts` as part of
 * making `BomService` manager-capable.
 */
@Controller('inventory')
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard)
@RequireModule('inventory')
export class InventoryController {
  constructor(
    private readonly inventory: InventoryService,
    private readonly excel: ExcelService,
    @Inject(SALES_PRODUCTS_CONTRACT) private readonly products: SalesProductsContract,
  ) {}

  /** Shared by the movements/stock-report export endpoints — resolves warehouse code and product sku/name for readable spreadsheet columns (the JSON endpoints stay raw-id; the frontend already holds these lists for on-screen display, same as the rest of this screen). */
  private async buildNameMaps(manager: EntityManager) {
    const warehouses = await this.inventory.listWarehouses(manager);
    const warehouseNames = new Map(warehouses.map((w) => [w.id, `${w.code} — ${w.name}`]));
    return { warehouseNames };
  }

  private async productLabel(productId: string, manager: EntityManager): Promise<{ sku: string; productName: string }> {
    const product = await this.products.getProductSnapshot(productId, manager);
    return { sku: product?.sku ?? productId, productName: product?.name ?? productId };
  }

  @Get('warehouses')
  async listWarehouses(@Req() req: CompanyScopedRequest) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.inventory.listWarehouses(req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.warehouse.create', 'editable')
  @Post('warehouses')
  async createWarehouse(@Req() req: CompanyScopedRequest, @Body() dto: CreateWarehouseDto) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.inventory.createWarehouse(
      dto.code,
      dto.name,
      dto.location ?? null,
      dto.responsibleUserId ?? null,
      null,
      'main',
      req.companyContext.dataSource.manager,
    );
  }

  /** Warehouse ERP V1 / Phase 1 Integration (CTO directive §3) — active/inactive toggle. */
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.warehouse.edit', 'editable')
  @Post('warehouses/:id/status')
  async setWarehouseStatus(@Req() req: CompanyScopedRequest, @Param('id') id: string, @Body() dto: SetWarehouseStatusDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.inventory.setWarehouseStatus(id, dto.status, req.user.id, req.companyContext.dataSource.manager);
  }

  @Get('warehouses/import-template')
  async warehouseImportTemplate(@Res() res: Response) {
    // Plain (non-passthrough) @Res() bypasses the global ResponseEnvelopeInterceptor,
    // which would otherwise JSON-wrap this binary xlsx buffer — see products.controller.ts.
    const buffer = await this.excel.buildTemplate('Warehouses', WAREHOUSE_IMPORT_COLUMNS);
    res
      .set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="warehouses-import-template.xlsx"',
      })
      .send(buffer);
  }

  // Security Assurance Gate — Track S7 (Resource Exhaustion): unbounded
  // full-dataset query + in-memory XLSX build on every call, only the
  // generic 300/min global throttle applied — narrowed here the same way
  // `AuthController` narrows its own sensitive routes (see
  // `ReportsController.salesOrdersExport`'s own comment for full rationale).
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('warehouses/export')
  async warehouseExport(@Req() req: CompanyScopedRequest, @Res() res: Response) {
    if (!req.companyContext) throw new UnauthorizedException();
    const rows = await this.inventory.listWarehouses(req.companyContext.dataSource.manager);
    const buffer = await this.excel.buildExport('Warehouses', WAREHOUSE_EXPORT_COLUMNS, rows.map((w) => ({ code: w.code, name: w.name })));
    res
      .set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="warehouses-export.xlsx"',
      })
      .send(buffer);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.warehouse.create', 'editable')
  @Post('warehouses/import')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }))
  async warehouseImport(@Req() req: CompanyScopedRequest, @UploadedFile() file: Express.Multer.File) {
    if (!req.companyContext) throw new UnauthorizedException();
    const { rows, headerErrors } = await this.excel.parseWorkbook(file.buffer, WAREHOUSE_IMPORT_COLUMNS);
    if (headerErrors.length > 0) return { totalRows: 0, succeededCount: 0, rejected: [], headerErrors };
    const { succeeded, rejected } = await this.inventory.importWarehouseRows(
      rows as Array<{ code: string; name: string }>,
      req.companyContext.dataSource.manager,
    );
    return { totalRows: rows.length, succeededCount: succeeded.length, rejectedCount: rejected.length, rejected, headerErrors: [] };
  }

  @Get('opening-stock/import-template')
  async openingStockImportTemplate(@Res() res: Response) {
    // Plain (non-passthrough) @Res() bypasses the global ResponseEnvelopeInterceptor,
    // which would otherwise JSON-wrap this binary xlsx buffer — see products.controller.ts.
    const buffer = await this.excel.buildTemplate('Opening Stock', OPENING_STOCK_IMPORT_COLUMNS);
    res
      .set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="opening-stock-import-template.xlsx"',
      })
      .send(buffer);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.movement.create', 'editable')
  @Post('opening-stock/import')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }))
  async openingStockImport(@Req() req: CompanyScopedRequest, @UploadedFile() file: Express.Multer.File) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const { rows, headerErrors } = await this.excel.parseWorkbook(file.buffer, OPENING_STOCK_IMPORT_COLUMNS);
    if (headerErrors.length > 0) return { totalRows: 0, succeededCount: 0, rejected: [], headerErrors };
    const { succeeded, rejected } = await this.inventory.importOpeningStockRows(
      rows as Array<{ warehouseCode: string; productSku: string; quantity: string; unitCost: string }>,
      req.user.id,
      req.companyContext.dataSource.manager,
    );
    return { totalRows: rows.length, succeededCount: succeeded.length, rejectedCount: rejected.length, rejected, headerErrors: [] };
  }

  @Get('stock')
  async getStock(@Req() req: CompanyScopedRequest, @Query('warehouseId') warehouseId: string, @Query('productId') productId: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    const [onHand, reserved, available] = await Promise.all([
      this.inventory.getOnHand(warehouseId, productId, manager),
      this.inventory.getReserved(warehouseId, productId, manager),
      this.inventory.getAvailable(warehouseId, productId, manager),
    ]);
    return { onHand, reserved, available };
  }

  /** D3-B — the reason codes a manual receipt may use (those with a configured offset GL account). */
  @Get('manual-receipt-reasons')
  async manualReceiptReasons(@Req() req: CompanyScopedRequest) {
    if (!req.companyContext) throw new UnauthorizedException();
    return { reasons: this.inventory.listManualReceiptReasons() };
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.movement.create', 'editable')
  @Post('movements')
  async recordMovement(@Req() req: CompanyScopedRequest, @Body() dto: RecordMovementDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    // D3-B — a receipt through this endpoint IS a manual receipt: explicit cost + controlled reason, validated before any write.
    if (dto.movementType === 'receipt') {
      return this.inventory.recordManualReceipt(
        dto.warehouseId,
        dto.productId,
        dto.quantity,
        dto.unitCostBase,
        dto.reasonCode,
        null,
        req.user.id,
        req.companyContext.dataSource.manager,
      );
    }
    return this.inventory.recordMovement(
      dto.warehouseId,
      dto.productId,
      dto.quantity,
      dto.movementType,
      null,
      null,
      req.user.id,
      req.companyContext.dataSource.manager,
      dto.unitCostBase,
    );
  }

  /**
   * Finding F4 (`FINAL_BASELINE_RECONCILIATION_REPORT.md` #32), remediated
   * 2026-09-07 in the Commercial Release Gate: this read had NO permission
   * node at all while its sibling write (`recordMovement`) required
   * `inventory.movement.create` — any authenticated user with the module
   * entitled could read any movement by id. `inventory.movement.view` was
   * already declared in `inventory.manifest.ts`; nothing was wired to it.
   * `ParseUUIDPipe` additionally closes SEC-06 (malformed id → 500) on this
   * route.
   */
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.movement.view', 'read-only')
  @Get('movements/:id')
  async getMovement(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.inventory.getMovement(id, req.companyContext.dataSource.manager);
  }

  /** Warehouse Movements operational report — raw-id JSON; the frontend already holds product/warehouse lists for on-screen name display. */
  @Get('reports/movements')
  async movementsReport(
    @Req() req: CompanyScopedRequest,
    @Query('warehouseId') warehouseId?: string,
    @Query('productId') productId?: string,
    @Query('movementType') movementType?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.inventory.listMovements({ warehouseId, productId, movementType, dateFrom, dateTo }, req.companyContext.dataSource.manager);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } }) // S7 — see warehouseExport's own comment
  @Get('reports/movements/export')
  async movementsReportExport(
    @Req() req: CompanyScopedRequest,
    @Res() res: Response,
    @Query('warehouseId') warehouseId?: string,
    @Query('productId') productId?: string,
    @Query('movementType') movementType?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    if (!req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    const movements = await this.inventory.listMovements({ warehouseId, productId, movementType, dateFrom, dateTo }, manager);
    const { warehouseNames } = await this.buildNameMaps(manager);
    const rows = await Promise.all(
      movements.map(async (m) => {
        const { sku, productName } = await this.productLabel(m.productId, manager);
        return {
          occurredAt: m.createdAt.toISOString(),
          warehouse: warehouseNames.get(m.warehouseId) ?? m.warehouseId,
          sku,
          productName,
          movementType: m.movementType,
          quantity: m.quantity,
        };
      }),
    );
    const buffer = await this.excel.buildExport('Warehouse Movements', MOVEMENTS_EXPORT_COLUMNS, rows);
    res
      .set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="warehouse-movements-report.xlsx"',
      })
      .send(buffer);
  }

  /** Inventory/Stock operational report — raw-id JSON, same rationale as the movements report above. */
  @Get('reports/stock')
  async stockReport(@Req() req: CompanyScopedRequest, @Query('warehouseId') warehouseId?: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.inventory.getStockReport(warehouseId, req.companyContext.dataSource.manager);
  }

  /**
   * Inventory Grid (CTO decision: rebuild Warehouse operational UX on
   * the existing domain) — server-side paginated/searched/sorted, per
   * warehouse. Product name/SKU/status resolved directly against
   * `products` here (never a client-side cross-reference of a full
   * catalog dump), so the grid scales independently of catalog size.
   */
  @Get('warehouses/:warehouseId/inventory')
  async warehouseInventory(
    @Req() req: CompanyScopedRequest,
    @Param('warehouseId') warehouseId: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortDir') sortDir?: 'asc' | 'desc',
    @Query('scope') scope?: string,
  ) {
    if (!req.companyContext) throw new UnauthorizedException();
    const parsedPage = Math.max(1, Number(page) || 1);
    const parsedPageSize = Math.min(200, Math.max(1, Number(pageSize) || 50));
    return this.inventory.getWarehouseInventoryPage(
      warehouseId,
      {
        search,
        page: parsedPage,
        pageSize: parsedPageSize,
        sortBy,
        sortDir,
        scope: scope === 'all' ? 'all' : 'assigned', // D1 — default: the warehouse's assigned items (+ any item still holding stock)
      },
      req.companyContext.dataSource.manager,
    );
  }

  /** D1 — assign items to a warehouse (master data, bulk, idempotent). Advisory: nothing is blocked by assignment yet. */
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.warehouse.edit', 'editable')
  @Post('warehouses/:warehouseId/items')
  async assignItems(@Req() req: CompanyScopedRequest, @Param('warehouseId', ParseUUIDPipe) warehouseId: string, @Body() dto: AssignItemsDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.inventory.assignItems(warehouseId, dto.productIds, req.user.id, req.companyContext.dataSource.manager);
  }

  /** D1 — remove an item from a warehouse; rejected while it still holds stock/reservations there. */
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.warehouse.edit', 'editable')
  @Delete('warehouses/:warehouseId/items/:productId')
  async unassignItem(
    @Req() req: CompanyScopedRequest,
    @Param('warehouseId', ParseUUIDPipe) warehouseId: string,
    @Param('productId', ParseUUIDPipe) productId: string,
  ) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.inventory.unassignItem(warehouseId, productId, req.user.id, req.companyContext.dataSource.manager);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } }) // S7 — see warehouseExport's own comment
  @Get('reports/stock/export')
  async stockReportExport(@Req() req: CompanyScopedRequest, @Res() res: Response, @Query('warehouseId') warehouseId?: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    const stock = await this.inventory.getStockReport(warehouseId, manager);
    const { warehouseNames } = await this.buildNameMaps(manager);
    const rows = await Promise.all(
      stock.map(async (s) => {
        const { sku, productName } = await this.productLabel(s.productId, manager);
        return {
          warehouse: warehouseNames.get(s.warehouseId) ?? s.warehouseId,
          sku,
          productName,
          onHand: s.onHand,
          reserved: s.reserved,
          available: s.available,
        };
      }),
    );
    const buffer = await this.excel.buildExport('Stock Report', STOCK_REPORT_EXPORT_COLUMNS, rows);
    res
      .set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="stock-report.xlsx"',
      })
      .send(buffer);
  }

  /** Gap G-2 — same role tier as `recordMovement`: a production-floor operation. */
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.assembly.create', 'editable')
  @Post('assemble')
  async assemble(@Req() req: CompanyScopedRequest, @Body() dto: AssembleProductDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.inventory.assembleProduct(dto.warehouseId, dto.finishedProductId, dto.quantity, req.user.id, req.companyContext.dataSource.manager);
  }

  @Get('reservations/by-order')
  async reservationsByOrder(@Req() req: CompanyScopedRequest, @Query('salesOrderId') salesOrderId: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.inventory.getActiveReservationsForOrder(salesOrderId, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.reservation.create', 'editable')
  @Post('reservations')
  async reserveStock(@Req() req: CompanyScopedRequest, @Body() dto: ReserveStockDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.inventory.reserveStock(
      dto.warehouseId,
      dto.productId,
      dto.quantity,
      dto.salesOrderId,
      req.user.id,
      'active',
      req.companyContext.dataSource.manager,
    );
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.reservation.release', 'editable')
  @Post('reservations/:id/release')
  async releaseReservation(@Req() req: CompanyScopedRequest, @Param('id') id: string) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    await this.inventory.releaseReservation(id, req.user.id, req.companyContext.dataSource.manager);
    return { released: true };
  }
}
