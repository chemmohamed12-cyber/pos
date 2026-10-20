import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, Res, UnauthorizedException, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Response } from 'express';
import { IsBoolean, IsIn, IsNumberString, IsOptional, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { ProductsService } from '../application/products.service';
import { ProductMasterDataService } from '../application/product-master-data.service';
import { PRODUCT_IMAGE_MAX_BYTES, ProductImageService } from '../application/product-image.service';
import { ITEM_TYPES } from '../domain/item-type';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';
import { ExcelService, ColumnSpec } from '../../../foundation/excel/excel.service';

class CreateProductDto {
  /** Optional (2026-10-20): omitted or blank = the next default serial (`PRD-000001` …); a typed code is used as is if it is free. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  sku?: string;

  @IsString()
  @MinLength(1)
  name!: string;

  @IsNumberString()
  unitPrice!: string;

  @IsOptional()
  @IsString()
  unit?: string;
}

class UpdateUnitDto {
  // empty string clears the unit — same "explicit clear" convention as other optional fields in this codebase.
  @IsString()
  unit!: string;
}

class SetStatusDto {
  @IsIn(['draft', 'active', 'discontinued'])
  status!: 'draft' | 'active' | 'discontinued';
}

class UpdatePriceDto {
  @IsNumberString()
  unitPrice!: string;
}

class UpdateNameDto {
  @IsString()
  @MinLength(1)
  name!: string;
}

/** Master data step 1 — absent = unchanged, `null` = cleared (server-side rules in ProductMasterDataService). */
class UpdateMasterDataDto {
  @IsOptional()
  @IsIn(ITEM_TYPES as unknown as string[])
  itemType?: string;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  categoryId?: string | null;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null && v !== '')
  @IsNumberString()
  reorderLevel?: string | null;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(2000)
  description?: string | null;
}

class AddBarcodeDto {
  @IsString()
  @MaxLength(64)
  barcode!: string;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(64)
  packLabel?: string | null;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}

const IMPORT_COLUMNS: ColumnSpec[] = [
  { key: 'sku', header: 'Product Code', width: 20, example: 'SKU-0001' },
  { key: 'name', header: 'Product Name', width: 30, example: 'Sample Product' },
  { key: 'unitPrice', header: 'Price', width: 14, example: 100 },
  { key: 'status', header: 'Status', width: 16, example: 'draft' },
];

const EXPORT_COLUMNS: ColumnSpec[] = [
  { key: 'sku', header: 'Product Code', width: 20 },
  { key: 'name', header: 'Product Name', width: 30 },
  { key: 'unitPrice', header: 'Price', width: 14 },
  { key: 'status', header: 'Status', width: 16 },
];

/**
 * P4 Tranche-2 ("remaining 9 domains" pass, 2026-09-06) — deliberately NO
 * class-level guard here (unlike every sibling controller in this
 * Blueprint); every route carries its OWN full guard set instead (this
 * predates and is unrelated to the note below).
 *
 * Area 21 Operational Company Scoping Retrofit (2026-09-27, CTO-authorized).
 * `CompanyContextGuard` added to EVERY route below. This is NOT a new
 * authentication requirement — every route already carried `JwtAuthGuard`
 * individually (confirmed by direct read; the class's own older doc
 * comment describing `list()`/`get(:id)` as "currently unauthenticated"
 * was stale — a prior fix, Track S3 2026-09-08, already added
 * `JwtAuthGuard` to both). Adding `CompanyContextGuard` on top of an
 * already-mandatory JWT only adds "and you must have selected a Company"
 * — the correct, minimal consequence of `Product`/`PriceList`/
 * `PriceListItem` becoming genuinely Company-owned data (Area 21,
 * `sales-orders.controller.ts`'s own retrofit already required this).
 */
@Controller('products')
export class ProductsController {
  constructor(
    private readonly products: ProductsService,
    private readonly excel: ExcelService,
    private readonly masterData: ProductMasterDataService,
    private readonly images: ProductImageService,
  ) {}

  /**
   * Security Assurance Gate finding (Track S3 API inventory, 2026-09-08):
   * this route carried NO guard at all — unlike its sibling `/products/all`
   * and `/products/export` (both explicitly `JwtAuthGuard`, per the class's
   * own "reads broadly available" doc comment meaning "to any
   * authenticated user," not the public internet) — exposing the full
   * active price list (SKU, name, unitPrice) to anonymous, unauthenticated
   * access. Closing the inconsistency, not narrowing the read policy: any
   * authenticated user could already see this via `/products/all`.
   */
  @UseGuards(JwtAuthGuard, CompanyContextGuard)
  @Get()
  async list(@Req() req: CompanyScopedRequest) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.products.listActiveProducts(req.companyContext.dataSource.manager);
  }

  @UseGuards(JwtAuthGuard, CompanyContextGuard)
  @Get('all')
  async listAll(@Req() req: CompanyScopedRequest) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.products.listAllProducts(req.companyContext.dataSource.manager);
  }

  @UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard, PermissionGuard)
  @RequireModule('sales')
  @RequirePermission('sales.catalog.create', 'editable')
  @Get('import-template')
  async importTemplate(@Res() res: Response) {
    // Plain (non-passthrough) @Res(): the global ResponseEnvelopeInterceptor
    // wraps every returned value as JSON `{success, data}` — which silently
    // corrupts a binary xlsx buffer into a JSON-serialized object. Sending
    // the response directly bypasses that interceptor entirely, the
    // correct escape hatch for any binary/file download endpoint.
    const buffer = await this.excel.buildTemplate('Products', IMPORT_COLUMNS);
    res
      .set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="products-import-template.xlsx"',
      })
      .send(buffer);
  }

  // Security Assurance Gate — Track S7 (Resource Exhaustion): an unbounded
  // full-catalog query + in-memory XLSX build on every call; the generic
  // 300/min global throttle was sized for normal UI traffic, not repeated
  // heavy export generation — narrowed the same way `AuthController`
  // already narrows its own sensitive routes.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @UseGuards(JwtAuthGuard, CompanyContextGuard)
  @Get('export')
  async export(@Req() req: CompanyScopedRequest, @Res() res: Response) {
    if (!req.companyContext) throw new UnauthorizedException();
    // Product catalog reads are broadly available (same policy as GET /products/all) —
    // no customer/order/scope-restricted data is ever in this export.
    const all = await this.products.listAllProducts(req.companyContext.dataSource.manager);
    const buffer = await this.excel.buildExport(
      'Products',
      EXPORT_COLUMNS,
      all.map((p) => ({ sku: p.sku, name: p.name, unitPrice: p.unitPrice, status: p.status })),
    );
    res
      .set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="products-export.xlsx"',
      })
      .send(buffer);
  }

  @UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard, PermissionGuard)
  @RequireModule('sales')
  @RequirePermission('sales.catalog.create', 'editable')
  @Post('import')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }))
  async import(@Req() req: CompanyScopedRequest, @UploadedFile() file: Express.Multer.File) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const { rows, headerErrors } = await this.excel.parseWorkbook(file.buffer, IMPORT_COLUMNS);
    if (headerErrors.length > 0) {
      return { totalRows: 0, succeededCount: 0, rejected: [], headerErrors };
    }
    const { succeeded, rejected } = await this.products.importRows(
      rows as Array<{ sku: string; name: string; unitPrice: string; status: string }>,
      req.user.id,
      req.companyContext.dataSource.manager,
    );
    return {
      totalRows: rows.length,
      succeededCount: succeeded.length,
      rejectedCount: rejected.length,
      rejected,
      headerErrors: [],
    };
  }

  /** The default item code for the create form — the next serial that is not already taken (a preview; nothing is issued). Same permission as creating an item. Declared before `:id`. */
  @UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard, PermissionGuard)
  @RequireModule('sales')
  @RequirePermission('sales.catalog.create', 'editable')
  @Get('next-code')
  async nextCode(@Req() req: CompanyScopedRequest) {
    if (!req.companyContext) throw new UnauthorizedException();
    return { code: await this.products.peekNextCode(req.companyContext.dataSource.manager) };
  }

  /** Master data step 1 (D-MD11) — resolve a scanned/typed code: exact SKU first, then exact barcode. Same read policy as `/products/all`. Declared before `:id`. */
  @UseGuards(JwtAuthGuard, CompanyContextGuard)
  @Get('lookup')
  async lookup(@Req() req: CompanyScopedRequest, @Query('code') code: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.masterData.lookup(code, req.companyContext.dataSource.manager);
  }

  /** The item's image (any authenticated user of the Company, like the rest of the catalog read); 404 when it has none. */
  @UseGuards(JwtAuthGuard, CompanyContextGuard)
  @Get(':id/image')
  async getImage(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    if (!req.companyContext || !req.user) throw new UnauthorizedException();
    await this.products.getProduct(id, req.companyContext.dataSource.manager); // 404 for an item of another Company
    const image = await this.images.read(req.companyContext.companyId, id);
    if (!image) {
      res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'This item has no image.' } });
      return;
    }
    res.set({ 'Content-Type': image.contentType, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-cache' }).send(image.data);
  }

  @UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard, PermissionGuard)
  @RequireModule('sales')
  @RequirePermission('sales.catalog.edit', 'editable')
  @Post(':id/image')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: PRODUCT_IMAGE_MAX_BYTES } }))
  async setImage(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string, @UploadedFile() file: Express.Multer.File) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    if (!file) throw new BadRequestException('No file uploaded - expected a multipart "file" field with the image.');
    await this.products.getProduct(id, req.companyContext.dataSource.manager);
    return this.images.save(req.companyContext.companyId, id, file.buffer, file.originalname, file.mimetype);
  }

  @UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard, PermissionGuard)
  @RequireModule('sales')
  @RequirePermission('sales.catalog.edit', 'editable')
  @Post(':id/image/remove')
  async removeImage(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    await this.products.getProduct(id, req.companyContext.dataSource.manager);
    await this.images.remove(req.companyContext.companyId, id);
    return { removed: true };
  }

  /** Same finding/fix as `list()` above — was unauthenticated, and unlike `list()` this one didn't even filter to `status: 'active'`, so a draft/discontinued product was also disclosable by guessing its id. */
  @UseGuards(JwtAuthGuard, CompanyContextGuard)
  @Get(':id')
  async get(@Req() req: CompanyScopedRequest, @Param('id') id: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.products.getProduct(id, req.companyContext.dataSource.manager);
  }

  // V1 Release Audit HIGH fix — these four writes were guarded only by
  // JwtAuthGuard (any authenticated user, any role), while the sibling
  // import/import-template routes above correctly require admin.
  // updatePrice in particular sets the platform-wide base price used as
  // the final pricing fallback for every order with no price-list/rep/
  // manager override (sales-orders.service.ts), so this was a real
  // financial-integrity gap, not just an inconsistency. Matches the
  // frontend, which already gates all of this UI to admin (Products.tsx).
  @UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard, PermissionGuard)
  @RequireModule('sales')
  @RequirePermission('sales.catalog.create', 'editable')
  @Post()
  async create(@Req() req: CompanyScopedRequest, @Body() dto: CreateProductDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.products.createProduct(dto.sku ?? null, dto.name, dto.unitPrice, req.user.id, dto.unit ?? null, req.companyContext.dataSource.manager);
  }

  @UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard, PermissionGuard)
  @RequireModule('sales')
  @RequirePermission('sales.catalog.edit', 'editable')
  @Post(':id/unit')
  async updateUnit(@Req() req: CompanyScopedRequest, @Param('id') id: string, @Body() dto: UpdateUnitDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.products.updateUnit(id, dto.unit || null, req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard, PermissionGuard)
  @RequireModule('sales')
  @RequirePermission('sales.catalog.edit', 'editable')
  @Post(':id/status')
  async setStatus(@Req() req: CompanyScopedRequest, @Param('id') id: string, @Body() dto: SetStatusDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.products.setStatus(id, dto.status, req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard, PermissionGuard)
  @RequireModule('sales')
  @RequirePermission('sales.catalog.edit', 'editable')
  @Post(':id/price')
  async updatePrice(@Req() req: CompanyScopedRequest, @Param('id') id: string, @Body() dto: UpdatePriceDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.products.updatePrice(id, dto.unitPrice, req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard, PermissionGuard)
  @RequireModule('sales')
  @RequirePermission('sales.catalog.edit', 'editable')
  @Post(':id/name')
  async updateName(@Req() req: CompanyScopedRequest, @Param('id') id: string, @Body() dto: UpdateNameDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.products.updateName(id, dto.name, req.user.id, req.companyContext.dataSource.manager);
  }

  /** Master data step 1 — item type, category, reorder level, description (the existing name/unit/price/status routes are unchanged). */
  @UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard, PermissionGuard)
  @RequireModule('sales')
  @RequirePermission('sales.catalog.edit', 'editable')
  @Post(':id/update')
  async updateMasterData(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateMasterDataDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.masterData.updateMasterData(id, dto, req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(JwtAuthGuard, CompanyContextGuard)
  @Get(':id/barcodes')
  async listBarcodes(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.masterData.listBarcodes(id, req.companyContext.dataSource.manager);
  }

  @UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard, PermissionGuard)
  @RequireModule('sales')
  @RequirePermission('sales.catalog.edit', 'editable')
  @Post(':id/barcodes')
  async addBarcode(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddBarcodeDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.masterData.addBarcode(id, dto, req.user.id, req.companyContext.dataSource.manager);
  }

  /** POST, not DELETE — same convention as `/procurement/suppliers/:id/update`. */
  @UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard, PermissionGuard)
  @RequireModule('sales')
  @RequirePermission('sales.catalog.edit', 'editable')
  @Post(':id/barcodes/:barcodeId/remove')
  async removeBarcode(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string, @Param('barcodeId', ParseUUIDPipe) barcodeId: string) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.masterData.removeBarcode(id, barcodeId, req.user.id, req.companyContext.dataSource.manager);
  }
}
