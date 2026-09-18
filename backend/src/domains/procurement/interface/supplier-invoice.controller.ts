import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { IsArray, IsNumberString, IsOptional, IsString, IsUUID, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { SupplierInvoiceService } from '../application/supplier-invoice.service';
import { JwtAuthGuard, AuthenticatedRequest } from '../../../foundation/authentication/jwt-auth.guard';
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
}

class VoidInvoiceDto {
  @IsString()
  @MaxLength(255)
  reason!: string;
}

@Controller('procurement/supplier-invoices')
@UseGuards(JwtAuthGuard, RequireModuleGuard)
@RequireModule('procurement')
export class SupplierInvoiceController {
  constructor(private readonly invoices: SupplierInvoiceService) {}

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier_invoice.view', 'read-only')
  @Get()
  async listAll() {
    return this.invoices.listAll();
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier_invoice.view', 'read-only')
  @Get('ap-aging')
  async apAgingAll() {
    return this.invoices.getApAgingForAllSuppliers();
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier_invoice.view', 'read-only')
  @Get('by-purchase-order/:purchaseOrderId')
  async listForPurchaseOrder(@Param('purchaseOrderId', ParseUUIDPipe) purchaseOrderId: string) {
    return this.invoices.listForPurchaseOrder(purchaseOrderId);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier_invoice.view', 'read-only')
  @Get('by-supplier/:supplierId')
  async listForSupplier(@Param('supplierId', ParseUUIDPipe) supplierId: string) {
    return this.invoices.listForSupplier(supplierId);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier_invoice.view', 'read-only')
  @Get('by-supplier/:supplierId/ap-aging')
  async apAgingForSupplier(@Param('supplierId', ParseUUIDPipe) supplierId: string) {
    return this.invoices.getApAging(supplierId);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier_invoice.view', 'read-only')
  @Get(':id')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    return this.invoices.getInvoice(id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier_invoice.create', 'editable')
  @Post()
  async create(@Body() dto: CreateSupplierInvoiceDto, @Req() req: AuthenticatedRequest) {
    return this.invoices.createDraftInvoice(dto, req.user.id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier_invoice.post', 'editable')
  @Post(':id/post')
  async post(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    return this.invoices.postInvoice(id, req.user.id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier_invoice.void', 'editable')
  @Post(':id/void')
  async void(@Param('id', ParseUUIDPipe) id: string, @Body() dto: VoidInvoiceDto, @Req() req: AuthenticatedRequest) {
    return this.invoices.voidInvoice(id, dto.reason, req.user.id);
  }
}
