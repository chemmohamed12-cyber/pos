import { Body, Controller, Get, Param, Post, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsNumberString, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { SalesOrdersService } from '../application/sales-orders.service';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { SHIPPING_METHODS, ShippingMethod } from '../domain/shipping-method';
import { RequireModule, RequireModuleGuard } from '../../../foundation/module-registry/require-module.decorator';
import { AccessScopeService } from '../../../foundation/scope/access-scope.service';
import { WarehouseScopeGuard } from '../../../foundation/scope/warehouse-scope.guard';
import { WarehouseScopeFiltered, WarehouseScoped } from '../../../foundation/scope/warehouse-scope.decorator';

class OrderLineDto {
  @IsString()
  productId!: string;

  @IsInt()
  @Min(1)
  quantity!: number;

  /** Gap G-4 — optional flat discount off this line's gross total; server-validated in SalesOrdersService against the line's own total. */
  @IsOptional()
  @IsNumberString()
  discountAmount?: string;

  /** Three-tier pricing (CTO instruction) — overrides the price-list/base price; server-validated. */
  @IsOptional()
  @IsNumberString()
  repPrice?: string;

  /** Three-tier pricing — overrides both repPrice and the list price; only honored when the ACTUAL caller holds sales_manager/admin (see SalesOrdersService.createOrder). */
  @IsOptional()
  @IsNumberString()
  managerPrice?: string;
}

class CreateOrderDto {
  @IsString()
  customerId!: string;

  /** CTO directive (Priority 2 — stock is reserved atomically at order creation, so a warehouse must be chosen up front, same single-warehouse-per-order constraint the later Reserve/Fulfillment steps already enforce). */
  @IsString()
  warehouseId!: string;

  /**
   * Omitted (the common case): the order belongs to the caller
   * themselves. Only a sales_manager/admin may supply a DIFFERENT
   * rep's id here — building/adjusting an order alongside that rep,
   * e.g. to set a `managerPrice` on a line (server-enforced in
   * `SalesOrdersService.createOrder`, never trusted from this alone).
   */
  @IsOptional()
  @IsString()
  salesRepUserId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OrderLineDto)
  lines!: OrderLineDto[];

  /** CTO directive §2 — how this order's goods leave the warehouse. */
  @IsIn(SHIPPING_METHODS)
  shippingMethod!: ShippingMethod;

  /**
   * Hotfix 6 (post-v1.0.2) — "إنشاء بدون عربون" ("Create Without Deposit").
   * Omitted/false (the default, unchanged behavior): normal flow, deposit
   * optional at creation as before, Finance deposit-approval gates release
   * same as always. True: no deposit is ever expected for this order —
   * `SalesOrdersService.transitionOrder` skips straight from Manager
   * Approval to `released` without a Finance deposit-approval step.
   * Supervisor/Manager approval are never skipped by this flag.
   */
  @IsOptional()
  @IsBoolean()
  skipDeposit?: boolean;
}

class TransitionDto {
  @IsString()
  action!: string;
}

class UpdateOrderLineDto {
  @IsString()
  lineId!: string;

  @IsInt()
  @Min(1)
  quantity!: number;

  @IsOptional()
  @IsNumberString()
  discountAmount?: string;

  @IsOptional()
  @IsNumberString()
  repPrice?: string;

  @IsOptional()
  @IsNumberString()
  managerPrice?: string;
}

class UpdateOrderLinesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => UpdateOrderLineDto)
  lines!: UpdateOrderLineDto[];

  /** Post-Deposit-Approval Edit Control (CTO directive) — required by SalesOrdersService.updateOrderLines when the order is `released`; ignored/optional for the earlier review-stage edits. */
  @IsOptional()
  @IsString()
  reason?: string;
}

class DraftOrderLineDto {
  /** Present = an existing line being kept/changed; absent = a new line being added. */
  @IsOptional()
  @IsString()
  lineId?: string;

  @IsString()
  productId!: string;

  @IsInt()
  @Min(1)
  quantity!: number;

  @IsOptional()
  @IsNumberString()
  discountAmount?: string;

  @IsOptional()
  @IsNumberString()
  repPrice?: string;

  @IsOptional()
  @IsNumberString()
  managerPrice?: string;
}

class EditDraftOrderDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => DraftOrderLineDto)
  lines!: DraftOrderLineDto[];
}

/**
 * Area 21 Operational Company Scoping Retrofit (2026-09-27, CTO-authorized).
 * `CompanyContextGuard` added — this is the controller whose live bug
 * (a new Company's Dashboard/Sales showing legacy figures) triggered the
 * whole workstream. Every service call below threads
 * `req.companyContext.dataSource.manager`, per the approved mechanism
 * (`CompanyContextGuard` → `EntityManager` → `service(manager?)` →
 * `manager ?? this.dataSource` → repository) — guard-only would 401/permit
 * correctly but silently keep reading the ambient DB, exactly the bug
 * already found.
 */
@Controller('sales-orders')
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard, WarehouseScopeGuard)
@RequireModule('sales')
export class SalesOrdersController {
  constructor(
    private readonly salesOrders: SalesOrdersService,
    private readonly scopes: AccessScopeService,
  ) {}

  /** F6 — the caller's visible warehouses for the list filter (`undefined` = unrestricted). An order with no warehouse (legacy) is unscoped. */
  private async visibleOnly(req: CompanyScopedRequest): Promise<string[] | undefined> {
    const scope = await this.scopes.forRequest(req);
    const visible = await this.scopes.visibleWarehouseIds(scope, req.companyContext!.dataSource.manager);
    return visible === 'ALL' ? undefined : visible;
  }

