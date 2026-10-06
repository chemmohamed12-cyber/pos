import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Response } from 'express';
import { IsIn, IsNumberString, IsString, MinLength, ValidateIf } from 'class-validator';
import { PriceListsService } from '../application/price-lists.service';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';
import { ExcelService, ColumnSpec } from '../../../foundation/excel/excel.service';

class CreatePriceListDto {
  @IsString()
  @MinLength(1)
  name!: string;
}

class SetPriceListStatusDto {
  @IsIn(['active', 'inactive'])
  status!: 'active' | 'inactive';
}

/**
 * Post-v1.0.2 Hotfix 3 — only `'main'` is ever settable through this
 * endpoint ('general' is system-managed, never admin-assignable).
 * `role: null` clears it. `@ValidateIf` (not `@IsOptional`) because this
 * needs to accept an explicit `null` to clear, not just "field omitted".
 */
class SetPriceListRoleDto {
  @ValidateIf((o: SetPriceListRoleDto) => o.role !== null)
  @IsIn(['main'])
  role!: 'main' | null;
}

class UpsertItemDto {
  @IsString()
  productId!: string;

  @IsNumberString()
  price!: string;
}

const IMPORT_COLUMNS: ColumnSpec[] = [
  { key: 'sku', header: 'Product Code', width: 20, example: 'SKU-0001' },
  { key: 'price', header: 'Price', width: 14, example: 100 },
];

const EXPORT_COLUMNS: ColumnSpec[] = [
  { key: 'sku', header: 'Product Code', width: 20 },
  { key: 'productName', header: 'Product Name', width: 30 },
  { key: 'price', header: 'Price', width: 14 },
];

/**
 * Commerce / Price Lists — Gap G-3. Reads broadly available (matches
 * Product's own "Catalog writes admin-gated; reads broadly available"
 * boundary, DAII_DOMAIN_BOUNDARIES.md §1 — a rep needs to see what a
 * price list contains, not just admins). Writes gated to admin/
 * sales_manager: pricing is a commercial-policy decision, same tier as
 * the Sales Order workflow-policy switch (Gap G-1, `customers.controller.ts`).
 */
/**
 * Area 21 Operational Company Scoping Retrofit (2026-09-27, CTO-authorized).
 * `CompanyContextGuard` added at the class level, alongside the existing
 * `JwtAuthGuard`/`RequireModuleGuard` — every route here already required
 * both, so this only adds "and you must have selected a Company," the
 * correct consequence of `PriceList`/`PriceListItem` becoming genuinely
 * Company-owned data (established by `sales-orders.controller.ts`'s own
 * retrofit). See `price-lists.service.ts`'s `onModuleInit` for one
 * documented, NOT-yet-fixed gap this pass does not close (an
 * `EventBusService` limitation, not specific to this controller).
 */
@Controller('price-lists')
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard)
@RequireModule('sales')
export class PriceListsController {
  constructor(
    private readonly priceLists: PriceListsService,
    private readonly excel: ExcelService,
  ) {}

  @Get()
  async list(@Req() req: CompanyScopedRequest) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.priceLists.listPriceLists(req.companyContext.dataSource.manager);
  }

  /**
   * Post-v1.0.2 Hotfix 3 — lets the Sales Order creation screen preview
   * the SAME Customer -> Main -> General chain the server authoritatively
   * applies at order-creation time, instead of only ever previewing the
   * customer-list tier. Read-only; never used to set a price. Registered
   * BEFORE `:id` below — a fixed literal segment must never be shadowed
   * by an earlier param route matching it as an id.
   */
  @Get('resolve-price')
  async resolvePrice(@Req() req: CompanyScopedRequest, @Query('customerPriceListId') customerPriceListId: string | undefined, @Query('productId') productId: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.priceLists.resolvePrice(customerPriceListId ?? null, productId, req.companyContext.dataSource.manager);
  }

  @Get(':id')
  async get(@Req() req: CompanyScopedRequest, @Param('id') id: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.priceLists.getPriceList(id, req.companyContext.dataSource.manager);
  }

  @Get(':id/items')
  async listItems(@Req() req: CompanyScopedRequest, @Param('id') id: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.priceLists.listItems(id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('sales.price_list.edit', 'editable')
  @Get(':id/items/import-template')
  async importTemplate(@Res() res: Response) {
    const buffer = await this.excel.buildTemplate('Price List Items', IMPORT_COLUMNS);
    res
      .set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="price-list-items-import-template.xlsx"',
      })
      .send(buffer);
  }

  // Security Assurance Gate — Track S7 (Resource Exhaustion): unbounded
  // full-dataset query + in-memory XLSX build on every call, only the
  // generic 300/min global throttle applied — narrowed here the same way
  // `AuthController` narrows its own sensitive routes (see
  // `ReportsController.salesOrdersExport`'s own comment for full rationale).
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get(':id/items/export')
  async exportItems(@Req() req: CompanyScopedRequest, @Param('id') id: string, @Res() res: Response) {
    if (!req.companyContext) throw new UnauthorizedException();
    const items = await this.priceLists.listItems(id, req.companyContext.dataSource.manager);
    const buffer = await this.excel.buildExport(
      'Price List Items',
      EXPORT_COLUMNS,
      items.map((i) => ({ sku: i.sku, productName: i.productName, price: i.price })),
    );
    res
      .set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="price-list-items-export.xlsx"',
      })
      .send(buffer);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('sales.price_list.edit', 'editable')
  @Post(':id/items/import')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }))
  async importItems(@Req() req: CompanyScopedRequest, @Param('id') id: string, @UploadedFile() file: Express.Multer.File) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const { rows, headerErrors } = await this.excel.parseWorkbook(file.buffer, IMPORT_COLUMNS);
    if (headerErrors.length > 0) {
      return { totalRows: 0, succeededCount: 0, rejected: [], headerErrors };
    }
    const { succeededCount, rejected } = await this.priceLists.importItemRows(
      id,
      rows as Array<{ sku: string; price: string }>,
      req.user.id,
      req.companyContext.dataSource.manager,
    );
    return { totalRows: rows.length, succeededCount, rejectedCount: rejected.length, rejected, headerErrors: [] };
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('sales.price_list.edit', 'editable')
  @Post()
  async create(@Req() req: CompanyScopedRequest, @Body() dto: CreatePriceListDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.priceLists.createPriceList(dto.name, req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('sales.price_list.edit', 'editable')
  @Post(':id/status')
  async setStatus(@Req() req: CompanyScopedRequest, @Param('id') id: string, @Body() dto: SetPriceListStatusDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.priceLists.setStatus(id, dto.status, req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('sales.price_list.edit', 'editable')
  @Post(':id/role')
  async setRole(@Req() req: CompanyScopedRequest, @Param('id') id: string, @Body() dto: SetPriceListRoleDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.priceLists.setRole(id, dto.role, req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('sales.price_list.edit', 'editable')
  @Post(':id/items')
  async upsertItem(@Req() req: CompanyScopedRequest, @Param('id') id: string, @Body() dto: UpsertItemDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.priceLists.upsertItem(id, dto.productId, dto.price, req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('sales.price_list.edit', 'editable')
  @Delete(':id/items/:itemId')
  async removeItem(@Req() req: CompanyScopedRequest, @Param('id') id: string, @Param('itemId') itemId: string) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    await this.priceLists.removeItem(id, itemId, req.user.id, req.companyContext.dataSource.manager);
    return { removed: true };
  }
}
