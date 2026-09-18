import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsInt, IsISO8601, IsNumberString, IsOptional, IsString, IsUUID, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { SalesReturnsService } from '../application/sales-returns.service';
import { JwtAuthGuard, AuthenticatedRequest } from '../../../foundation/authentication/jwt-auth.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';

/** Real E2E testing (2026-09-16) caught this: an invalid `customerId` used to fall through to a raw Postgres "invalid UUID" error (500), not a clean 400. */
class ListEligiblePurchasesDto {
  @IsUUID()
  customerId!: string;

  @IsISO8601()
  returnDate!: string;
}

class SalesReturnLineDto {
  @IsString()
  sourceSalesOrderLineId!: string;

  @IsInt()
  @Min(1)
  returnQuantity!: number;

  @IsNumberString()
  returnPrice!: string;
}

class CreateSalesReturnDto {
  @IsString()
  customerId!: string;

  /** Omit or null = "All Orders" mode (CTO directive §5-§6). */
  @IsOptional()
  @IsString()
  salesOrderId?: string | null;

  @IsISO8601()
  returnDate!: string;

  @ValidateNested({ each: true })
  @Type(() => SalesReturnLineDto)
  lines!: SalesReturnLineDto[];

  @IsOptional()
  @IsString()
  reason?: string;
}

/**
 * Sales/Shipment/Returns workflow review (CTO directive, 2026-09-16).
 * The general customer-return screen — independent of `/shipment-returns`
 * and of `/returns` (`ReturnRequest`'s custody reversal). A `SalesReturn`
 * may span multiple source Orders (directive §10); `salesOrderId` here is
 * only the header's "Specific Order" picker convenience, never assumed
 * to be the only order involved (see `getSalesReturnDetail`'s
 * `sourceOrderIds` array).
 */
@Controller('sales-returns')
@UseGuards(JwtAuthGuard, RequireModuleGuard)
@RequireModule('logistics')
export class SalesReturnsController {
  constructor(private readonly salesReturns: SalesReturnsService) {}

  /** The "All Orders" product picker (CTO directive §6-§7) — real purchase-history join, never a global product list. */
  @UseGuards(PermissionGuard)
  @RequirePermission('logistics.sales_return.view')
  @Get('eligible-purchases')
  async listEligiblePurchases(@Query() query: ListEligiblePurchasesDto) {
    return this.salesReturns.listEligiblePurchaseLines(query.customerId, new Date(query.returnDate));
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('logistics.sales_return.create', 'editable')
  @Post()
  async create(@Req() req: AuthenticatedRequest, @Body() dto: CreateSalesReturnDto) {
    return this.salesReturns.createSalesReturn(
      dto.customerId,
      dto.salesOrderId ?? null,
      new Date(dto.returnDate),
      dto.lines,
      dto.reason ?? null,
      req.user.id,
    );
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('logistics.sales_return.post', 'editable')
  @Post(':id/complete')
  async complete(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const state = await this.salesReturns.completeSalesReturn(id, req.user.id);
    return { salesReturnId: id, state };
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('logistics.sales_return.view')
  @Get()
  async list() {
    return this.salesReturns.listSalesReturns();
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('logistics.sales_return.view')
  @Get(':id')
  async get(@Param('id') id: string) {
    return this.salesReturns.getSalesReturnDetail(id);
  }
}
