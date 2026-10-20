import { Body, Controller, Get, Optional, Param, Post, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { IsArray, IsDateString, IsIn, IsInt, IsNumberString, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { InventoryPostingDispatchService } from '../application/inventory-posting-dispatch.service';
import { WarehouseTransactionsService } from '../application/warehouse-transactions.service';
import { WarehouseTransactionType } from '../domain/warehouse-transaction-type';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { AccessScopeService } from '../../../foundation/scope/access-scope.service';
import { WarehouseScopeGuard } from '../../../foundation/scope/warehouse-scope.guard';
import { WarehouseScopeFiltered, WarehouseScoped } from '../../../foundation/scope/warehouse-scope.decorator';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';
import { AuthorizationContextService } from '../../../foundation/authorization/authorization-context.service';

class TransactionLineDto {
  @IsString()
  productId!: string;

  @IsInt()
  @Min(1)
  quantity!: number;

  @IsOptional()
  @IsString()
  notes?: string;

  /** D3-B — mandatory (> 0) on a `receipt` line; the service rejects a receipt without it. */
  @IsOptional()
  @IsNumberString()
  unitCostBase?: string;
}

class CreateTransactionDto {
  @IsIn(['receipt', 'issue', 'transfer', 'adjustment'])
  type!: WarehouseTransactionType;

  @IsString()
  warehouseId!: string;

  @IsOptional()
  @IsString()
  destinationWarehouseId?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TransactionLineDto)
  lines!: TransactionLineDto[];

  @IsOptional()
  @IsString()
  reference?: string;

  @IsOptional()
  @IsString()
  reason?: string;

  /** D3-B — controlled reason code (mandatory for `receipt`); selects the configured offset GL account. */
  @IsOptional()
  @IsString()
  reasonCode?: string;

  /** ADR-INV-04 - the record that justifies the document: its type (warehouse_transaction, opening_batch, sales_order, ...) and id. */
  @IsOptional()
  @IsString()
  referenceType?: string;

  @IsOptional()
  @IsString()
  referenceId?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  /** Warehouse ERP V1 / Phase 1 Integration (CTO directive §13) — the backdatable business date; omit for "now". */
  @IsOptional()
  @IsDateString()
  movementDate?: string;
}

class StartCountDto {
  @IsString()
  warehouseId!: string;

  @IsArray()
  @IsString({ each: true })
  productIds!: string[];
}

class CountResultLineDto {
  @IsString()
  lineId!: string;

  @IsInt()
  physicalQuantity!: number;
}

class RecordCountResultsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CountResultLineDto)
  lines!: CountResultLineDto[];
}

class TransitionDto {
  @IsString()
  action!: string;
}

/**
 * Warehouse & Inventory Control UX/UI V1 (CTO directive) — the
 * multi-line transaction document API (Receipt/Issue/Transfer/
 * Adjustment/Count) backing the Inventory Movement Center. Read routes
 * are broadly available (matches Inventory's own existing policy);
 * writes are role-gated per action inside the service itself (adding
 * one more layer here would just duplicate `WAREHOUSE_TRANSACTION_ACTION_ROLES`).
 */
/**
 * Area 21 Operational Company Scoping Retrofit (2026-09-28, CTO-authorized,
 * controller #17). `CompanyContextGuard` added at the class level — every
 * route threads `req.companyContext.dataSource.manager` into
 * `WarehouseTransactionsService`.
 */
@Controller('warehouse-transactions')
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard, WarehouseScopeGuard)
@RequireModule('inventory')
export class WarehouseTransactionsController {
  constructor(
    private readonly transactions: WarehouseTransactionsService,
    private readonly scopes: AccessScopeService,
    private readonly contexts: AuthorizationContextService,
    // C2: optional so a direct construction keeps compiling; Nest always provides it.
    @Optional() private readonly dispatch?: InventoryPostingDispatchService,
  ) {}

