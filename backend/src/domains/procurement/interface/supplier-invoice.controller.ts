import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { IsArray, IsNumberString, IsOptional, IsString, IsUUID, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { SupplierInvoiceService } from '../application/supplier-invoice.service';
import { InvoiceAllocationService } from '../application/invoice-allocation.service';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';

class CreateSupplierInvoiceLineDto {
  @IsUUID()
  purchaseOrderLineId!: string;

  @IsNumberString()
  quantity!: string;

  @IsNumberString()
  unitCostBase!: string;

  /** optional: bill this goods-receipt line first; otherwise receipts are allocated first-in-first-out */
  @IsOptional()
  @IsUUID()
  goodsReceiptLineId?: string;
}

class CreateSupplierInvoiceDto {
  @IsUUID()
  purchaseOrderId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  supplierReference?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateSupplierInvoiceLineDto)
  lines!: CreateSupplierInvoiceLineDto[];

  /** D5 — the explicit VAT amount stated by the supplier's invoice (lines are NET). Omit/0 for a VAT-free invoice. */
  @IsOptional()
  @IsNumberString()
  taxAmount?: string;
}

class VoidInvoiceDto {
  @IsString()
  @MaxLength(255)
  reason!: string;
}

/**
 * Area 21 Operational Company Scoping Retrofit (2026-09-27, CTO-authorized).
 * `CompanyContextGuard` added at the class level — `SupplierInvoice`/
 * `SupplierInvoiceLine`/`SupplierLedgerEntry` are genuinely Company-owned
 * data. `SupplierInvoiceService` has zero cross-domain dependencies
 * (only `SupplierLedgerService`, same `procurement` domain) — the
 * cleanest large-ish retrofit since `inventory-valuation.controller.ts`
 * (see AREA21-RETROFIT-MATRIX.md §27).
 */
@Controller('procurement/supplier-invoices')
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard)
@RequireModule('procurement')
export class SupplierInvoiceController {
  constructor(
    private readonly invoices: SupplierInvoiceService,
    private readonly allocations: InvoiceAllocationService,
  ) {}

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier_invoice.view', 'read-only')
  @Get()
  async listAll(@Req() req: CompanyScopedRequest) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.invoices.listAll(req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier_invoice.view', 'read-only')
  @Get('ap-aging')
  async apAgingAll(@Req() req: CompanyScopedRequest) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.invoices.getApAgingForAllSuppliers(req.companyContext.dataSource.manager);
  }

  /** Read-only consistency check of receipt allocations, PO-line aggregates and payment allocations; an empty list means consistent. */
  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier_invoice.view', 'read-only')
  @Get('reconciliation')
  async reconciliation(@Req() req: CompanyScopedRequest) {
    if (!req.companyContext) throw new UnauthorizedException();
    const issues = await this.allocations.reconcile(req.companyContext.dataSource.manager);
    return { consistent: issues.length === 0, issues };
  }

  /** Per purchase-order line: ordered / received / invoiced / remaining, with the per-goods-receipt breakdown. */
  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier_invoice.view', 'read-only')
  @Get('invoicing-by-purchase-order/:purchaseOrderId')
  async invoicingForPurchaseOrder(@Req() req: CompanyScopedRequest, @Param('purchaseOrderId', ParseUUIDPipe) purchaseOrderId: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.allocations.getPurchaseOrderInvoicing(purchaseOrderId, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier_invoice.view', 'read-only')
  @Get('by-purchase-order/:purchaseOrderId')
  async listForPurchaseOrder(@Req() req: CompanyScopedRequest, @Param('purchaseOrderId', ParseUUIDPipe) purchaseOrderId: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.invoices.listForPurchaseOrder(purchaseOrderId, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier_invoice.view', 'read-only')
  @Get('by-supplier/:supplierId')
  async listForSupplier(@Req() req: CompanyScopedRequest, @Param('supplierId', ParseUUIDPipe) supplierId: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.invoices.listForSupplier(supplierId, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier_invoice.view', 'read-only')
  @Get('by-supplier/:supplierId/ap-aging')
  async apAgingForSupplier(@Req() req: CompanyScopedRequest, @Param('supplierId', ParseUUIDPipe) supplierId: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.invoices.getApAging(supplierId, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier_invoice.view', 'read-only')
  @Get(':id')
  async get(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.invoices.getInvoice(id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier_invoice.create', 'editable')
  @Post()
  async create(@Body() dto: CreateSupplierInvoiceDto, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.invoices.createDraftInvoice(dto, req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier_invoice.post', 'editable')
  @Post(':id/post')
  async post(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.invoices.postInvoice(id, req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier_invoice.void', 'editable')
  @Post(':id/void')
  async void(@Param('id', ParseUUIDPipe) id: string, @Body() dto: VoidInvoiceDto, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.invoices.voidInvoice(id, dto.reason, req.user.id, req.companyContext.dataSource.manager);
  }
}
