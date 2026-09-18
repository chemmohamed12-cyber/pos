import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { IsString } from 'class-validator';
import { InvoiceService } from '../application/invoices.service';
import { JwtAuthGuard, AuthenticatedRequest } from '../../../foundation/authentication/jwt-auth.guard';
import { RolesGuard } from '../../../foundation/authorization/roles.guard';
import { RequireRole } from '../../../foundation/authorization/require-role.decorator';

class CreateInvoiceDto {
  @IsString()
  salesOrderId!: string;
}

class VoidInvoiceDto {
  @IsString()
  reason!: string;
}

@Controller()
@UseGuards(JwtAuthGuard)
export class InvoicesController {
  constructor(private readonly invoices: InvoiceService) {}

  @Post('invoices')
  async create(@Req() req: AuthenticatedRequest, @Body() dto: CreateInvoiceDto) {
    return this.invoices.createDraftInvoice(dto.salesOrderId, req.user.id);
  }

  /** ERP UI Integration (CTO directive) — the "الفواتير" list screen, across every customer the caller may see. Scope-filtered, not role-gated (a rep legitimately sees their own customers' invoices). */
  @Get('invoices')
  async listAll(@Req() req: AuthenticatedRequest) {
    return this.invoices.listAllInvoices(req.user.id);
  }

  /** ERP UI Integration — Sales Order → Invoice cross-link (§8). Declared BEFORE the ':id' wildcard below so it's never shadowed, same discipline as `by-sales-order` routes elsewhere in this codebase. */
  @Get('invoices/by-sales-order/:salesOrderId')
  async getBySalesOrder(@Req() req: AuthenticatedRequest, @Param('salesOrderId') salesOrderId: string) {
    return this.invoices.getInvoiceForSalesOrder(salesOrderId, req.user.id);
  }

  /** ERP UI Integration — the "أعمار الديون" list screen, across every customer the caller may see. */
  @Get('ar-aging')
  async arAgingAll(@Req() req: AuthenticatedRequest) {
    return this.invoices.getArAgingForAllCustomers(req.user.id);
  }

  @UseGuards(RolesGuard)
  @RequireRole('admin', 'finance')
  @Post('invoices/:id/post')
  async post(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.invoices.postInvoice(id, req.user.id);
  }

  @UseGuards(RolesGuard)
  @RequireRole('admin', 'finance')
  @Post('invoices/:id/void')
  async void(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: VoidInvoiceDto) {
    return this.invoices.voidInvoice(id, dto.reason, req.user.id);
  }

  @Get('invoices/:id')
  async get(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.invoices.getInvoice(id, req.user.id);
  }

  @Get('customers/:id/invoices')
  async listForCustomer(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.invoices.listInvoicesForCustomer(id, req.user.id);
  }

  @Get('customers/:id/ar-aging')
  async arAging(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.invoices.getArAging(id, req.user.id);
  }
}
