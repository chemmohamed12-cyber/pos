import { Body, Controller, Get, Param, Post, Query, Req, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Response } from 'express';
import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { InventoryService } from '../application/inventory.service';
import { JwtAuthGuard, AuthenticatedRequest } from '../../../foundation/authentication/jwt-auth.guard';
import { RolesGuard } from '../../../foundation/authorization/roles.guard';
import { RequireRole } from '../../../foundation/authorization/require-role.decorator';
import { MovementType } from '../domain/movement-type';
import { WarehouseStatus } from '../domain/warehouse-status';
import { ExcelService, ColumnSpec } from '../../../foundation/excel/excel.service';
import { ProductsService } from '../../commerce/application/products.service';

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

@Controller('inventory')
@UseGuards(JwtAuthGuard, RolesGuard)
export class InventoryController {
  constructor(
    private readonly inventory: InventoryService,
    private readonly excel: ExcelService,
    private readonly products: ProductsService,
  ) {}

  /** Shared by the movements/stock-report export endpoints — resolves warehouse code and product sku/name for readable spreadsheet columns (the JSON endpoints stay raw-id; the frontend already holds these lists for on-screen display, same as the rest of this screen). */
  private async buildNameMaps() {
    const warehouses = await this.inventory.listWarehouses();
    const warehouseNames = new Map(warehouses.map((w) => [w.id, `${w.code} — ${w.name}`]));
    return { warehouseNames };
  }

  private async productLabel(productId: string): Promise<{ sku: string; productName: string }> {
    const product = await this.products.getProductSnapshot(productId);
    return { sku: product?.sku ?? productId, productName: product?.name ?? productId };
  }

  @Get('warehouses')
  async listWarehouses() {
    return this.inventory.listWarehouses();
  }

  @RequireRole('admin')
  @Post('warehouses')
  async createWarehouse(@Body() dto: CreateWarehouseDto) {
    return this.inventory.createWarehouse(dto.code, dto.name, dto.location ?? null, dto.responsibleUserId ?? null);
  }

