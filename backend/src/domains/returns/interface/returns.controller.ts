import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';

import { IsIn, IsInt, IsNumberString, IsOptional, IsString, Min } from 'class-validator';
import { ReturnsService } from '../application/returns.service';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';
import { DispositionType } from '../domain/disposition-type';
import { RETURN_TYPES, ReturnType } from '../domain/return-type';

class CreateReturnRequestDto {
  @IsString()
  salesOrderLineId!: string;

  @IsInt()
  @Min(1)
  quantity!: number;

  @IsIn(RETURN_TYPES)
  returnType!: ReturnType;

  @IsString()
  reason!: string;
}

class CreateCustodyReturnRequestDto {
  @IsString()
  shipmentId!: string;

  @IsString()
  productId!: string;

  @IsInt()
  @Min(1)
  quantity!: number;

  @IsString()
  reason!: string;
}

class DispositionDto {
  @IsIn(['restock', 'damaged', 'repair', 'scrap', 'replacement'])
  disposition!: DispositionType;

  @IsOptional()
  @IsString()
  notes?: string;
}

class ApplyCreditDto {
  @IsString()
  salesOrderId!: string;

  @IsNumberString()
  amount!: string;
}

class ApplyCreditToInvoiceDto {
  @IsString()
  invoiceId!: string;

  @IsNumberString()
  amount!: string;
}

@Controller('returns')
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard)
@RequireModule('logistics')
export class ReturnsController {
  constructor(private readonly returns: ReturnsService) {}

  @Post()
  async create(@Req() req: CompanyScopedRequest, @Body() dto: CreateReturnRequestDto) {
    return this.returns.createReturnRequest(dto.salesOrderLineId, dto.quantity, dto.returnType, dto.reason, req.user.id, req.companyContext!.dataSource.manager);
  }

  /** Returns Engine Phase B — a pre-delivery custody return (Shipping Company or Company Vehicle custody). Static path declared BEFORE the ':id' wildcard below so it's never shadowed, same discipline as 'credits' below. */
  @Post('custody')
  async createCustodyReturn(@Req() req: CompanyScopedRequest, @Body() dto: CreateCustodyReturnRequestDto) {
    return this.returns.initiateCustodyReturn(dto.shipmentId, dto.productId, dto.quantity, dto.reason, req.user.id, req.companyContext!.dataSource.manager);
  }

  @Get()
  async list(@Req() req: CompanyScopedRequest) {
    return this.returns.listReturns(req.companyContext!.dataSource.manager);
  }

  /**
   * Returns Engine (CTO directive §6) — backs the SO-draft "Returns /
   * Credits" panel when `customerId` is supplied. ERP UI Integration
   * (CTO directive) extends this SAME route: omitting `customerId`
   * backs the section-wide "Return Credits المتاحة" view instead,
   * Scope-filtered across every customer the caller may see — a new
   * capability on an existing route, never a second endpoint for the
   * same data. Static path declared BEFORE the ':id' wildcard below so
   * it's never shadowed.
   */
  @Get('credits')
  async listCredits(@Req() req: CompanyScopedRequest, @Query('customerId') customerId?: string) {
    if (customerId) return this.returns.listAvailableCredits(customerId, req.companyContext!.dataSource.manager);
    return this.returns.listAllAvailableCredits(req.user.id, req.companyContext!.dataSource.manager);
  }

  @Get(':id/status')
  async status(@Param('id') id: string, @Req() req: CompanyScopedRequest) {
    return { returnRequestId: id, status: await this.returns.getStatus(id, req.companyContext!.dataSource.manager) };
  }

  @Get(':id')
  async get(@Param('id') id: string, @Req() req: CompanyScopedRequest) {
    return this.returns.getReturnRequest(id, req.companyContext!.dataSource.manager);
  }

  @Post(':id/authorize')
  async authorize(@Req() req: CompanyScopedRequest, @Param('id') id: string) {
    return { status: await this.returns.authorize(id, req.user.id, req.companyContext!.dataSource.manager) };
  }

  @Post(':id/reject')
  async reject(@Req() req: CompanyScopedRequest, @Param('id') id: string) {
    return { status: await this.returns.reject(id, req.user.id, req.companyContext!.dataSource.manager) };
  }

  @Post(':id/receive')
  async receive(@Req() req: CompanyScopedRequest, @Param('id') id: string) {
    return { status: await this.returns.receiveAtWarehouse(id, req.user.id, req.companyContext!.dataSource.manager) };
  }

  @Post(':id/inspect')
  async inspect(@Req() req: CompanyScopedRequest, @Param('id') id: string) {
    return { status: await this.returns.inspect(id, req.user.id, req.companyContext!.dataSource.manager) };
  }

  @Post(':id/disposition')
  async disposition(@Req() req: CompanyScopedRequest, @Param('id') id: string, @Body() dto: DispositionDto) {
    return this.returns.recordDisposition(id, dto.disposition, dto.notes ?? null, req.user.id, req.companyContext!.dataSource.manager);
  }

  /** Returns Engine (CTO directive §6) — applies a Return Credit to a draft Sales Order. */
  @Post('credits/:id/apply')
  async applyCredit(@Req() req: CompanyScopedRequest, @Param('id') id: string, @Body() dto: ApplyCreditDto) {
    return this.returns.applyCreditToOrder(id, dto.salesOrderId, dto.amount, req.user.id, req.companyContext!.dataSource.manager);
  }

  /** Customer Financial Account / AR (CTO directive §7) — applies a Return Credit to an existing posted Invoice's AR. */
  @UseGuards(PermissionGuard)
  @RequirePermission('logistics.return.adjust', 'editable')
  @Post('credits/:id/apply-to-invoice')
  async applyCreditToInvoice(@Req() req: CompanyScopedRequest, @Param('id') id: string, @Body() dto: ApplyCreditToInvoiceDto) {
    return this.returns.applyCreditToInvoice(id, dto.invoiceId, dto.amount, req.user.id, req.companyContext!.dataSource.manager);
  }
}
