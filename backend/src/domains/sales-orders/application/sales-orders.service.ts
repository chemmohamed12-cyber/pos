import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, Raw } from 'typeorm';
import { SalesOrder } from '../infrastructure/sales-order.entity';
import { SalesOrderLine } from '../infrastructure/sales-order-line.entity';
import { ORDER_ACTION_REQUIRED_ROLES, ORDER_ACTION_RULES } from '../domain/order-action-roles';
import { ProductsService } from '../../commerce/application/products.service';
import { PriceListsService } from '../../commerce/application/price-lists.service';
import { CustomersService } from '../../crm/application/customers.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { ScopeService } from '../../../foundation/scope/scope.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { AuthorizationService } from '../../../foundation/authorization/authorization.service';
import { WorkflowAccess } from '../../../foundation/authorization/workflow-access';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import {
  ProcessDefinition,
  SALES_ORDER_APPROVAL_PROCESS,
  SALES_ORDER_OPEN_ACCOUNT_PROCESS,
} from '../../../foundation/process-engine/process-definition';
import { OrderWorkflowPolicy } from '../../crm/domain/order-workflow-policy';
import { UsersService } from '../../../foundation/identity/users.service';
import { INVENTORY_RESERVATION_CONTRACT, InventoryReservationContract } from '../../../foundation/module-registry/contracts/inventory.contract';
import { SalesOrdersReadContract } from '../../../foundation/module-registry/contracts/sales.contract';
import { ShippingMethod, isValidShippingMethod } from '../domain/shipping-method';

export interface CreateOrderLineInput {
  productId: string;
  quantity: number;
  /** Gap G-4 — flat amount off this line's gross total; optional, defaults to no discount. */
  discountAmount?: string;
  /** Three-tier pricing (CTO instruction) — a rep's own override of the list/price-list price for this line. */
  repPrice?: string;
  /** Three-tier pricing — a sales manager's override, top of the precedence chain. Only honored when the ACTUAL creating user holds sales_manager/admin (see `createOrder`); supplied by anyone else, the whole order is rejected rather than silently ignored. */
  managerPrice?: string;
}

/** Order Edit During Review (CTO directive §1) — one existing line's new values; `undefined` on a price field means "leave it as it already was", `null`/`''` means "clear the override". */
export interface UpdateOrderLineInput {
  lineId: string;
  quantity: number;
  discountAmount?: string;
  repPrice?: string;
  managerPrice?: string;
}

/**
 * Order Edit at Draft (CTO directive — the rep must be able to fully
 * re-open their own not-yet-submitted order: add an item, remove an item,
 * change quantity/price/discount, before ever sending it to a supervisor).
 * `lineId` present = an existing line being kept/changed; absent = a new
 * line being added. Any existing line NOT present in the submitted array
 * is treated as removed.
 */
export interface DraftOrderLineInput extends CreateOrderLineInput {
  lineId?: string;
}

interface ResolvedLineInput {
  productId: string;
  quantity: number;
  unitPrice: string;
  listPrice: string;
  priceListId: string | null;
  priceListPrice: string;
  repPrice: string | null;
  managerPrice: string | null;
  discountAmount: string;
  lineTotal: string;
}

const ENTITY_TYPE = 'sales_order';

/** Order Edit During Review (CTO directive §1) — who may edit a line while the order sits in each review stage. Mirrors ORDER_ACTION_REQUIRED_ROLES' own supervisor_approve/manager_approve gates: whoever may approve a stage may also edit the order during it. `released` (Post-Deposit-Approval Edit Control, CTO directive) is deliberately separate from the review-stage entries below: reaching it means the order is live/committed for BOTH workflow policies (it's exactly the state `DepositsService.approveDeposit` transitions into for the standard policy, and open-account's own terminal state), so editing it is restricted to admin/finance and requires a reason (enforced in `updateOrderLines`, not here — this map only decides WHO). */
const STAGE_EDIT_ROLES: Record<string, string[]> = {
  supervisor_review: ['sales_supervisor'],
  manager_approval: ['sales_manager'],
  released: ['admin', 'finance'],
};
/** F5: the workflow capability behind each stage (the role lists above remain the documented legacy leg and the text of the refusal). */
const STAGE_EDIT_RULES: Record<string, string> = {
  supervisor_review: 'sales.order.edit_supervisor_review',
  manager_approval: 'sales.order.edit_manager_approval',
  released: 'sales.order.edit_released',
};

/** Post-Deposit-Approval Edit Control (CTO directive) — the one stage where a reason is mandatory for every edit. */
const REASON_REQUIRED_STAGES = new Set(['released']);

/** Gap G-1 — which Process Definition governs an order, keyed by its snapshotted `workflowPolicy`. */
const PROCESS_BY_POLICY: Record<OrderWorkflowPolicy, ProcessDefinition> = {
  standard: SALES_ORDER_APPROVAL_PROCESS,
  open_account: SALES_ORDER_OPEN_ACCOUNT_PROCESS,
};

@Injectable()
export class SalesOrdersService implements SalesOrdersReadContract {
  constructor(
    private readonly dataSource: DataSource,
    private readonly numbering: NumberingService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly authorization: AuthorizationService,
    private readonly processEngine: ProcessEngineService,
    private readonly products: ProductsService,
    private readonly priceLists: PriceListsService,
    private readonly customers: CustomersService,
    private readonly users: UsersService,
    @Inject(INVENTORY_RESERVATION_CONTRACT) private readonly inventory: InventoryReservationContract,
  ) {}

  /** Never throws — a missing/deleted user just resolves to `null` in the detail view rather than a hard 500. */
  private async safeFindUser(userId: string | null): Promise<{ id: string; fullName: string } | null> {
    if (!userId) return null;
    try {
      return await this.users.findById(userId);
    } catch {
      return null;
    }
  }

  /** Looks up the order's snapshotted policy and resolves it to a Process Definition — the one place every method below goes through, never hardcoding `SALES_ORDER_APPROVAL_PROCESS` directly. */
  private async getOrderAndDefinition(orderId: string, manager?: EntityManager): Promise<{ order: SalesOrder; definition: ProcessDefinition }> {
    const order = await (manager ?? this.dataSource).getRepository(SalesOrder).findOne({ where: { id: orderId } });
    if (!order) throw new NotFoundException(`Sales order "${orderId}" not found.`);
    return { order, definition: PROCESS_BY_POLICY[order.workflowPolicy] ?? SALES_ORDER_APPROVAL_PROCESS };
  }