  @WarehouseScoped({ body: 'warehouseId' })
  @Post()
  async create(@Req() req: CompanyScopedRequest, @Body() dto: CreateOrderDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    const order = await this.salesOrders.createOrder(
      dto.customerId,
      dto.salesRepUserId ?? req.user.id,
      dto.lines,
      req.user.id,
      dto.warehouseId,
      dto.shippingMethod,
      dto.skipDeposit ?? false,
      manager,
    );
    return { ...order, status: await this.salesOrders.getOrderStatus(order.id, manager) };
  }

  /**
   * `page`/`pageSize` are opt-in (pagination audit fix, MASTER_PROJECT_
   * STATUS.md §6): omitted, this keeps returning the full plain array
   * exactly as before — the Sales Orders screen's own status-bucket
   * dashboard needs the FULL set to count draft/supervisor_review/
   * manager_approval/deposit_verification, not one page of it. Pass
   * either param to opt into the real, take/skip-bounded `listOrdersPage`
   * and get back `{rows, total}` instead — same clamp convention as
   * `InventoryController.warehouseInventory`.
   */
  @WarehouseScopeFiltered('orders of the caller\'s visible warehouses only (on top of the rep / reviewer visibility)')
  @Get()
  async list(@Req() req: CompanyScopedRequest, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    const visibleWarehouseIds = await this.visibleOnly(req);
    if (!page && !pageSize) {
      const orders = await this.salesOrders.listOrders(req.user.id, manager, visibleWarehouseIds);
      return Promise.all(
        orders.map(async (order) => ({ ...order, status: await this.salesOrders.getOrderStatus(order.id, manager) })),
      );
    }
    const parsedPage = Math.max(1, Number(page) || 1);
    const parsedPageSize = Math.min(200, Math.max(1, Number(pageSize) || 50));
    const { rows, total } = await this.salesOrders.listOrdersPage(req.user.id, { page: parsedPage, pageSize: parsedPageSize, visibleWarehouseIds }, manager);
    const enriched = await Promise.all(
      rows.map(async (order) => ({ ...order, status: await this.salesOrders.getOrderStatus(order.id, manager) })),
    );
    return { rows: enriched, total };
  }

  @WarehouseScoped({ recordOf: 'sales_orders', param: 'id' })
  @Get(':id')
  async get(@Req() req: CompanyScopedRequest, @Param('id') id: string) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    const order = await this.salesOrders.getOrderDetailView(id, req.user.id, manager);
    const lines = await this.salesOrders.getOrderLines(id, manager);
    return { ...order, status: await this.salesOrders.getOrderStatus(id, manager), lines };
  }

  @WarehouseScoped({ recordOf: 'sales_orders', param: 'id' })
  @Post(':id/transition')
  async transition(@Req() req: CompanyScopedRequest, @Param('id') id: string, @Body() dto: TransitionDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const status = await this.salesOrders.transitionOrder(id, dto.action, req.user.id, req.companyContext.dataSource.manager);
    return { orderId: id, status };
  }

  /** Order Edit During Review (CTO directive §1) — role/stage gating lives in SalesOrdersService.updateOrderLines, not here (same "no business logic in the UI/interface layer" discipline as everywhere else in this controller). */
  @WarehouseScoped({ recordOf: 'sales_orders', param: 'id' })
  @Post(':id/lines')
  async updateLines(@Req() req: CompanyScopedRequest, @Param('id') id: string, @Body() dto: UpdateOrderLinesDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    const order = await this.salesOrders.updateOrderLines(id, dto.lines, req.user.id, dto.reason, manager);
    const lines = await this.salesOrders.getOrderLines(id, manager);
    return { ...order, status: await this.salesOrders.getOrderStatus(id, manager), lines };
  }

  /** Order Edit History (CTO directive §1) — read-only trail of every field-level edit on this order's lines, including post-release admin/finance edits and their reason. */
  @WarehouseScoped({ recordOf: 'sales_orders', param: 'id' })
  @Get(':id/edit-history')
  async editHistory(@Req() req: CompanyScopedRequest, @Param('id') id: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.salesOrders.getOrderEditHistory(id, req.companyContext.dataSource.manager);
  }

  /** Order Edit at Draft — full add/remove/change, ownership-gated in SalesOrdersService.editDraftOrder. */
  @WarehouseScoped({ recordOf: 'sales_orders', param: 'id' })
  @Post(':id/draft-lines')
  async editDraft(@Req() req: CompanyScopedRequest, @Param('id') id: string, @Body() dto: EditDraftOrderDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const manager = req.companyContext.dataSource.manager;
    const order = await this.salesOrders.editDraftOrder(id, dto.lines, req.user.id, manager);
    const lines = await this.salesOrders.getOrderLines(id, manager);
    return { ...order, status: await this.salesOrders.getOrderStatus(id, manager), lines };
  }

  /** Draft Order Deletion (CTO directive §2) — ownership/status gating lives in SalesOrdersService.deleteDraftOrder. POST-action style, matching this controller's own convention, rather than the only @Delete() verb in this file. */
  @WarehouseScoped({ recordOf: 'sales_orders', param: 'id' })
  @Post(':id/delete')
  async deleteDraft(@Req() req: CompanyScopedRequest, @Param('id') id: string) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    await this.salesOrders.deleteDraftOrder(id, req.user.id, req.companyContext.dataSource.manager);
    return { orderId: id, deleted: true };
  }
}
