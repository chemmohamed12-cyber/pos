import { Body, Controller, Get, Param, Post, Req, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Response } from 'express';
import { IsIn, IsNumberString, IsOptional, IsString, MinLength } from 'class-validator';
import { ProductsService } from '../application/products.service';
import { JwtAuthGuard, AuthenticatedRequest } from '../../../foundation/authentication/jwt-auth.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';
import { ExcelService, ColumnSpec } from '../../../foundation/excel/excel.service';

class CreateProductDto {
  @IsString()
  @MinLength(1)
  sku!: string;

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
 * Blueprint). `list()`/`get(:id)` are genuinely, currently unauthenticated
 * (no `@UseGuards` at all — confirmed by direct read before any edit);
 * adding a class-level `JwtAuthGuard`/`RequireModuleGuard` would newly
 * require authentication on those 2 routes — a real functional behavior
 * change, explicitly out of scope for this Blueprint. Every gated route
 * below carries its OWN full guard set instead.
 */
@Controller('products')
export class ProductsController {
  constructor(
    private readonly products: ProductsService,
    private readonly excel: ExcelService,
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
  @UseGuards(JwtAuthGuard)
  @Get()
  async list() {
    return this.products.listActiveProducts();
  }

  @UseGuards(JwtAuthGuard)
  @Get('all')
  async listAll() {
    return this.products.listAllProducts();
  }

  @UseGuards(JwtAuthGuard, RequireModuleGuard, PermissionGuard)
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
  @UseGuards(JwtAuthGuard)
  @Get('export')
  async export(@Res() res: Response) {
    // Product catalog reads are broadly available (same policy as GET /products/all) —
    // no customer/order/scope-restricted data is ever in this export.
    const all = await this.products.listAllProducts();
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

  @UseGuards(JwtAuthGuard, RequireModuleGuard, PermissionGuard)
  @RequireModule('sales')
  @RequirePermission('sales.catalog.create', 'editable')
  @Post('import')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }))
  async import(@Req() req: AuthenticatedRequest, @UploadedFile() file: Express.Multer.File) {
    const { rows, headerErrors } = await this.excel.parseWorkbook(file.buffer, IMPORT_COLUMNS);
    if (headerErrors.length > 0) {
      return { totalRows: 0, succeededCount: 0, rejected: [], headerErrors };
    }
    const { succeeded, rejected } = await this.products.importRows(
      rows as Array<{ sku: string; name: string; unitPrice: string; status: string }>,
      req.user.id,
    );
    return {
      totalRows: rows.length,
      succeededCount: succeeded.length,
      rejectedCount: rejected.length,
      rejected,
      headerErrors: [],
    };
  }

  /** Same finding/fix as `list()` above — was unauthenticated, and unlike `list()` this one didn't even filter to `status: 'active'`, so a draft/discontinued product was also disclosable by guessing its id. */
  @UseGuards(JwtAuthGuard)
  @Get(':id')
  async get(@Param('id') id: string) {
    return this.products.getProduct(id);
  }

  // V1 Release Audit HIGH fix — these four writes were guarded only by
  // JwtAuthGuard (any authenticated user, any role), while the sibling
  // import/import-template routes above correctly require admin.
  // updatePrice in particular sets the platform-wide base price used as
  // the final pricing fallback for every order with no price-list/rep/
  // manager override (sales-orders.service.ts), so this was a real
  // financial-integrity gap, not just an inconsistency. Matches the
  // frontend, which already gates all of this UI to admin (Products.tsx).
  @UseGuards(JwtAuthGuard, RequireModuleGuard, PermissionGuard)
  @RequireModule('sales')
  @RequirePermission('sales.catalog.create', 'editable')
  @Post()
  async create(@Req() req: AuthenticatedRequest, @Body() dto: CreateProductDto) {
    return this.products.createProduct(dto.sku, dto.name, dto.unitPrice, req.user.id, dto.unit ?? null);
  }

  @UseGuards(JwtAuthGuard, RequireModuleGuard, PermissionGuard)
  @RequireModule('sales')
  @RequirePermission('sales.catalog.edit', 'editable')
  @Post(':id/unit')
  async updateUnit(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: UpdateUnitDto) {
    return this.products.updateUnit(id, dto.unit || null, req.user.id);
  }

  @UseGuards(JwtAuthGuard, RequireModuleGuard, PermissionGuard)
  @RequireModule('sales')
  @RequirePermission('sales.catalog.edit', 'editable')
  @Post(':id/status')
  async setStatus(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: SetStatusDto) {
    return this.products.setStatus(id, dto.status, req.user.id);
  }

  @UseGuards(JwtAuthGuard, RequireModuleGuard, PermissionGuard)
  @RequireModule('sales')
  @RequirePermission('sales.catalog.edit', 'editable')
  @Post(':id/price')
  async updatePrice(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: UpdatePriceDto) {
    return this.products.updatePrice(id, dto.unitPrice, req.user.id);
  }

  @UseGuards(JwtAuthGuard, RequireModuleGuard, PermissionGuard)
  @RequireModule('sales')
  @RequirePermission('sales.catalog.edit', 'editable')
  @Post(':id/name')
  async updateName(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: UpdateNameDto) {
    return this.products.updateName(id, dto.name, req.user.id);
  }
}
