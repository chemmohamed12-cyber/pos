import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsArray, IsDateString, IsIn, IsInt, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { WarehouseTransactionsService } from '../application/warehouse-transactions.service';
import { WarehouseTransactionType } from '../domain/warehouse-transaction-type';
import { JwtAuthGuard, AuthenticatedRequest } from '../../../foundation/authentication/jwt-auth.guard';
import { RolesGuard } from '../../../foundation/authorization/roles.guard';
import { RequireRole } from '../../../foundation/authorization/require-role.decorator';

class TransactionLineDto {
  @IsString()
  productId!: string;

  @IsInt()
  @Min(1)
  quantity!: number;

  @IsOptional()
  @IsString()
  notes?: string;
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
@Controller('warehouse-transactions')
@UseGuards(JwtAuthGuard, RolesGuard)
export class WarehouseTransactionsController {
  constructor(private readonly transactions: WarehouseTransactionsService) {}

  @RequireRole('warehouse_worker', 'admin')
  @Post()
  async create(@Req() req: AuthenticatedRequest, @Body() dto: CreateTransactionDto) {
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
    );
  }

  @RequireRole('warehouse_worker', 'inventory_controller', 'admin')
  @Post('count')
  async startCount(@Req() req: AuthenticatedRequest, @Body() dto: StartCountDto) {
    return this.transactions.startCount(dto.warehouseId, dto.productIds, req.user.id);
  }

  @RequireRole('warehouse_worker', 'inventory_controller', 'admin')
  @Post(':id/count-results')
  async recordCountResults(@Param('id') id: string, @Body() dto: RecordCountResultsDto) {
    await this.transactions.recordCountResults(id, dto.lines);
    return { recorded: true };
  }

  @Get('overview')
  async overview() {
    return this.transactions.getOverview();
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
    @Query('warehouseId') warehouseId?: string,
    @Query('type') type?: WarehouseTransactionType,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    if (!page && !pageSize) {
      return this.transactions.listTransactions({ warehouseId, type });
    }
    const parsedPage = Math.max(1, Number(page) || 1);
    const parsedPageSize = Math.min(200, Math.max(1, Number(pageSize) || 50));
    return this.transactions.listTransactionsPage({ warehouseId, type, page: parsedPage, pageSize: parsedPageSize });
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return this.transactions.getTransaction(id);
  }

  @Get(':id/lines')
  async getLines(@Param('id') id: string) {
    return this.transactions.getLines(id);
  }

  @Post(':id/transition')
  async transition(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: TransitionDto) {
    const state = await this.transactions.transition(id, dto.action, req.user.id);
    return { transactionId: id, state };
  }
}
