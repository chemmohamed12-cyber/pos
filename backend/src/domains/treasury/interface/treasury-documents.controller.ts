import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Put, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsNumberString, IsOptional, IsString, IsUUID, Matches, MinLength, ValidateNested } from 'class-validator';
import { TreasuryDocumentService, TreasuryDocumentInput } from '../application/treasury-document.service';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';
import { IdempotencyService } from '../../../foundation/error-contract/idempotency.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { TREASURY_DOCUMENT_KINDS, TREASURY_TRANSFER_SUBTYPES } from '../domain/treasury-document';
import { FINANCE_COLLECTION_CONTRACT, FinanceCollectionContract } from '../../../foundation/module-registry/contracts/collection.contract';
import { Inject } from '@nestjs/common';

class AllocationDto {
  @IsUUID()
  invoiceId!: string;

  @IsNumberString()
  amount!: string;
}

class DocumentDto implements TreasuryDocumentInput {
  @IsIn([...TREASURY_DOCUMENT_KINDS])
  kind!: TreasuryDocumentInput['kind'];

  @IsOptional()
  @IsIn([...TREASURY_TRANSFER_SUBTYPES])
  subtype?: TreasuryDocumentInput['subtype'];

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  businessDate?: string;

  @IsUUID()
  treasuryAccountId!: string;

  @IsOptional()
  @IsUUID()
  counterTreasuryAccountId?: string;

  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => AllocationDto)
  allocations?: AllocationDto[];

  @IsOptional()
  @IsNumberString()
  unappliedAmount?: string;

  @IsOptional()
  @IsNumberString()
  amount?: string;

  @IsOptional()
  @IsString()
  method?: string;

  @IsOptional()
  @IsString()
  reasonCode?: string;

  @IsOptional()
  @IsString()
  reference?: string;

  @IsOptional()
  @IsString()
  purpose?: string;
}

class UpdateDocumentDto extends DocumentDto {
  @IsOptional()
  @IsInt()
  expectedVersion?: number;
}

class VersionDto {
  @IsOptional()
  @IsInt()
  expectedVersion?: number;
}

class ReasonDto {
  @IsString()
  @MinLength(3)
  reason!: string;
}

class DecisionDto {
  @IsIn(['approved', 'rejected'])
  decision!: 'approved' | 'rejected';

  @IsOptional()
  @IsString()
  note?: string;
}

/**
 * T3 — Treasury Documents API. Every action has its own permission node (prepare / submit / approve / execute / cancel / reverse), enforced server-side; the
 * checker's separation from the maker and the live approval permission are enforced again by the FA-01 engine. `Idempotency-Key` is honoured on the actions that
 * change state, and the locked status machine makes a replay harmless even without it.
 */
@Controller('treasury/documents')
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard, PermissionGuard)
@RequireModule('finance')
export class TreasuryDocumentsController {
  constructor(
    private readonly documents: TreasuryDocumentService,
    private readonly idempotency: IdempotencyService,
    private readonly events: EventBusService,
    @Inject(FINANCE_COLLECTION_CONTRACT) private readonly collections: FinanceCollectionContract,
  ) {}

  private ctx(req: CompanyScopedRequest) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return { userId: req.user.id, manager: req.companyContext.dataSource.manager };
  }

  @RequirePermission('finance.cash_document.view', 'read-only')
  @Get()
  async list(@Req() req: CompanyScopedRequest, @Query('status') status?: string, @Query('kind') kind?: string) {
    return this.documents.list({ status, kind }, this.ctx(req).manager);
  }

  @RequirePermission('finance.cash_document.view', 'read-only')
  @Get('reason-codes')
  reasonCodes() {
    return this.documents.listReasonCodes();
  }

  @RequirePermission('finance.cash_document.view', 'read-only')
  @Get('customers/:customerId/open-invoices')
  async openInvoices(@Req() req: CompanyScopedRequest, @Param('customerId', ParseUUIDPipe) customerId: string) {
    const { userId, manager } = this.ctx(req);
    return this.collections.listOpenInvoices(customerId, userId, manager);
  }

  @RequirePermission('finance.cash_document.view', 'read-only')
  @Get(':id')
  async get(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.documents.get(id, this.ctx(req).manager);
  }

  @RequirePermission('finance.cash_document.view', 'read-only')
  @Get(':id/effect')
  async effect(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.documents.previewEffect(id, this.ctx(req).manager);
  }

  @RequirePermission('finance.cash_document.create', 'editable')
  @Post()
  async create(@Req() req: CompanyScopedRequest, @Body() dto: DocumentDto, @Headers('idempotency-key') idempotencyKey?: string) {
    const { userId, manager } = this.ctx(req);
    return this.idempotency.withIdempotencyInTransaction('treasury.documents.create', idempotencyKey, (tx) => this.documents.create(dto, userId, tx), manager);
  }

  @RequirePermission('finance.cash_document.create', 'editable')
  @Put(':id')
  async update(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDocumentDto) {
    const { userId, manager } = this.ctx(req);
    return this.documents.update(id, dto, dto.expectedVersion, userId, manager);
  }

  @RequirePermission('finance.cash_document.submit', 'editable')
  @Post(':id/submit')
  async submit(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: VersionDto) {
    const { userId, manager } = this.ctx(req);
    const result = await this.documents.submit(id, dto.expectedVersion, userId, manager);
    await this.events.dispatchAfterCommit(manager);
    return result;
  }

  @RequirePermission('finance.cash_document.approve', 'editable')
  @Post(':id/decide')
  async decide(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DecisionDto) {
    const { userId, manager } = this.ctx(req);
    return this.documents.decide(id, userId, dto.decision, dto.note, manager);
  }

  @RequirePermission('finance.cash_document.execute', 'editable')
  @Post(':id/execute')
  async execute(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: VersionDto, @Headers('idempotency-key') idempotencyKey?: string) {
    const { userId, manager } = this.ctx(req);
    const result = await this.idempotency.withIdempotencyInTransaction('treasury.documents.execute', idempotencyKey ? `${id}:${idempotencyKey}` : undefined, (tx) => this.documents.execute(id, dto.expectedVersion, userId, tx), manager);
    await this.events.dispatchAfterCommit(manager);
    return result;
  }

  @RequirePermission('finance.cash_document.cancel', 'editable')
  @Post(':id/cancel')
  async cancel(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) {
    const { userId, manager } = this.ctx(req);
    return this.documents.cancel(id, dto.reason, userId, manager);
  }

  @RequirePermission('finance.cash_document.reverse', 'editable')
  @Post(':id/reverse')
  async reverse(@Req() req: CompanyScopedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) {
    const { userId, manager } = this.ctx(req);
    const result = await this.documents.reverse(id, dto.reason, userId, manager);
    await this.events.dispatchAfterCommit(manager);
    return result;
  }
}