  /**
   * The one authoritative pricing/discount calculation — used by both
   * `createOrder` and `updateOrderLines` (Order Edit During Review, CTO
   * directive §1: "أي تعديل على السعر يخضع لنفس Price Policy الحالية").
   * The frontend never re-derives this; it only displays what this
   * method (via the API) returns, matching the directive's "لا تنفذوا
   * Business Logic داخل الـUI" instruction.
   */
  private async resolveLineInput(
    line: CreateOrderLineInput,
    customerPriceListId: string | null,
    actorCanSetManagerPrice: boolean,
    manager?: EntityManager,
  ): Promise<ResolvedLineInput> {
    const snapshot = await this.products.getProductSnapshot(line.productId, manager);
    if (!snapshot || snapshot.status !== 'active') {
      throw new BadRequestException(`Product "${line.productId}" is not available for order.`);
    }

    // Gap G-3 + Hotfix 6 (post-v1.0.2) price-list priority chain: resolve
    // the price-list-adjusted starting price via
    // Customer's assigned list -> Main list -> General list (every
    // product, at its own creation-time price) — the first of the three
    // that actually has an override for this product wins; none of them
    // having one falls back to the product's own base price, exactly as
    // before this hotfix existed. NOTE: this is NOT the same thing as the
    // `listPrice` entity column below — that column always stores
    // the product's raw base price (`snapshot.unitPrice`), the fixed
    // reference every variance is measured against; this local
    // `priceListAdjustedPrice` is just the starting point the
    // three-tier override chain below begins from.
    let priceListAdjustedPrice = snapshot.unitPrice;
    const resolved = await this.priceLists.resolvePrice(customerPriceListId, snapshot.id, manager);
    if (resolved.price !== null) {
      priceListAdjustedPrice = resolved.price;
    }
    const usedPriceListId = resolved.priceListId;

    // Three-tier pricing (CTO instruction): "وجود سعر للمندوب يلغى
    // سعر اللسته ووجود سعر لمدير البيع يلغى سعر المندوب وسعر اللسته"
    // — a rep price cancels the list price; a manager price cancels
    // BOTH. `actorCanSetManagerPrice` was already verified by the caller
    // (whole-order reject if false and any line tried to set one).
    const parsePrice = (value: string | undefined, label: string): string | null => {
      if (value === undefined || value === null || value === '') return null;
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) throw new BadRequestException(`Invalid ${label} for product "${line.productId}".`);
      return n.toFixed(2);
    };
    const repPrice = parsePrice(line.repPrice, 'rep price');
    const managerPrice = actorCanSetManagerPrice ? parsePrice(line.managerPrice, 'manager price') : null;

    const unitPrice = managerPrice ?? repPrice ?? priceListAdjustedPrice;

    // Server-computed line/order totals — NEVER trusted from the client
    // (ADR-008 design reference, baseline's sales-order-engine pattern).
    const grossLineTotal = Number(unitPrice) * line.quantity;

    // Gap G-4: discount is bounded against THIS line's own gross total —
    // never negative, never more than the line itself is worth. A client
    // supplying an out-of-range value is a validation error, not silently
    // clamped, so a rep sees the mistake immediately rather than an order
    // quietly totaling less than intended.
    const discountAmount = Number(line.discountAmount ?? '0');
    if (!Number.isFinite(discountAmount) || discountAmount < 0) {
      throw new BadRequestException(`Invalid discount for product "${line.productId}".`);
    }
    if (discountAmount > grossLineTotal) {
      throw new BadRequestException(
        `Discount for product "${line.productId}" cannot exceed the line's total (${grossLineTotal.toFixed(2)}).`,
      );
    }

