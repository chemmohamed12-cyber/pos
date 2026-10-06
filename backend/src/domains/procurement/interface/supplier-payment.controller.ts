import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { IsNumberString, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { SupplierPaymentService } from '../application/supplier-payment.service';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';

class RecordSupplierPaymentDto {
  @IsUUID()
  supplierId!: string;

  @IsUUID()
  invoiceId!: string;

  @IsNumberString()
  amount!: string;

  @IsString()
  @MaxLength(32)
  method!: string;

  @IsUUID()
  treasuryAccountId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  reference?: string;
}

@Controller('procurement/supplier-payments')
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard)
@RequireModule('procurement')
export class SupplierPaymentController {
  constructor(private readonly payments: SupplierPaymentService) {}

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier_payment.view', 'read-only')
  @Get()
  async listAll(@Req() req: CompanyScopedRequest) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.payments.listAll(req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier_payment.view', 'read-only')
  @Get('by-supplier/:supplierId')
  async listForSupplier(@Req() req: CompanyScopedRequest, @Param('supplierId', ParseUUIDPipe) supplierId: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.payments.listForSupplier(supplierId, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier_payment.create', 'editable')
  @Post()
  async record(@Body() dto: RecordSupplierPaymentDto, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.payments.recordPayment(
      dto.supplierId,
      dto.invoiceId,
      dto.amount,
      dto.method,
      dto.treasuryAccountId,
      dto.reference ?? null,
      req.user.id,
      req.companyContext.dataSource.manager,
    );
  }
}