  /** Warehouse ERP V1 / Phase 1 Integration (CTO directive §3) — active/inactive toggle. */
  @RequireRole('admin')
  @Post('warehouses/:id/status')
  async setWarehouseStatus(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: SetWarehouseStatusDto) {
    return this.inventory.setWarehouseStatus(id, dto.status, req.user.id);
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

  @Get('warehouses/export')
  async warehouseExport(@Res() res: Response) {
    const rows = await this.inventory.listWarehouses();
    const buffer = await this.excel.buildExport('Warehouses', WAREHOUSE_EXPORT_COLUMNS, rows.map((w) => ({ code: w.code, name: w.name })));
    res
      .set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="warehouses-export.xlsx"',
      })
      .send(buffer);
  }

  @RequireRole('admin')
  @Post('warehouses/import')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }))
  async warehouseImport(@UploadedFile() file: Express.Multer.File) {
    const { rows, headerErrors } = await this.excel.parseWorkbook(file.buffer, WAREHOUSE_IMPORT_COLUMNS);
    if (headerErrors.length > 0) return { totalRows: 0, succeededCount: 0, rejected: [], headerErrors };
    const { succeeded, rejected } = await this.inventory.importWarehouseRows(rows as Array<{ code: string; name: string }>);
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

  @RequireRole('warehouse_worker', 'admin')
  @Post('opening-stock/import')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }))
  async openingStockImport(@Req() req: AuthenticatedRequest, @UploadedFile() file: Express.Multer.File) {
    const { rows, headerErrors } = await this.excel.parseWorkbook(file.buffer, OPENING_STOCK_IMPORT_COLUMNS);
    if (headerErrors.length > 0) return { totalRows: 0, succeededCount: 0, rejected: [], headerErrors };
    const { succeeded, rejected } = await this.inventory.importOpeningStockRows(
      rows as Array<{ warehouseCode: string; productSku: string; quantity: string }>,
      req.user.id,
    );
    return { totalRows: rows.length, succeededCount: succeeded.length, rejectedCount: rejected.length, rejected, headerErrors: [] };
  }

  @Get('stock')
  async getStock(@Query('warehouseId') warehouseId: string, @Query('productId') productId: string) {
    const [onHand, reserved, available] = await Promise.all([
      this.inventory.getOnHand(warehouseId, productId),
      this.inventory.getReserved(warehouseId, productId),
      this.inventory.getAvailable(warehouseId, productId),
    ]);
    return { onHand, reserved, available };
  }

  @RequireRole('warehouse_worker', 'admin')
  @Post('movements')
  async recordMovement(@Req() req: AuthenticatedRequest, @Body() dto: RecordMovementDto) {
    return this.inventory.recordMovement(
      dto.warehouseId,
      dto.productId,
      dto.quantity,
      dto.movementType,
      null,
      null,
      req.user.id,
    );
  }

  @Get('movements/:id')
  async getMovement(@Param('id') id: string) {
    return this.inventory.getMovement(id);
  }

  /** Warehouse Movements operational report — raw-id JSON; the frontend already holds product/warehouse lists for on-screen name display. */
  @Get('reports/movements')
  async movementsReport(
    @Query('warehouseId') warehouseId?: string,
    @Query('productId') productId?: string,
    @Query('movementType') movementType?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    return this.inventory.listMovements({ warehouseId, productId, movementType, dateFrom, dateTo });
  }

  @Get('reports/movements/export')
  async movementsReportExport(
    @Res() res: Response,
    @Query('warehouseId') warehouseId?: string,
    @Query('productId') productId?: string,
    @Query('movementType') movementType?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    const movements = await this.inventory.listMovements({ warehouseId, productId, movementType, dateFrom, dateTo });
    const { warehouseNames } = await this.buildNameMaps();
    const rows = await Promise.all(
      movements.map(async (m) => {
        const { sku, productName } = await this.productLabel(m.productId);
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
  async stockReport(@Query('warehouseId') warehouseId?: string) {
    return this.inventory.getStockReport(warehouseId);
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
    @Param('warehouseId') warehouseId: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortDir') sortDir?: 'asc' | 'desc',
  ) {
    const parsedPage = Math.max(1, Number(page) || 1);
    const parsedPageSize = Math.min(200, Math.max(1, Number(pageSize) || 50));
    return this.inventory.getWarehouseInventoryPage(warehouseId, {
      search,
      page: parsedPage,
      pageSize: parsedPageSize,
      sortBy,
      sortDir,
    });
  }

  @Get('reports/stock/export')
  async stockReportExport(@Res() res: Response, @Query('warehouseId') warehouseId?: string) {
    const stock = await this.inventory.getStockReport(warehouseId);
    const { warehouseNames } = await this.buildNameMaps();
    const rows = await Promise.all(
      stock.map(async (s) => {
        const { sku, productName } = await this.productLabel(s.productId);
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
  @RequireRole('warehouse_worker', 'admin')
  @Post('assemble')
  async assemble(@Req() req: AuthenticatedRequest, @Body() dto: AssembleProductDto) {
    return this.inventory.assembleProduct(dto.warehouseId, dto.finishedProductId, dto.quantity, req.user.id);
  }

  @Get('reservations/by-order')
  async reservationsByOrder(@Query('salesOrderId') salesOrderId: string) {
    return this.inventory.getActiveReservationsForOrder(salesOrderId);
  }

  @RequireRole('sales_rep', 'admin')
  @Post('reservations')
  async reserveStock(@Req() req: AuthenticatedRequest, @Body() dto: ReserveStockDto) {
    return this.inventory.reserveStock(dto.warehouseId, dto.productId, dto.quantity, dto.salesOrderId, req.user.id);
  }

  @RequireRole('warehouse_worker', 'admin')
  @Post('reservations/:id/release')
  async releaseReservation(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    await this.inventory.releaseReservation(id, req.user.id);
    return { released: true };
  }
}