    const lineTotal = grossLineTotal - discountAmount;
    return {
      productId: snapshot.id,
      quantity: line.quantity,
      unitPrice,
      listPrice: snapshot.unitPrice,
      priceListId: usedPriceListId,
      priceListPrice: Number(priceListAdjustedPrice).toFixed(2),
      repPrice,
      managerPrice,
      discountAmount: discountAmount.toFixed(2),
      lineTotal: lineTotal.toFixed(2),
    };
  }

  async createOrder(
    customerId: string,
    salesRepUserId: string,
    lines: CreateOrderLineInput[],
    actorUserId: string | null,
    warehouseId: string,
    shippingMethod: ShippingMethod,
    skipDeposit = false,
    manager?: EntityManager,
    actorAccess?: WorkflowAccess,
  ): Promise<SalesOrder> {
    if (lines.length === 0) {
      throw new BadRequestException('A Sales Order must have at least one line item.');
    }
    if (!warehouseId) {
      throw new BadRequestException('A warehouse is required to create a Sales Order (stock is reserved at creation time).');
    }
    if (!isValidShippingMethod(shippingMethod)) {
      throw new BadRequestException(`Invalid shipping method "${shippingMethod}".`);
    }
    // `sales_orders.warehouseId` has no FK — an unknown warehouse is rejected up front (404, the inventory contract's own error) instead of
    // surfacing later as a misleading "insufficient stock" 409 from the reservation step, after the order/rep numbers were already consumed.
    await this.inventory.getWarehouse(warehouseId, manager);
    // Org engine Stage 5 — the order's branch is the warehouse's owning branch (a business relationship resolved on the server, never a client field).
    const branchOrgUnitId = await this.inventory.getWarehouseBranchId(warehouseId, manager);

    // Resolved once, used for two related checks below: (1) a caller may
    // create the order under a DIFFERENT rep's name only when they hold
    // sales_manager/admin (a manager building/adjusting an order
    // alongside their rep — without this, a manager price could never
    // actually be set by anyone, since the owning rep and acting caller
    // were always forced to be the same person); a plain sales_rep may
    // only ever create their own orders, same as before this change.
    // (2) whether any line's `managerPrice` may be honored at all.
    const actorCanSetManagerPrice = actorUserId ? (actorAccess ?? (await this.authorization.workflowAccess(actorUserId, manager))).allows('sales.order.set_manager_price') : false;
    if (salesRepUserId !== actorUserId && !actorCanSetManagerPrice) {
      throw new ForbiddenException('Only a sales manager or admin may create an order under a different Sales Representative.');
    }

    // Three-tier line pricing (CTO instruction): a `managerPrice` on any
    // line is only ever honored when the ACTUAL creating user holds the
    // sales_manager/admin role (`actorCanSetManagerPrice`, resolved
    // above) — never trusted from the client's own claim. A non-manager
    // supplying one is a validation error on the WHOLE order, not a
    // silently-ignored field (ADR-008's "never trust client input"
    // discipline, applied to this new input the same way it already
    // applies to totals). Checked BEFORE any Numbering Engine call
    // below — a doomed-to-fail request must never burn a sequence
    // number (found live: a rejected attempt was consuming a rep's
    // order-sequence slot before this check was moved here).
    if (!actorCanSetManagerPrice && lines.some((l) => l.managerPrice !== undefined && l.managerPrice !== null && l.managerPrice !== '')) {
      throw new ForbiddenException('Only a sales manager or admin may set a manager price on an order line.');
    }

    // A sales rep may only create an order for a customer they're scoped to —
    // this is the enforcement point for blueprint §22's "must be technically
    // unable to retrieve/act on an unauthorized customer" rule.
    await this.scope.assertAccess(salesRepUserId, 'customer', customerId, manager);

    const orderNumber = await this.numbering.getNextNumber('sales_order', manager);

    // Per-rep order sequence (CTO instruction) — a second, human-facing
    // number distinct from `orderNumber`'s global identity. Reuses the
    // Numbering Engine's own row-locked concurrency guarantee, keyed
    // per rep, rather than a COUNT-based scheme that could race.
    const repDocumentType = `sales_order_rep_${salesRepUserId}`;
    await this.numbering.registerDocumentType(repDocumentType, 'REP', false, manager); // idempotent
    const repFormatted = await this.numbering.getNextNumber(repDocumentType, manager);
    const repSequenceNumber = Number(repFormatted.replace(/^REP-/, ''));

    // Read CRM's published contract BEFORE opening our own write
    // transaction, same cross-domain discipline as the product-snapshot
    // reads below — Sales Orders never queries Customer's table directly
    // (DAII_DOMAIN_BOUNDARIES.md Cross-Domain Rule). Snapshotted onto the
    // order now, per Gap G-1, so a later change to the customer's policy
    // never retroactively alters an already-in-flight order's chain.
    const workflowPolicy = await this.customers.getWorkflowPolicySnapshot(customerId, manager);
    // Gap G-3 — which Price List (if any) this customer's lines should
    // resolve prices against. Same snapshot timing/discipline as
    // `workflowPolicy` above: read once, up front, never re-resolved
    // later if the customer's assignment changes after this order exists.
    const customerPriceListId = await this.customers.getPriceListId(customerId, manager);

    // Read Commerce's published contract BEFORE opening our own write
    // transaction — Sales Orders never touches Product's table directly
    // (DAII_DOMAIN_BOUNDARIES.md Cross-Domain Rule). These are reads of a
    // price snapshot, not a write Sales Orders needs to coordinate
    // transactionally with Commerce.
    let totalAmount = 0;
    const lineInputs: ResolvedLineInput[] = [];
    for (const line of lines) {
      const resolved = await this.resolveLineInput(line, customerPriceListId, actorCanSetManagerPrice, manager);
      totalAmount += Number(resolved.lineTotal);
      lineInputs.push(resolved);
    }

    const order = await (manager ?? this.dataSource).transaction(async (txManager) => {
      const lineRepo = txManager.getRepository(SalesOrderLine);
      const orderRepo = txManager.getRepository(SalesOrder);

      const lineEntities = lineInputs.map((input) => lineRepo.create(input));

      const savedOrder = await orderRepo.save(
        orderRepo.create({
          orderNumber,
          customerId,
          salesRepUserId,
          totalAmount: totalAmount.toFixed(2),
          workflowPolicy,
          repSequenceNumber,
          createdByUserId: actorUserId,
          warehouseId,
          branchOrgUnitId,
          shippingMethod,
          skipDeposit,
        }),
      );
      for (const lineEntity of lineEntities) {
        lineEntity.salesOrderId = savedOrder.id;
      }
      await lineRepo.save(lineEntities);

      // CTO directive ("PRIORITY 2 — STOCK AVAILABILITY"): reserve every
      // line's stock in THIS SAME transaction, not a later step — reuses
      // InventoryService's existing advisory-lock reservation exactly
      // (`reserveStockInTransaction`, the manager-composable twin of the
      // already-proven `reserveStock`), so an insufficient-stock line
      // rolls back the ENTIRE order (order row, every line, every
      // reservation already inserted this transaction) — never a
      // partially-created order (TEST E: "no partial order posting/
      // reservation must occur"). This is the same lock+check+insert
      // `reserveStock` already used for the later "Reserve Stock" screen
      // step — that screen still works unchanged afterward, it just finds
      // every line already reserved from here on (see ReserveStockPanel).
      //
      // Preliminary Hold (CTO directive §5): a `standard`-policy order
      // reserves as `preliminary` — Finance approving the deposit
      // confirms it to `active` (`releaseAfterDepositVerified` below).
      // An `open_account` order has no deposit gate at all (releases on
      // submit), so there is nothing to ever confirm a preliminary hold
      // into — it reserves straight to `active`, same as before this
      // directive, so it can never get stuck waiting for a step that
      // will never happen and expire out from under an already-released order.
      const reservationStatus = workflowPolicy === 'open_account' ? 'active' : 'preliminary';
      for (const line of lineInputs) {
        await this.inventory.reserveStockInTransaction(
          txManager,
          warehouseId,
          line.productId,
          line.quantity,
          savedOrder.id,
          actorUserId,
          reservationStatus,
        );
      }

      return savedOrder;
    });

    await this.processEngine.start(PROCESS_BY_POLICY[workflowPolicy], ENTITY_TYPE, order.id, manager);
    await this.scope.assign(salesRepUserId, ENTITY_TYPE, order.id, manager);

    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'sales.order.created',
        resource: 'sales_order',
        resourceId: order.id,
        result: 'success',
        correlationId: null,
        after: { orderNumber, customerId, totalAmount: order.totalAmount },
      },
      manager,
    );

    return order;
  }

  /**
   * List endpoint backing the operational UI's Sales Orders screen.
   * Same Scope-vs-Role split as `transitionOrder` (§5.1 of the Foundation
   * Contract): a plain sales_rep sees only their own orders (their
   * `salesRepUserId`, the same column Scope was assigned against at
   * creation); a supervisor/manager/admin needs visibility across the
   * whole queue to do their job, so they see every order — the same
   * "qualified role, not per-resource assignment" boundary already
   * governing the review actions themselves.
   */
  /** Area 21 Operational Company Scoping Retrofit (2026-09-27): `manager?` added. */
  async listOrders(actorUserId: string, manager?: EntityManager, visibleWarehouseIds?: string[], actorAccess?: WorkflowAccess): Promise<SalesOrder[]> {
    const access = actorAccess ?? (await this.authorization.workflowAccess(actorUserId, manager));
    // REAL BUG FOUND LIVE (CTO directive — Fulfillment dashboard rework):
    // `warehouse_worker` was never in this "sees everything" set, so a
    // real fulfillment operator opening the Fulfillment screen's
    // released-order picker got an EMPTY list every time — `salesRepUserId
    // === actorUserId` can never match a warehouse worker, who is never a
    // sales rep. Fulfillment.tsx already assumed broad visibility
    // (`GET /sales-orders` with no rep filter); the server just never
    // actually granted it.
    const isReviewerOrAdmin = access.allows('sales.order.list_all');
    const repo = (manager ?? this.dataSource).getRepository(SalesOrder);
    const inScope = this.warehouseVisibility(visibleWarehouseIds);
    if (isReviewerOrAdmin) {
      return repo.find({ where: inScope, order: { createdAt: 'DESC' } });
    }
    return repo.find({ where: { salesRepUserId: actorUserId, ...inScope }, order: { createdAt: 'DESC' } });
  }

  /** F6 — an order is in the caller's scope when its warehouse is among their visible ones; an order with NO warehouse (legacy) is unscoped. `undefined` (unrestricted) adds no condition. */
  private warehouseVisibility(visibleWarehouseIds?: string[]): Record<string, unknown> {
    if (!visibleWarehouseIds) return {};
    return { warehouseId: Raw((col) => `(${col} IS NULL OR ${col} = ANY(:visible))`, { visible: visibleWarehouseIds }) };
  }

  /**
   * Pagination audit fix (MASTER_PROJECT_STATUS.md §6 — `listOrders`'s
   * `repo.find()` above was one of 5 confirmed-unbounded list endpoints).
   * `listOrders` itself is deliberately left unpaginated — ReportsService,
   * CustomerAccountsService, and the Fulfillment released-order picker all
   * need the FULL visible set (a KPI count, a per-customer filter, or a
   * "every order this worker may act on" list — none of them page-shaped).
   * This take/skip-bounded sibling backs the operational Sales Orders
   * screen's own table specifically; same Scope-vs-Role visibility split
   * as `listOrders`.
   */
  async listOrdersPage(actorUserId: string, options: { page: number; pageSize: number; visibleWarehouseIds?: string[] }, manager?: EntityManager, actorAccess?: WorkflowAccess): Promise<{ rows: SalesOrder[]; total: number }> {
    const access = actorAccess ?? (await this.authorization.workflowAccess(actorUserId, manager));
    const isReviewerOrAdmin = access.allows('sales.order.list_all');
    const repo = (manager ?? this.dataSource).getRepository(SalesOrder);
    const [rows, total] = await repo.findAndCount({
      where: isReviewerOrAdmin ? this.warehouseVisibility(options.visibleWarehouseIds) : { salesRepUserId: actorUserId, ...this.warehouseVisibility(options.visibleWarehouseIds) },
      order: { createdAt: 'DESC' },
      take: options.pageSize,
      skip: (options.page - 1) * options.pageSize,
    });
    return { rows, total };
  }

  /**
   * Same Scope-vs-Role split as `listOrders`/`transitionOrder` (Foundation
   * Contract §5.1) — found here BEFORE it could ship as a live bug (the
   * original browser demo cycle never called this as a reviewer, only
   * `transitionOrder` directly, so this exact same gap sat latent until
   * the operational UI's order-detail screen needed it).
   */
  async getOrder(orderId: string, requestingUserId: string, manager?: EntityManager, actorAccess?: WorkflowAccess): Promise<SalesOrder> {
    const access = actorAccess ?? (await this.authorization.workflowAccess(requestingUserId, manager));
    // warehouse_worker included for the same reason as listOrders above —
    // a fulfillment operator needs to open an order's detail from the
    // Fulfillment dashboard even though Scope was only ever granted to
    // the owning sales rep.
    //
    // finance: REAL BUG FOUND LIVE (Post-Deposit-Approval Edit Control
    // verification, CTO directive §1) — `DepositsController.approve` is
    // `@RequireRole('admin', 'finance')`, but `DepositsService.approveDeposit`
    // calls this method internally, and `finance` was never in this
    // "sees everything" set. A finance user got a bare 404 approving a
    // real, pending deposit on any order they weren't individually
    // Scope-assigned to (i.e. almost all of them, since finance isn't
    // normally assigned to individual sales orders) — even though the
    // route's own role gate said they were allowed. Same "qualified role,
    // not per-resource assignment" fix as warehouse_worker above, kept
    // local here rather than widening `ScopeService.UNRESTRICTED_ROLES`
    // (see `customers.service.ts`'s `REVIEWER_ROLES` comment for why).
    const isReviewerOrAdmin = access.allows('sales.order.read_any');
    if (!isReviewerOrAdmin) {
      await this.scope.assertAccess(requestingUserId, ENTITY_TYPE, orderId, manager);
    }
    const order = await (manager ?? this.dataSource).getRepository(SalesOrder).findOne({ where: { id: orderId } });
    if (!order) throw new NotFoundException(`Sales order "${orderId}" not found.`);
    return order;
  }

  /**
   * Backs the order detail screen — the same Scope/Role authorization as
   * `getOrder` (delegated to it directly, not re-derived), enriched with
   * the customer's name/phone and the resolved rep/creator names a
   * screen showing raw UUIDs is useless without (CTO instruction: "يجب
   * اضافة اسم العميل ورقم تلفونه والمندوب المسؤل والشخص الذى انشاء
   * الاوردر"). `customerAddress`/`customerGovernorate` added for the
   * Fulfillment dashboard's "New Order" screen (CTO directive — shipping
   * prep needs the address/region up front, not discovered later).
   * Cross-domain reads only, via each domain's own published snapshot
   * contract (`CustomersService.getCustomerSnapshot`, `UsersService.
   * findById`) — never a direct query into CRM's or Identity's tables.
   */
  async getOrderDetailView(orderId: string, requestingUserId: string, manager?: EntityManager, actorAccess?: WorkflowAccess): Promise<
    SalesOrder & {
      customerName: string | null;
      customerPhone: string | null;
      customerAddress: string | null;
      customerGovernorate: string | null;
      salesRepName: string | null;
      createdByName: string | null;
      warehouseName: string | null;
    }
  > {
    const order = await this.getOrder(orderId, requestingUserId, manager, actorAccess);
    const [customer, salesRep, createdBy, warehouse] = await Promise.all([
      this.customers.getCustomerSnapshot(order.customerId, manager),
      this.safeFindUser(order.salesRepUserId),
      this.safeFindUser(order.createdByUserId),
      order.warehouseId ? this.inventory.getWarehouse(order.warehouseId, manager).catch(() => null) : null,
    ]);
    return {
      ...order,
      customerName: customer?.name ?? null,
      customerPhone: customer?.phone ?? null,
      customerAddress: customer?.address ?? null,
      customerGovernorate: customer?.governorate ?? null,
      salesRepName: salesRep?.fullName ?? null,
      createdByName: createdBy?.fullName ?? null,
      warehouseName: warehouse ? `${warehouse.code} — ${warehouse.name}` : null,
    };
  }

  /**
   * Cross-domain read contract (same pattern as `CustomersService.
   * getCustomerSnapshot`) — used by Delivery's Treasury-remittance bridge
   * (CTO directive — "Shipping Company Settlement → Treasury/Financial
   * Posting") to resolve a Sales Order's `customerId` without going
   * through the Scope-gated `getOrder` (a finance/admin actor posting a
   * remittance was never granted per-order Scope, same reason
   * `getCustomerSnapshot` is itself unscoped).
   */
  async getOrderSnapshot(orderId: string, manager?: EntityManager): Promise<{ id: string; orderNumber: string; customerId: string; salesRepUserId: string; totalAmount: string; branchOrgUnitId: string | null } | null> {
    const order = await (manager ?? this.dataSource).getRepository(SalesOrder).findOne({ where: { id: orderId } });
    if (!order) return null;
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      customerId: order.customerId,
      salesRepUserId: order.salesRepUserId,
      totalAmount: order.totalAmount,
      branchOrgUnitId: order.branchOrgUnitId ?? null,
    };
  }

  async getOrderLines(orderId: string, manager?: EntityManager): Promise<SalesOrderLine[]> {
    return (manager ?? this.dataSource).getRepository(SalesOrderLine).find({ where: { salesOrderId: orderId } });
  }

  /** Returns Engine cross-domain read (never a direct query into another domain's table) — a single line by id, needed to price a Return Credit off its own historical unitPrice/discountAmount, never the product's current price. */
  async getOrderLineById(lineId: string, manager?: EntityManager): Promise<SalesOrderLine | null> {
    return (manager ?? this.dataSource).getRepository(SalesOrderLine).findOne({ where: { id: lineId } });
  }

  async getOrderStatus(orderId: string, manager?: EntityManager): Promise<string> {
    const { definition } = await this.getOrderAndDefinition(orderId, manager);
    return this.processEngine.getState(definition, ENTITY_TYPE, orderId, manager);
  }

  /**
   * Sales Return "All Orders" eligibility (CTO directive, 2026-09-16).
   * Real join over THIS customer's own orders/lines — a product is never
   * offered just because it exists in the catalog. `anchorDate` is
   * `SalesOrder.createdAt` (V1 disclosed fallback — see the contract's
   * own doc comment); the window itself (`[returnDate - windowDays,
   * returnDate]`) is computed by the CALLER from a config key, never
   * hardcoded here.
   */
  async findEligibleReturnPurchaseLines(
    customerId: string,
    returnDate: Date,
    windowDays: number,
    manager?: EntityManager,
  ): Promise<
    Array<{
      salesOrderId: string;
      orderNumber: string;
      salesOrderLineId: string;
      productId: string;
      originalQuantity: number;
      originalUnitPrice: string;
      anchorDate: Date;
    }>
  > {
    const windowStart = new Date(returnDate);
    windowStart.setUTCDate(windowStart.getUTCDate() - windowDays);

    // Historical Requirements Audit (2026-09-17) — a real bug found live: `returnDate` arrives as
    // the calendar day's UTC midnight instant (the client sends a plain `YYYY-MM-DD` date, parsed
    // to 00:00:00.000Z), so a same-day purchase made LATER that same day (any time after midnight)
    // failed `o.createdAt <= returnDate` and was wrongly excluded from "today" eligibility — a
    // customer could never return something they bought earlier the same day. The upper bound must
    // mean "through the end of `returnDate`'s calendar day", not the exact instant it was parsed to.
    const returnDateEnd = new Date(returnDate);
    returnDateEnd.setUTCHours(23, 59, 59, 999);

    const orders = await (manager ?? this.dataSource).getRepository(SalesOrder).find({
      where: { customerId },
    });
    const eligibleOrders = orders.filter((o) => o.createdAt >= windowStart && o.createdAt <= returnDateEnd);
    if (eligibleOrders.length === 0) return [];

    const orderById = new Map(eligibleOrders.map((o) => [o.id, o]));
    const lines = await (manager ?? this.dataSource)
      .getRepository(SalesOrderLine)
      .find({ where: eligibleOrders.map((o) => ({ salesOrderId: o.id })) });

    return lines.map((line) => {
      const order = orderById.get(line.salesOrderId)!;
      return {
        salesOrderId: order.id,
        orderNumber: order.orderNumber,
        salesOrderLineId: line.id,
        productId: line.productId,
        originalQuantity: line.quantity,
        originalUnitPrice: line.unitPrice,
        anchorDate: order.createdAt,
      };
    });
  }

  /**
   * Order Edit During Review (CTO directive §1). Only reachable while
   * the order sits in a stage `STAGE_EDIT_ROLES` covers, and only by a
   * caller holding that stage's own role (admin always passes, same
   * convention as every other role gate in this service) — a supervisor
   * edits during supervisor_review, a manager during manager_approval,
   * never both, never any other stage.
   *
   * Price re-resolution deliberately does NOT re-fetch the customer's
   * CURRENT price list (that would violate the non-retroactivity
   * guarantee `createOrder` already establishes) — it reuses this
   * line's own already-snapshotted `priceListPrice` as the baseline the
   * manager/rep override chain starts from, exactly as it did at
   * creation, just re-evaluated against the NEW quantity/overrides.
   *
   * Quantity changes re-validate stock atomically
   * (`InventoryService.adjustReservationQuantityInTransaction` — same
   * advisory-lock discipline as order creation): if the new quantity
   * isn't available, the entire edit is rejected and nothing changes,
   * including any OTHER line in the same request.
   */
  async updateOrderLines(orderId: string, lineUpdates: UpdateOrderLineInput[], actorUserId: string, reason?: string | null, manager?: EntityManager, actorAccess?: WorkflowAccess): Promise<SalesOrder> {
    if (lineUpdates.length === 0) throw new BadRequestException('At least one line update is required.');

    const { order } = await this.getOrderAndDefinition(orderId, manager);
    const currentState = await this.getOrderStatus(orderId, manager);
    const requiredRoles = STAGE_EDIT_ROLES[currentState];
    const editRule = STAGE_EDIT_RULES[currentState];
    if (!requiredRoles || !editRule) {
      throw new ConflictException(`This order cannot be edited while it is in status "${currentState}".`);
    }
    const access = actorAccess ?? (await this.authorization.workflowAccess(actorUserId, manager));
    if (!access.allows(editRule)) {
      throw new ForbiddenException(`Role required to edit an order in status "${currentState}": one of [${requiredRoles.join(', ')}].`);
    }
    const trimmedReason = reason?.trim() || null;
    if (REASON_REQUIRED_STAGES.has(currentState) && !trimmedReason) {
      throw new BadRequestException(`A reason is required to edit an order in status "${currentState}".`);
    }
    const actorCanSetManagerPrice = access.allows('sales.order.set_manager_price');

    const lineRepo = (manager ?? this.dataSource).getRepository(SalesOrderLine);
    const existingLines = await lineRepo.find({ where: { salesOrderId: orderId } });
    const existingById = new Map(existingLines.map((l) => [l.id, l]));
    for (const update of lineUpdates) {
      if (!existingById.has(update.lineId) || existingById.get(update.lineId)!.salesOrderId !== orderId) {
        throw new NotFoundException(`Order line "${update.lineId}" not found on order "${orderId}".`);
      }
    }

    const auditChanges: Array<{ lineId: string; productId: string; changes: Record<string, { before: string | number | null; after: string | number | null }> }> = [];

    await (manager ?? this.dataSource).transaction(async (txManager) => {
      const txLineRepo = txManager.getRepository(SalesOrderLine);
      const txOrderRepo = txManager.getRepository(SalesOrder);

      for (const update of lineUpdates) {
        const existingLine = existingById.get(update.lineId)!;
        const recomputed = this.recomputeEditedLine(existingLine, update, actorCanSetManagerPrice);

        const changes: Record<string, { before: string | number | null; after: string | number | null }> = {};
        if (existingLine.quantity !== update.quantity) changes.quantity = { before: existingLine.quantity, after: update.quantity };
        if (existingLine.unitPrice !== recomputed.unitPrice) changes.unitPrice = { before: existingLine.unitPrice, after: recomputed.unitPrice };
        if ((existingLine.repPrice ?? null) !== recomputed.repPrice) changes.repPrice = { before: existingLine.repPrice, after: recomputed.repPrice };
        if ((existingLine.managerPrice ?? null) !== recomputed.managerPrice) changes.managerPrice = { before: existingLine.managerPrice, after: recomputed.managerPrice };
        if (existingLine.discountAmount !== recomputed.discountAmount) changes.discountAmount = { before: existingLine.discountAmount, after: recomputed.discountAmount };

        if (Object.keys(changes).length > 0) {
          auditChanges.push({ lineId: existingLine.id, productId: existingLine.productId, changes });
        }

        if (existingLine.quantity !== update.quantity) {
          await this.inventory.adjustReservationQuantityInTransaction(
            txManager,
            order.warehouseId!,
            existingLine.productId,
            orderId,
            update.quantity,
            actorUserId,
          );
        }

        existingLine.quantity = update.quantity;
        existingLine.unitPrice = recomputed.unitPrice;
        existingLine.repPrice = recomputed.repPrice;
        existingLine.managerPrice = recomputed.managerPrice;
        existingLine.discountAmount = recomputed.discountAmount;
        existingLine.lineTotal = recomputed.lineTotal;
        await txLineRepo.save(existingLine);
      }

      const allLines = await txLineRepo.find({ where: { salesOrderId: orderId } });
      const newTotal = allLines.reduce((sum, l) => sum + Number(l.lineTotal), 0);
      const orderToSave = await txOrderRepo.findOne({ where: { id: orderId } });
      orderToSave!.totalAmount = newTotal.toFixed(2);
      await txOrderRepo.save(orderToSave!);
    });

    // Order Audit History (CTO directive §1: "من قام بالتعديل / التاريخ
    // والوقت / الحقول المعدلة / القيمة القديمة / القيمة الجديدة / سبب
    // التعديل إن كان مطلوبًا") — one audit record per changed FIELD per
    // line, not one opaque "order.updated" blob, so the trail is
    // genuinely reviewable later. Post-Deposit-Approval edits (currentState
    // === 'released') get a distinct action string and carry `reason`, so
    // a history view can tell "review-stage edit" apart from "admin/finance
    // post-release edit" without parsing editedDuringStatus.
    const auditAction = currentState === 'released' ? 'sales.order.post_release_edit' : 'sales.order.line_edited';
    for (const entry of auditChanges) {
      for (const [field, { before, after }] of Object.entries(entry.changes)) {
        await this.audit.record(
          {
            actorUserId,
            organizationId: null,
            action: auditAction,
            resource: 'sales_order_line',
            resourceId: entry.lineId,
            result: 'success',
            correlationId: null,
            before: { field, value: before },
            after: {
              field,
              value: after,
              salesOrderId: orderId,
              productId: entry.productId,
              editedDuringStatus: currentState,
              ...(trimmedReason ? { reason: trimmedReason } : {}),
            },
          },
          manager,
        );
      }
    }

    const updated = await (manager ?? this.dataSource).getRepository(SalesOrder).findOne({ where: { id: orderId } });
    return updated!;
  }

  /**
   * Order Edit History (CTO directive §1) — reads back every per-field
   * line-edit audit record for this order, oldest first. Every row
   * `updateOrderLines` writes already carries `salesOrderId` inside its
   * `after` JSON (`:609` above), so this is a plain filtered read over the
   * existing hash-chained `audit_records` table — no new column, no new
   * ledger. `AuditService` itself exposes `record()` only (write-side); this
   * is this feature's own read, kept local to the one domain that needs it
   * rather than growing `AuditService` into a general-purpose query API.
   */
  async getOrderEditHistory(orderId: string, manager?: EntityManager): Promise<
    Array<{
      seq: number;
      timestamp: Date;
      actorUserId: string | null;
      actorName: string | null;
      action: string;
      lineId: string | null;
      productId: string | null;
      field: string | null;
      before: unknown;
      after: unknown;
      reason: string | null;
      editedDuringStatus: string | null;
    }>
  > {
    interface AuditRowSnapshot {
      field?: string;
      value?: unknown;
      reason?: string;
      productId?: string;
      editedDuringStatus?: string;
    }
    interface AuditRow {
      seq: number | string;
      timestamp: Date;
      actorUserId: string | null;
      action: string;
      resourceId: string | null;
      before: AuditRowSnapshot | null;
      after: AuditRowSnapshot | null;
    }
    const rows: AuditRow[] = await (manager ?? this.dataSource).query(
      `SELECT seq, timestamp, "actorUserId", action, "resourceId", before, after
       FROM audit_records
       WHERE resource = 'sales_order_line' AND after ->> 'salesOrderId' = $1
       ORDER BY seq ASC`,
      [orderId],
    );

    const actorIds: string[] = Array.from(
      new Set(rows.map((r) => r.actorUserId).filter((id): id is string => !!id)),
    );
    const actorNames = new Map<string, string | null>();
    await Promise.all(
      actorIds.map(async (id: string) => {
        const user = await this.safeFindUser(id);
        actorNames.set(id, user?.fullName ?? null);
      }),
    );

    return rows.map((r) => ({
      seq: Number(r.seq),
      timestamp: r.timestamp,
      actorUserId: r.actorUserId,
      actorName: r.actorUserId ? actorNames.get(r.actorUserId) ?? null : null,
      action: r.action,
      lineId: r.resourceId,
      productId: r.after?.productId ?? null,
      field: r.before?.field ?? r.after?.field ?? null,
      before: r.before?.value ?? null,
      after: r.after?.value ?? null,
      reason: r.after?.reason ?? null,
      editedDuringStatus: r.after?.editedDuringStatus ?? null,
    }));
  }

  /**
   * Recompute one edited line's price/total — reuses this line's OWN
   * already-snapshotted `priceListPrice` as the baseline (never
   * re-fetches the customer's current price list; see `updateOrderLines`'s
   * own doc comment for why), then applies the exact same
   * manager > rep > price-list precedence and discount-bound validation
   * `resolveLineInput` uses at creation time — one pricing policy, two
   * entry points, never two implementations.
   */
  private recomputeEditedLine(
    existingLine: SalesOrderLine,
    update: UpdateOrderLineInput,
    actorCanSetManagerPrice: boolean,
  ): { unitPrice: string; repPrice: string | null; managerPrice: string | null; discountAmount: string; lineTotal: string } {
    const parsePrice = (value: string | undefined, fallback: string | null, label: string): string | null => {
      if (value === undefined) return fallback;
      if (value === null || value === '') return null;
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) throw new BadRequestException(`Invalid ${label} for order line "${existingLine.id}".`);
      return n.toFixed(2);
    };

    const repPrice = parsePrice(update.repPrice, existingLine.repPrice, 'rep price');
    const managerPrice = actorCanSetManagerPrice ? parsePrice(update.managerPrice, existingLine.managerPrice, 'manager price') : null;
    const priceListAdjustedPrice = existingLine.priceListPrice ?? existingLine.listPrice;
    const unitPrice = managerPrice ?? repPrice ?? priceListAdjustedPrice;

    const grossLineTotal = Number(unitPrice) * update.quantity;
    const discountAmount = update.discountAmount !== undefined ? Number(update.discountAmount) : Number(existingLine.discountAmount);
    if (!Number.isFinite(discountAmount) || discountAmount < 0) {
      throw new BadRequestException(`Invalid discount for order line "${existingLine.id}".`);
    }
    if (discountAmount > grossLineTotal) {
      throw new BadRequestException(`Discount for order line "${existingLine.id}" cannot exceed the line's total (${grossLineTotal.toFixed(2)}).`);
    }

    return {
      unitPrice,
      repPrice,
      managerPrice,
      discountAmount: discountAmount.toFixed(2),
      lineTotal: (grossLineTotal - discountAmount).toFixed(2),
    };
  }

  /**
   * Order Edit at Draft (CTO directive — the rep's own not-yet-submitted
   * order must be fully editable: add item, remove item, change quantity/
   * price/discount — not just the narrower quantity/price-only edit
   * `updateOrderLines` above offers during supervisor/manager review).
   * Ownership-gated (the order's OWN sales rep, or admin), not role-gated
   * like `STAGE_EDIT_ROLES` — a plain `sales_rep` may never edit a
   * colleague's draft order, only their own.
   *
   * Pricing is re-resolved fresh against the customer's CURRENT price
   * list (`resolveLineInput`, the same path `createOrder` uses) —
   * deliberately NOT `recomputeEditedLine`'s frozen-snapshot approach,
   * because nothing has been submitted/approved yet at draft: there is no
   * non-retroactivity guarantee to protect. Every line's reservation is
   * added/adjusted/released to match, atomically with the line rows
   * themselves — an insufficient-stock line on a newly-added item rolls
   * back the whole edit, same as order creation.
   */
  async editDraftOrder(orderId: string, lines: DraftOrderLineInput[], actorUserId: string, manager?: EntityManager, actorAccess?: WorkflowAccess): Promise<SalesOrder> {
    if (lines.length === 0) throw new BadRequestException('A Sales Order must have at least one line item.');

    const { order } = await this.getOrderAndDefinition(orderId, manager);
    const currentState = await this.getOrderStatus(orderId, manager);
    if (currentState !== 'draft') {
      throw new ConflictException(`This order can only be edited this way while it is in "draft" status (currently "${currentState}").`);
    }
    const access = actorAccess ?? (await this.authorization.workflowAccess(actorUserId, manager));
    if (order.salesRepUserId !== actorUserId && !access.allows('sales.order.edit_any_draft')) {
      throw new ForbiddenException("Only this order's own sales representative (or admin) may edit it while in draft.");
    }
    const actorCanSetManagerPrice = access.allows('sales.order.set_manager_price');
    if (!actorCanSetManagerPrice && lines.some((l) => l.managerPrice !== undefined && l.managerPrice !== null && l.managerPrice !== '')) {
      throw new ForbiddenException('Only a sales manager or admin may set a manager price on an order line.');
    }

    const lineRepo = (manager ?? this.dataSource).getRepository(SalesOrderLine);
    const existingLines = await lineRepo.find({ where: { salesOrderId: orderId } });
    const existingById = new Map(existingLines.map((l) => [l.id, l]));
    for (const input of lines) {
      if (input.lineId && !existingById.has(input.lineId)) {
        throw new NotFoundException(`Order line "${input.lineId}" not found on order "${orderId}".`);
      }
    }
    const keptIds = new Set(lines.filter((l) => l.lineId).map((l) => l.lineId!));
    const removedLines = existingLines.filter((l) => !keptIds.has(l.id));

    const customerPriceListId = await this.customers.getPriceListId(order.customerId, manager);
    const reservationStatus = order.workflowPolicy === 'open_account' ? 'active' : 'preliminary';

    const addedProductIds: string[] = [];
    const removedProductIds = removedLines.map((l) => l.productId);

    await (manager ?? this.dataSource).transaction(async (txManager) => {
      const txLineRepo = txManager.getRepository(SalesOrderLine);
      const txOrderRepo = txManager.getRepository(SalesOrder);

      for (const removed of removedLines) {
        await this.inventory.releaseReservationForOrderProductInTransaction(txManager, removed.productId, orderId, actorUserId);
        await txLineRepo.remove(removed);
      }

      for (const input of lines) {
        const resolved = await this.resolveLineInput(input, customerPriceListId, actorCanSetManagerPrice, txManager);
        if (input.lineId) {
          const existing = existingById.get(input.lineId)!;

          // A rep (or anyone else not manager-authorized) editing OTHER
          // things on this line — quantity, discount, or just adding an
          // unrelated line elsewhere on the order — must never silently
          // strip a manager's already-set price override merely because
          // `resolveLineInput` unconditionally nulls managerPrice for an
          // unauthorized actor (a correct gate against FORGING one, but
          // not against losing an existing one on an unrelated edit).
          if (!actorCanSetManagerPrice && existing.managerPrice) {
            resolved.managerPrice = existing.managerPrice;
            resolved.unitPrice = existing.managerPrice;
            const grossLineTotal = Number(resolved.unitPrice) * resolved.quantity;
            resolved.lineTotal = (grossLineTotal - Number(resolved.discountAmount)).toFixed(2);
          }

          if (existing.quantity !== resolved.quantity) {
            await this.inventory.adjustReservationQuantityInTransaction(txManager, order.warehouseId!, existing.productId, orderId, resolved.quantity, actorUserId);
          }
          existing.quantity = resolved.quantity;
          existing.unitPrice = resolved.unitPrice;
          existing.listPrice = resolved.listPrice;
          existing.priceListId = resolved.priceListId;
          existing.priceListPrice = resolved.priceListPrice;
          existing.repPrice = resolved.repPrice;
          existing.managerPrice = resolved.managerPrice;
          existing.discountAmount = resolved.discountAmount;
          existing.lineTotal = resolved.lineTotal;
          await txLineRepo.save(existing);
        } else {
          await this.inventory.reserveStockInTransaction(txManager, order.warehouseId!, resolved.productId, resolved.quantity, orderId, actorUserId, reservationStatus);
          const newLine = txLineRepo.create({ salesOrderId: orderId, ...resolved });
          await txLineRepo.save(newLine);
          addedProductIds.push(resolved.productId);
        }
      }

      const allLines = await txLineRepo.find({ where: { salesOrderId: orderId } });
      const newTotal = allLines.reduce((sum, l) => sum + Number(l.lineTotal), 0);
      const orderToSave = await txOrderRepo.findOne({ where: { id: orderId } });
      orderToSave!.totalAmount = newTotal.toFixed(2);
      await txOrderRepo.save(orderToSave!);
    });

    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'sales.order.draft_edited',
        resource: 'sales_order',
        resourceId: orderId,
        result: 'success',
        correlationId: null,
        before: { lineCount: existingLines.length },
        after: { lineCount: lines.length, addedProductIds, removedProductIds },
      },
      manager,
    );

    const updated = await (manager ?? this.dataSource).getRepository(SalesOrder).findOne({ where: { id: orderId } });
    return updated!;
  }

  /**
   * Draft Order Deletion (CTO directive §2: "السماح للمندوب بحذف الـDraft
   * الخاص به فقط") — a genuine hard delete, not a status flag: a `draft`
   * order was never posted anywhere (no shipment, no fulfillment, no
   * treasury movement), so the "reversal instead of destructive edits"
   * discipline this platform otherwise enforces for POSTED operational
   * data simply doesn't apply here — this is the same class of operation
   * `editDraftOrder` above already performs per-line (a real `remove()`),
   * just for the whole order at once. Ownership-gated identically to
   * `editDraftOrder` (own rep, or admin), not role-gated.
   *
   * Real risk found while building this (not previously flagged anywhere):
   * `DepositsService.submitDeposit` never checks order status, so a
   * deposit CAN already exist against a still-`draft` order (the
   * "deposit at creation" panel does exactly this). `deposits.salesOrderId`
   * is a NOT NULL FK with no ON DELETE CASCADE — deleting an order with a
   * deposit already recorded against it would otherwise 500 on a raw FK
   * violation. Caught here and translated into a clean, actionable error
   * instead — deliberately NOT done via a reverse `DepositsService`
   * dependency (that would create a circular module import, since
   * `DepositsModule` already imports `SalesOrdersModule`); relying on the
   * database's own already-declared constraint keeps this a one-directional
   * dependency, same as everywhere else in this domain.
   */
  async deleteDraftOrder(orderId: string, actorUserId: string, manager?: EntityManager, actorAccess?: WorkflowAccess): Promise<void> {
    const { order } = await this.getOrderAndDefinition(orderId, manager);
    const currentState = await this.getOrderStatus(orderId, manager);
    if (currentState !== 'draft') {
      throw new ConflictException(`This order can only be deleted while it is in "draft" status (currently "${currentState}").`);
    }
    const access = actorAccess ?? (await this.authorization.workflowAccess(actorUserId, manager));
    if (order.salesRepUserId !== actorUserId && !access.allows('sales.order.delete_any_draft')) {
      throw new ForbiddenException("Only this order's own sales representative (or admin) may delete it while in draft.");
    }

    const lineRepo = (manager ?? this.dataSource).getRepository(SalesOrderLine);
    const existingLines = await lineRepo.find({ where: { salesOrderId: orderId } });

    try {
      await (manager ?? this.dataSource).transaction(async (txManager) => {
        const txLineRepo = txManager.getRepository(SalesOrderLine);
        const txOrderRepo = txManager.getRepository(SalesOrder);

        for (const line of existingLines) {
          await this.inventory.releaseReservationForOrderProductInTransaction(txManager, line.productId, orderId, actorUserId);
        }
        if (existingLines.length > 0) {
          await txLineRepo.remove(existingLines);
        }
        // Every other flow keeps a released/fulfilled StockReservation row as
        // history against its still-existing parent order (soft-status, not
        // hard-delete — the platform's normal "reversal not destruction"
        // discipline). deleteDraftOrder is the one deliberate exception that
        // hard-deletes the parent order itself, so a reservation this method
        // just released has nothing left to be history FOR — leaving the row
        // behind only produces an orphan referencing a deleted salesOrderId
        // (real gap found live during a release-readiness DB integrity sweep:
        // 3 such orphans, plus their matching orphaned `process_instances`
        // rows, existed in the dev database). Delete both here instead.
        await txManager.query('DELETE FROM stock_reservations WHERE "salesOrderId" = $1', [orderId]);
        await txManager.query('DELETE FROM process_instances WHERE "entityType" = $1 AND "entityId" = $2', ['sales_order', orderId]);
        await txOrderRepo.remove(order);
      });
    } catch (err) {
      if ((err as { code?: string })?.code === '23503') {
        throw new ConflictException('Cannot delete an order that already has a deposit recorded against it.');
      }
      throw err;
    }

    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'sales.order.deleted',
        resource: 'sales_order',
        resourceId: orderId,
        result: 'success',
        correlationId: null,
        before: { orderNumber: order.orderNumber, customerId: order.customerId, lineCount: existingLines.length },
        after: null,
      },
      manager,
    );
  }

  /**
   * The single entry point for every workflow action (submit, approve,
   * reject, resubmit) — role-gated per ORDER_ACTION_REQUIRED_ROLES,
   * scope-checked, then delegated to the generic Process Engine, using
   * whichever Process Definition this order's snapshotted `workflowPolicy`
   * resolves to (Gap G-1). `submit` additionally auto-advances: straight
   * into supervisor_review for a 'standard' order (blueprint §14: one
   * client action, "Submit for Review"), or straight to 'released' for an
   * 'open_account' order (no review, no deposit gate).
   */
  async transitionOrder(orderId: string, action: string, actorUserId: string, manager?: EntityManager, actorAccess?: WorkflowAccess): Promise<string> {
    // Scope is enforced only for the originating rep's own actions
    // (submit/resubmit) — NOT for supervisor/manager review actions.
    // REAL GAP FOUND DURING LIVE E2E VERIFICATION (not caught by unit
    // tests, which never modeled a second actor reviewing a resource
    // the first actor was scoped to): Scope Engine has no team-hierarchy
    // resolution (Stage 1's own disclosed gap, DAII_PLATFORM_FOUNDATION_CONTRACT.md
    // §5 — "no direct source... built fresh, informed by manager-scope-
    // resolution logic" that was never actually wired up here). Requiring
    // per-order Scope for a supervisor/manager would mean only the one
    // supervisor explicitly assigned to a resource could ever review it,
    // which blueprint's V1 flow (§14) doesn't ask for — any qualified
    // supervisor/manager may review any order in that stage. The ROLE
    // gate below is the real, correct security boundary for these two
    // actions; Scope remains enforced on every other order operation
    // (getOrder, submit, resubmit — the rep's own actions).
    // V1 Release Audit MEDIUM fix — default-deny: 'start_review',
    // 'auto_release', and 'verify_deposit' are internal-only transitions
    // this service fires itself (via direct processEngine.transition
    // calls below and in confirmDeposit), never meant to be client-
    // reachable ('verify_deposit' fires from releaseAfterDepositVerified,
    // called only by DepositService). An action with no
    // ORDER_ACTION_REQUIRED_ROLES entry used to skip the role check
    // entirely instead of being rejected,
    // letting any authenticated user force one of those transitions
    // directly — e.g. releasing a 'standard'-policy order with no
    // supervisor/manager/deposit review.
    const requiredRoles = ORDER_ACTION_REQUIRED_ROLES[action];
    if (!requiredRoles) {
      throw new ForbiddenException(`"${action}" is not a valid client-initiated action.`);
    }

    const REP_OWN_ACTIONS = new Set(['submit', 'resubmit']);
    if (REP_OWN_ACTIONS.has(action)) {
      await this.scope.assertAccess(actorUserId, ENTITY_TYPE, orderId, manager);
    }

    const access = actorAccess ?? (await this.authorization.workflowAccess(actorUserId, manager));
    if (!access.allows(ORDER_ACTION_RULES[action])) {
      throw new ForbiddenException(`Role required for action "${action}": one of [${requiredRoles.join(', ')}].`);
    }

    const { order, definition } = await this.getOrderAndDefinition(orderId, manager);
    await this.processEngine.transition(definition, ENTITY_TYPE, orderId, action, actorUserId, manager);

    if (action === 'submit') {
      // Auto-advance past the submitted state — this is a system
      // transition, not a second client action, so it bypasses the role
      // gate above (there is no ORDER_ACTION_REQUIRED_ROLES entry for
      // either follow-up action). Which action fires depends on the
      // order's own snapshotted policy, never on anything the caller
      // supplies (Gap G-1) — a 'standard' order still needs a human
      // supervisor/manager/deposit review; an 'open_account' order
      // releases immediately.
      const autoAdvanceAction = order.workflowPolicy === 'open_account' ? 'auto_release' : 'start_review';
      await this.processEngine.transition(definition, ENTITY_TYPE, orderId, autoAdvanceAction, actorUserId, manager);
    }

    // Hotfix 6 (post-v1.0.2, "Create Sales Order Without a Deposit") —
    // same auto-advance shape as the `submit` block above: a system
    // transition immediately following the human `manager_approve`
    // action, not a second client-initiated action (no
    // `ORDER_ACTION_REQUIRED_ROLES` entry for `manager_approve_no_deposit`,
    // so it's unreachable as a direct client call). Confirm the
    // preliminary stock holds the same way `releaseAfterDepositVerified`
    // does for a normal deposit-approved order — BEFORE the engine
    // transition, same validate-before-commit ordering used throughout
    // this domain — so a no-deposit order is fulfillable exactly like any
    // other released order, not left stuck on a stale preliminary hold.
    if (action === 'manager_approve' && order.skipDeposit) {
      await this.inventory.confirmReservationsForOrder(orderId, actorUserId, manager);
      await this.processEngine.transition(definition, ENTITY_TYPE, orderId, 'manager_approve_no_deposit', actorUserId, manager);
    }

    const newState = await this.getOrderStatus(orderId, manager);

    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: `sales.order.${action}`,
        resource: 'sales_order',
        resourceId: orderId,
        result: 'success',
        correlationId: null,
        after: { state: newState },
      },
      manager,
    );

    return newState;
  }

  /**
   * Called only by DepositService, after its own approval logic — never a
   * raw client action. Only ever reached for a 'standard'-policy order
   * (an 'open_account' order never enters `deposit_verification` in the
   * first place — see `SALES_ORDER_OPEN_ACCOUNT_PROCESS`); still resolved
   * through `getOrderAndDefinition` rather than hardcoded, so this stays
   * correct even if a future policy variant reintroduces a deposit step.
   *
   * Preliminary Hold -> Reserved (CTO directive §6) happens here, before
   * the Process Engine transition — the same validate-before-commit
   * ordering used throughout this directive's work.
   */
  async releaseAfterDepositVerified(orderId: string, actorUserId: string | null, manager?: EntityManager): Promise<string> {
    await this.inventory.confirmReservationsForOrder(orderId, actorUserId, manager);
    const { definition } = await this.getOrderAndDefinition(orderId, manager);
    await this.processEngine.transition(definition, ENTITY_TYPE, orderId, 'verify_deposit', actorUserId, manager);
    return this.getOrderStatus(orderId, manager);
  }

  /**
   * Preliminary Hold Timeout (CTO directive §7) — orchestrates the two
   * halves that must happen together when a hold ages out: release the
   * stock (Inventory's job) and move the order back to `draft` (this
   * domain's job, since only it knows the order's process definition).
   * Called only by `PreliminaryHoldExpiryScheduler`, on its own 24-hour
   * poll — never a client action, and not reachable through
   * `transitionOrder` (no `ORDER_ACTION_REQUIRED_ROLES` entry for
   * `expire_hold`, so that endpoint's default-deny already rejects it).
   * If the order already progressed past its hold (e.g. deposit was
   * approved in the same window the scheduler was scanning), the
   * `expire_hold` transition simply won't be valid from its current
   * state and is skipped — never forces an already-advanced order backward.
   */
  /** Multi-Company Area 9 (2026-09-22) — `manager?` added so `PreliminaryHoldExpiryScheduler` can run this against a Company's own connection instead of the ambient one; forwarded to every DB touchpoint below. Omitted, this is unchanged for every existing (ambient) caller. */
  async expireHoldForOrder(orderId: string, actorUserId: string | null, manager?: EntityManager): Promise<void> {
    await this.inventory.releasePreliminaryHoldsForOrder(
      orderId,
      actorUserId,
      'Preliminary hold expired after 24 hours with no deposit approval.',
      manager,
    );

    const { definition } = await this.getOrderAndDefinition(orderId, manager);
    const currentState = await this.getOrderStatus(orderId, manager);
    const canExpire = definition.transitions.some((t) => t.from === currentState && t.action === 'expire_hold');
    if (!canExpire) return; // already released or otherwise past the point where a hold timeout still applies

    await this.processEngine.transition(definition, ENTITY_TYPE, orderId, 'expire_hold', actorUserId, manager);

    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'sales.order.hold_expired',
        resource: 'sales_order',
        resourceId: orderId,
        result: 'success',
        correlationId: null,
        before: { status: currentState },
        after: { status: 'draft' },
      },
      manager,
    );
  }
}
