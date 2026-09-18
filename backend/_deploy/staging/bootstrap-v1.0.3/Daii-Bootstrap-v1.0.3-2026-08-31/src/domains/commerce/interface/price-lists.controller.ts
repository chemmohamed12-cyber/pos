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
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Response } from 'express';
import { IsIn, IsNumberString, IsString, MinLength, ValidateIf } from 'class-validator';
import { PriceListsService } from '../application/price-lists.service';
import { JwtAuthGuard, AuthenticatedRequest } from '../../../foundation/authentication/jwt-auth.guard';
import { RolesGuard } from '../../../foundation/authorization/roles.guard';
import { RequireRole } from '../../../foundation/authorization/require-role.decorator';
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
@Controller('price-lists')
@UseGuards(JwtAuthGuard)
export class PriceListsController {
  constructor(
    private readonly priceLists: PriceListsService,
    private readonly excel: ExcelService,
  ) {}

  @Get()
  async list() {
    return this.priceLists.listPriceLists();
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
  async resolvePrice(@Query('customerPriceListId') customerPriceListId: string | undefined, @Query('productId') productId: string) {
    return this.priceLists.resolvePrice(customerPriceListId ?? null, productId);
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return this.priceLists.getPriceList(id);
  }

  @Get(':id/items')
  async listItems(@Param('id') id: string) {
    return this.priceLists.listItems(id);
  }

  @UseGuards(RolesGuard)
  @RequireRole('admin', 'sales_manager')
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

  @Get(':id/items/export')
  async exportItems(@Param('id') id: string, @Res() res: Response) {
    const items = await this.priceLists.listItems(id);
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

  @UseGuards(RolesGuard)
  @RequireRole('admin', 'sales_manager')
  @Post(':id/items/import')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }))
  async importItems(@Req() req: AuthenticatedRequest, @Param('id') id: string, @UploadedFile() file: Express.Multer.File) {
    const { rows, headerErrors } = await this.excel.parseWorkbook(file.buffer, IMPORT_COLUMNS);
    if (headerErrors.length > 0) {
      return { totalRows: 0, succeededCount: 0, rejected: [], headerErrors };
    }
    const { succeededCount, rejected } = await this.priceLists.importItemRows(
      id,
      rows as Array<{ sku: string; price: string }>,
      req.user.id,
    );
    return { totalRows: rows.length, succeededCount, rejectedCount: rejected.length, rejected, headerErrors: [] };
  }

  @UseGuards(RolesGuard)
  @RequireRole('admin', 'sales_manager')
  @Post()
  async create(@Req() req: AuthenticatedRequest, @Body() dto: CreatePriceListDto) {
    return this.priceLists.createPriceList(dto.name, req.user.id);
  }

  @UseGuards(RolesGuard)
  @RequireRole('admin', 'sales_manager')
  @Post(':id/status')
  async setStatus(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: SetPriceListStatusDto) {
    return this.priceLists.setStatus(id, dto.status, req.user.id);
  }

  @UseGuards(RolesGuard)
  @RequireRole('admin', 'sales_manager')
  @Post(':id/role')
  async setRole(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: SetPriceListRoleDto) {
    return this.priceLists.setRole(id, dto.role, req.user.id);
  }

  @UseGuards(RolesGuard)
  @RequireRole('admin', 'sales_manager')
  @Post(':id/items')
  async upsertItem(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: UpsertItemDto) {
    return this.priceLists.upsertItem(id, dto.productId, dto.price, req.user.id);
  }

  @UseGuards(RolesGuard)
  @RequireRole('admin', 'sales_manager')
  @Delete(':id/items/:itemId')
  async removeItem(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Param('itemId') itemId: string) {
    await this.priceLists.removeItem(id, itemId, req.user.id);
    return { removed: true };
  }
}
