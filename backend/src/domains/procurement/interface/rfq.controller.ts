import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { IsArray, IsNumberString, IsOptional, IsString, IsUUID, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { RfqService } from '../application/rfq.service';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';

class RecordQuotationLineDto {
  @IsUUID()
  purchaseRequestLineId!: string;

  @IsNumberString()
  quantity!: string;

  @IsNumberString()
  unitCostBase!: string;
}

class RecordQuotationDto {
  @IsUUID()
  supplierId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RecordQuotationLineDto)
  lines!: RecordQuotationLineDto[];
}

class AwardDto {
  @IsUUID()
  quotationId!: string;
}

/** ADR-048 — Path B, steps 2-4: RFQ, Supplier Quotations, Evaluation/Approval (award). */
@Controller('procurement/rfqs')
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard)
@RequireModule('procurement')
export class RfqController {
  constructor(private readonly rfqs: RfqService) {}

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.rfq.view', 'read-only')
  @Get()
  async list(@Req() req: CompanyScopedRequest) {
    return this.rfqs.list(req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.rfq.view', 'read-only')
  @Get(':id')
  async getById(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    return this.rfqs.getById(id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.rfq.view', 'read-only')
  @Get('quotations/:quotationId/lines')
  async getQuotationLines(@Param('quotationId', ParseUUIDPipe) quotationId: string, @Req() req: CompanyScopedRequest) {
    return this.rfqs.getQuotationLines(quotationId, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.rfq.edit', 'editable')
  @Post(':id/send')
  async send(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    return this.rfqs.send(id, req.user.id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.rfq.edit', 'editable')
  @Post(':id/cancel')
  async cancel(@Param('id', ParseUUIDPipe) id: string, @Req() req: CompanyScopedRequest) {
    return this.rfqs.cancel(id, req.user.id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.rfq.record_quotation', 'editable')
  @Post(':id/quotations')
  async recordQuotation(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RecordQuotationDto, @Req() req: CompanyScopedRequest) {
    return this.rfqs.recordQuotation({ rfqId: id, supplierId: dto.supplierId, notes: dto.notes ?? null, lines: dto.lines }, req.user.id, req.companyContext!.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('procurement.rfq.award', 'editable')
  @Post(':id/award')
  async award(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AwardDto, @Req() req: CompanyScopedRequest) {
    return this.rfqs.awardToSupplier(id, dto.quotationId, req.user.id, req.companyContext!.dataSource.manager);
  }
}
