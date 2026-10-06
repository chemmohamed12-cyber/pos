import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import { InvoiceService } from '../application/invoices.service';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';

class CreateInvoiceDto {
  @IsString()
  salesOrderId!: string;

  /** F10-H3 (ADR-043 D3, Blueprint §0) — optional invoice-level tax code; omitted falls back to `accounting.default_tax_code`. */
  @IsOptional()
  @IsString()
  taxCodeId?: string;
}

class VoidInvoiceDto {
  @IsString()
  reason!: string;
}

@Controller()
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard)
@RequireModule('finance')
export class InvoicesController {
  constructor(private readonly invoices: InvoiceService) {}

  @Post('invoices')
  async create(@Req() req: CompanyScopedRequest, @Body() dto: CreateInvoiceDto) {
    return this.invoices.createDraftInvoice(dto.salesOrderId, req.user.id, dto.taxCodeId ?? null, req.companyContext!.dataSource.manager);
  }

  /** ERP UI Integration (CTO directive) — the "الفواتير" list screen, across every customer the caller may see. Scope-filtered, not role-gated (a rep legitimately sees their own customers' invoices). */
  @Get('invoices')
  async listAll(@Req() req: CompanyScopedRequest) {
    return this.invoices.listAllInvoices(req.user.id, req.companyContext!.dataSource.manager);
  }

  /** ERP UI Integration — Sales Order → Invoice cross-link (§8). Declared BEFORE the ':id' wildcard below so it's never shadowed, same discipline as `by-sales-order` routes elsewhere in this codebase. */
  @Get('invoices/by-sales-order/:salesOrderId')
  async getBySalesOrder(@Req() req: CompanyScopedRequest, @Param('salesOrderId') salesOrderId: string) {
    return this.invoices.getInvoiceForSalesOrder(salesOrderId, req.user.id, req.companyContext!.dataSource.manager);
  }

  /** ERP UI Integration — the "أعمار الديون" list screen, across every customer the caller may see. */
  @Get('ar-aging')
  async arAgingAll(@Req() req: CompanyScopedRequest) {
    return this.invoices.getArAgingForAllCustomers(req.user.id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('finance.invoice.post', 'editable')
  @Post('invoices/:id/post')
  async post(@Req() req: CompanyScopedRequest, @Param('id') id: string) {
    return this.invoices.postInvoice(id, req.user.id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('finance.invoice.cancel', 'editable')
  @Post('invoices/:id/void')
  async void(@Req() req: CompanyScopedRequest, @Param('id') id: string, @Body() dto: VoidInvoiceDto) {
    return this.invoices.voidInvoice(id, dto.reason, req.user.id, req.companyContext!.dataSource.manager);
  }

  @Get('invoices/:id')
  async get(@Req() req: CompanyScopedRequest, @Param('id') id: string) {
    return this.invoices.getInvoice(id, req.user.id, req.companyContext!.dataSource.manager);
  }

  @Get('customers/:id/invoices')
  async listForCustomer(@Req() req: CompanyScopedRequest, @Param('id') id: string) {
    return this.invoices.listInvoicesForCustomer(id, req.user.id, req.companyContext!.dataSource.manager);
  }

  @Get('customers/:id/ar-aging')
  async arAging(@Req() req: CompanyScopedRequest, @Param('id') id: string) {
    return this.invoices.getArAging(id, req.user.id, req.companyContext!.dataSource.manager);
  }
}
