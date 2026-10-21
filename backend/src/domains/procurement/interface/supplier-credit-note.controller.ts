import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ArrayMinSize, IsArray, IsNumberString, IsOptional, IsString, IsUUID, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { SupplierCreditNoteService } from '../application/supplier-credit-note.service';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';

class CreditLineDto {
  @IsUUID()
  supplierInvoiceLineId!: string;

  @IsNumberString()
  amount!: string;

  /** the posted return line of invoiced goods this credit settles (optional) */
  @IsOptional()
  @IsUUID()
  purchaseReturnLineId?: string;
}

class CreateCreditNoteDto {
  @IsUUID()
  supplierInvoiceId!: string;

  @IsString()
  @MaxLength(255)
  reason!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  supplierReference?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreditLineDto)
  lines!: CreditLineDto[];
}

class ReasonDto {
  @IsString()
  @MaxLength(500)
  reason!: string;
}

/** Phase D-2 (D6) - supplier credit notes linked to the original invoice and its lines. Company-scoped; every write on the caller's own Company connection. */
@Controller('procurement/supplier-credit-notes')
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard)
@RequireModule('procurement')
export class SupplierCreditNoteController {
  constructor(private readonly notes: SupplierCreditNoteService) {}

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier_credit_note.view', 'read-only')
  @Get()
  async list(@Req() req: CompanyScopedRequest) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.notes.list(req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier_credit_note.view', 'read-only')
  @Get('creditable')
  async creditable(@Req() req: CompanyScopedRequest, @Query('supplierInvoiceId', ParseUUIDPipe) supplierInvoiceId: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.notes.creditableLines(supplierInvoiceId, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier_credit_note.view', 'read-only')
  @Get(':id')
  async get(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.notes.get(id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier_credit_note.create', 'editable')
  @Post()
  async create(@Body() dto: CreateCreditNoteDto, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.notes.createDraft(dto, req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier_credit_note.submit', 'editable')
  @Post(':id/submit')
  async submit(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.notes.submit(id, req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier_credit_note.approve', 'editable')
  @Post(':id/approve')
  async approve(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.notes.approve(id, req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier_credit_note.approve', 'editable')
  @Post(':id/reject')
  async reject(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.notes.reject(id, dto.reason, req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier_credit_note.create', 'editable')
  @Post(':id/reopen')
  async reopen(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.notes.reopen(id, req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier_credit_note.create', 'editable')
  @Post(':id/cancel')
  async cancel(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.notes.cancel(id, dto.reason, req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.supplier_credit_note.post', 'editable')
  @Post(':id/post')
  async post(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.notes.post(id, req.user.id, req.companyContext.dataSource.manager);
  }
}
