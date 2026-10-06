import { Body, Controller, Get, Param, Post, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { IsArray, IsDateString, IsIn, IsInt, IsNumberString, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { WarehouseTransactionsService } from '../application/warehouse-transactions.service';
import { WarehouseTransactionType } from '../domain/warehouse-transaction-type';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';

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
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard)
@RequireModule('inventory')
export class WarehouseTransactionsController {
  constructor(private readonly transactions: WarehouseTransactionsService) {}

  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.transaction.create', 'editable')
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
    );
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.stock_count.create', 'editable')
  @Post('count')
  async startCount(@Req() req: CompanyScopedRequest, @Body() dto: StartCountDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.transactions.startCount(dto.warehouseId, dto.productIds, req.user.id, req.companyContext.dataSource.manager);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.stock_count.adjust', 'editable')
  @Post(':id/count-results')
  async recordCountResults(@Req() req: CompanyScopedRequest, @Param('id') id: string, @Body() dto: RecordCountResultsDto) {
    if (!req.companyContext) throw new UnauthorizedException();
    await this.transactions.recordCountResults(id, dto.lines, req.companyContext.dataSource.manager);
    return { recorded: true };
  }

  @Get('overview')
  async overview(@Req() req: CompanyScopedRequest) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.transactions.getOverview(req.companyContext.dataSource.manager);
  }

  /**
   * `page`/`pageSize` are opt-in (pagination audit fix, MASTER_PROJECT_
   * STATUS.md §6): omitted, this keeps returning the full plain array
   * exactly as before — backward-compatible for any caller that hasn't
   * moved to the new `{rows, total}` shape. Pass either param to opt
   * into the real, take/skip-bounded `listTransactionsPage` instead —
   * same clamp convention as `InventoryController.warehouseInventory`.
   */
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
    if (!page && !pageSize) {
      return this.transactions.listTransactions({ warehouseId, type }, manager);
    }
    const parsedPage = Math.max(1, Number(page) || 1);
    const parsedPageSize = Math.min(200, Math.max(1, Number(pageSize) || 50));
    return this.transactions.listTransactionsPage({ warehouseId, type, page: parsedPage, pageSize: parsedPageSize }, manager);
  }

  @Get(':id')
  async get(@Req() req: CompanyScopedRequest, @Param('id') id: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.transactions.getTransaction(id, req.companyContext.dataSource.manager);
  }

  @Get(':id/lines')
  async getLines(@Req() req: CompanyScopedRequest, @Param('id') id: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.transactions.getLines(id, req.companyContext.dataSource.manager);
  }

  @Post(':id/transition')
  async transition(@Req() req: CompanyScopedRequest, @Param('id') id: string, @Body() dto: TransitionDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const state = await this.transactions.transition(id, dto.action, req.user.id, req.companyContext.dataSource.manager);
    return { transactionId: id, state };
  }
}
