import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { OrderWorkflowPolicy } from '../../crm/domain/order-workflow-policy';
import { ShippingMethod } from '../domain/shipping-method';

/**
 * Sales Orders — Stage 2 build-order item 24. Daii/architecture/DAII_DOMAIN_BOUNDARIES.md §4, ADR-008.
 *
 * Deliberately has NO status column — the Process Engine's
 * ProcessInstance (definitionKey='sales_order_approval' or
 * 'sales_order_open_account', per `workflowPolicy` below) is the single
 * source of truth for order status, per the "one owner of state"
 * principle. Denormalizing status here would create a sync-bug class
 * this design avoids entirely, not just mitigates.
 */
@Entity('sales_orders')
export class SalesOrder {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  orderNumber!: string;

  @Index()
  @Column('uuid')
  customerId!: string;

  @Index()
  @Column('uuid')
  salesRepUserId!: string;

  /** Always server-computed from line totals at creation time — never trusted from the client (ADR-008 design reference: baseline's sales-order-engine). */
  @Column({ type: 'numeric', precision: 14, scale: 2 })
  totalAmount!: string;

  /**
   * Snapshotted from `Customer.orderWorkflowPolicy` at creation time (same
   * snapshot discipline as line `unitPrice`) — a later change to the
   * customer's policy must never retroactively alter which approval chain
   * an already-in-flight order is running. Selects which Process
   * Definition (`process-definition.ts`) governs this order's state.
   */
  @Column({ type: 'varchar', length: 16, default: 'standard' })
  workflowPolicy!: OrderWorkflowPolicy;

  /**
   * CTO instruction: "امر البيع يبتدئ اولا بكود المندوب... ثم خانه لرقم
   * الاوردر ويكون مسلسل خاص بالمندوب" — a per-rep sequential order
   * number (1, 2, 3... for THIS rep only), distinct from `orderNumber`
   * (the globally-unique `SO-YYYY-######` the Numbering Engine already
   * issues, which stays unchanged and remains the order's real
   * identity). Computed via the same Numbering Engine, keyed per rep
   * (`sales_order_rep_<salesRepUserId>`) — reuses its existing
   * row-locked concurrency guarantee rather than a new COUNT-based
   * scheme that could race under concurrent creation.
   */
  @Column({ type: 'int' })
  repSequenceNumber!: number;

  /**
   * Who actually clicked "create" — distinct from `salesRepUserId` (whose
   * order this is) since a sales_manager/admin may now create an order
   * under a DIFFERENT rep's name (the only way a `managerPrice` can ever
   * be set — see `SalesOrdersService.createOrder`). Nullable only
   * because `actorUserId` itself is `string | null` at the call site
   * (the QR integration's order intake passes `null` — no human actor).
   */
  @Column({ type: 'uuid', nullable: true })
  createdByUserId!: string | null;

  /**
   * CTO directive ("PRIORITY 2 — STOCK AVAILABILITY"): every line's stock
   * is reserved atomically at order-CREATION time (not deferred to a
   * later "Reserve Stock" step — see `SalesOrdersService.createOrder`),
   * reusing `InventoryService.reserveStock`'s existing advisory-lock
   * concurrency guarantee. A single warehouse per order, same V1
   * constraint `ReserveStockPanel`/`FulfillmentService` already enforce
   * ("a single fulfillment order can't span warehouses"). Nullable only
   * for orders created before this column existed — every order created
   * from here on always has one (validated in the service).
   */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  warehouseId!: string | null;

  /**
   * CTO directive §2 — how this order's goods leave the warehouse (company
   * vehicles vs. a shipping company), chosen at creation, shown on the
   * order header. Nullable only for orders created before this column
   * existed (same "degrades to null/—" precedent as `createdByUserId`
   * above) — required at the application layer for every new order.
   */
  @Column({ type: 'varchar', length: 20, nullable: true })
  shippingMethod!: ShippingMethod | null;

  /**
   * Hotfix 6 (post-v1.0.2) — "Create Sales Order Without a Deposit". Set
   * only at creation, never changed after (a decision made once, not a
   * later toggle). When true, `SalesOrdersService.transitionOrder` auto-
   * advances straight from `manager_approval` to `released` on
   * `manager_approve` instead of landing in `deposit_verification` — see
   * `manager_approve_no_deposit` in `process-definition.ts`. Supervisor
   * and Manager approval are completely unaffected either way; only the
   * Finance deposit-approval step is skipped, and only because there is
   * genuinely no deposit to approve.
   */
  @Column({ type: 'boolean', default: false })
  skipDeposit!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