  /** F6 — the caller's visible warehouses for the list/overview filters (`undefined` = unrestricted). */
  private async visibleOnly(req: CompanyScopedRequest): Promise<string[] | undefined> {
    const scope = await this.scopes.forRequest(req);
    const visible = await this.scopes.visibleWarehouseIds(scope, req.companyContext!.dataSource.manager);
    return visible === 'ALL' ? undefined : visible;
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.transaction.create', 'editable')
  @WarehouseScoped({ body: 'warehouseId' }, { body: 'destinationWarehouseId' })
  @Post()
  async create(@Req() req: CompanyScopedRequest, @Body() dto: CreateTransactionDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.transactions.createTransaction(
      dto.type,
      dto.warehouseId,
      dto.destinationWarehouseId ?? null,
      dto.lines,
      dto.reference ?? null,
      dto.reason ?? null,
      dto.notes ?? null,
      req.user.id,
      dto.movementDate ? new Date(dto.movementDate) : undefined,
      req.companyContext.dataSource.manager,
      dto.reasonCode ?? null,
      dto.referenceType ?? null,
      dto.referenceId ?? null,
    );
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.stock_count.create', 'editable')
  @WarehouseScoped({ body: 'warehouseId' })
  @Post('count')
  async startCount(@Req() req: CompanyScopedRequest, @Body() dto: StartCountDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.transactions.startCount(dto.warehouseId, dto.productIds, req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.stock_count.adjust', 'editable')
  @WarehouseScoped({ recordOf: 'warehouse_transactions', param: 'id' })
  @Post(':id/count-results')
  async recordCountResults(@Req() req: CompanyScopedRequest, @Param('id') id: string, @Body() dto: RecordCountResultsDto) {
    if (!req.companyContext) throw new UnauthorizedException();
    await this.transactions.recordCountResults(id, dto.lines, req.companyContext.dataSource.manager);
    return { recorded: true };
  }

  @WarehouseScopeFiltered('KPIs of the caller\'s visible warehouses only')
  @Get('overview')
  async overview(@Req() req: CompanyScopedRequest) {
    if (!req.companyContext) throw new UnauthorizedException();
    // C1 (ADR-INV-07): the cost figure is only computed for a caller who holds the valuation view permission; everyone else keeps the quantity KPIs and the
    // selling-price figure exactly as before (the cost fields are null).
    const includeCost = (await this.contexts.forRequest(req)).hasAtLeast('inventory.valuation.view', 'read-only');
    return this.transactions.getOverview(req.companyContext.dataSource.manager, await this.visibleOnly(req), includeCost);
  }

  /**
   * `page`/`pageSize` are opt-in (pagination audit fix, MASTER_PROJECT_
   * STATUS.md §6): omitted, this keeps returning the full plain array
   * exactly as before — backward-compatible for any caller that hasn't
   * moved to the new `{rows, total}` shape. Pass either param to opt
   * into the real, take/skip-bounded `listTransactionsPage` instead —
   * same clamp convention as `InventoryController.warehouseInventory`.
   */
  @WarehouseScoped({ query: 'warehouseId' })
  @WarehouseScopeFiltered('transactions of the caller\'s visible warehouses only')
  @Get()
  async list(
    @Req() req: CompanyScopedRequest,
    @Query('warehouseId') warehouseId?: string,
    @Query('type') type?: WarehouseTransactionType,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    if (!req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    const visibleWarehouseIds = await this.visibleOnly(req);
    if (!page && !pageSize) {
      return this.transactions.listTransactions({ warehouseId, type, visibleWarehouseIds }, manager);
    }
    const parsedPage = Math.max(1, Number(page) || 1);
    const parsedPageSize = Math.min(200, Math.max(1, Number(pageSize) || 50));
    return this.transactions.listTransactionsPage({ warehouseId, type, page: parsedPage, pageSize: parsedPageSize, visibleWarehouseIds }, manager);
  }

  @WarehouseScoped({ recordOf: 'warehouse_transactions', param: 'id' })
  @Get(':id')
  async get(@Req() req: CompanyScopedRequest, @Param('id') id: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.transactions.getTransaction(id, req.companyContext.dataSource.manager);
  }

  @WarehouseScoped({ recordOf: 'warehouse_transactions', param: 'id' })
  @Get(':id/lines')
  async getLines(@Req() req: CompanyScopedRequest, @Param('id') id: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.transactions.getLines(id, req.companyContext.dataSource.manager);
  }

  @WarehouseScoped({ recordOf: 'warehouse_transactions', param: 'id' })
  @Post(':id/transition')
  async transition(@Req() req: CompanyScopedRequest, @Param('id') id: string, @Body() dto: TransitionDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    const state = await this.transactions.transition(id, dto.action, req.user.id, manager);
    // C2 (ADR-INV-10): an action that posts the ledger dispatches its events in THIS request (the document transaction has committed). The document stays
    // `posted` operationally either way; `financialPosting` states the truth about the GL side, so success is never reported while posting is incomplete.
    if (!this.dispatch || !['submit', 'approve', 'post', 'reverse'].includes(dto.action)) return { transactionId: id, state };
    const refs = (await this.transactions.financialReferenceIds(id, manager)).map((referenceId) => ({ referenceType: '*', referenceId }));
    return { transactionId: id, state, financialPosting: await this.dispatch.dispatchAndReport(manager, refs) };
  }
}
