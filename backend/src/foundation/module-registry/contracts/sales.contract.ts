/**
 * P4 Tranche-2 decoupling (ADR-027, MODULE_DEPENDENCY_CONTRACT.md §3,
 * F-MOD-1/F-MOD-2). The `sales` module's public surface for other modules.
 * Importing modules depend on these interfaces + tokens, never on
 * `commerce/crm/sales-orders`'s `application/*.service.ts` directly — that
 * is the entire mechanism that breaks the compile-time cross-module
 * import graph without changing runtime behaviour (same concrete
 * service, same method calls, just resolved via DI token).
 *
 * CORRECTION (P4 Task 2 verification, 2026-09-06): an earlier version of
 * this file imported `ProductSnapshot`/`BomComponentInput` directly from
 * `domains/commerce/application/*` on the theory that a type-only import
 * of a DTO doesn't create the coupling ADR-006/027 forbid. `npm run lint`
 * proved that theory wrong for this codebase's actual enforcement:
 * `eslint.config.mjs`'s `no-restricted-imports` blocks ANY import —
 * type-only included — matching `**\/domains/*\/{domain,application,
 * infrastructure}/**`, with no carve-out for "published DTO" files (its
 * own doc comment concedes this is a known, intentionally strict
 * limitation, not yet refined with path aliases). Fixed by redeclaring
 * each shape locally instead of importing it — structurally identical
 * (TypeScript is structural, not nominal, so this is a zero-behavior-
 * change fix), verified by `implements` still compiling clean on both
 * `ProductsService` and `BomService` (Task 2 contract-conformance check).
 */

export interface ProductSnapshotContract {
  id: string;
  sku: string;
  name: string;
  unitPrice: string;
  status: 'draft' | 'active' | 'discontinued';
}

export interface SalesProductsContract {
  getProductSnapshot(productId: string): Promise<ProductSnapshotContract | null>;
  getProductSnapshotBySku(sku: string): Promise<ProductSnapshotContract | null>;
  listAllProducts(): Promise<Array<{ id: string; unitPrice: string }>>;
}
export const SALES_PRODUCTS_CONTRACT = Symbol('SALES_PRODUCTS_CONTRACT');

export interface BomComponentInputContract {
  componentProductId: string;
  quantityPerUnit: number;
}

export interface SalesBomContract {
  getBomForAssembly(finishedProductId: string): Promise<BomComponentInputContract[] | null>;
}
export const SALES_BOM_CONTRACT = Symbol('SALES_BOM_CONTRACT');

/**
 * P4 Tranche-2 — public contract SALES exposes to FINANCE (the reverse
 * edge of the `sales ↔ finance` cycle, F-MOD-2: customer-finance's
 * `invoices.service.ts` / `payments.service.ts` / `customer-ledger.service.ts`
 * / `customer-ledger.controller.ts` all call into `crm`'s CustomersService
 * — one of which (`customer-ledger.service.ts`'s credit-summary read) was
 * a raw `dataSource.getRepository(Customer)` query, not even a service
 * call; see `CustomersService.getCreditLimit`'s own doc comment).
 * Return shapes are narrowed to exactly the fields each caller reads —
 * `getCustomer` (Scope-checked) is called at several sites purely for its
 * authorization side effect, return value discarded there.
 */
export interface CustomerSnapshotContract {
  id: string;
  code: string;
  name: string;
  phone: string | null;
  address: string | null;
  governorate: string | null;
}

export interface SalesCustomersContract {
  /** P4 Tranche-2 (reports domain) — widened with `id`/`code`/`name`, still an object-shape subset of the real `Promise<Customer>`. */
  getCustomer(customerId: string, requestingUserId: string): Promise<{ id: string; code: string; name: string; paymentTermsDays: number | null }>;
  listCustomers(requestingUserId: string): Promise<Array<{ id: string; code: string; name: string }>>;
  getCreditLimit(customerId: string): Promise<string | null>;
  /** P4 Tranche-2 (shipment domain) — only `.id` is ever read; narrowed from the concrete `Promise<Customer | null>`. */
  findByCode(code: string): Promise<{ id: string } | null>;
  /** P4 Tranche-2 (shipment domain) — matches the concrete method's real return shape exactly (already a narrow, purpose-built cross-domain DTO, not the raw entity). */
  getCustomerSnapshot(customerId: string): Promise<CustomerSnapshotContract | null>;
}
export const SALES_CUSTOMERS_CONTRACT = Symbol('SALES_CUSTOMERS_CONTRACT');

/**
 * P4 Tranche-2 — public contract SALES (`sales-orders`) exposes to
 * FINANCE's `invoices.service.ts` (`createDraftInvoice`'s pricing +
 * `getInvoice`'s reused Scope check). Narrowed the same way as the
 * contract above: only the fields actually read at the call sites.
 */
export interface SalesOrdersReadContract {
  /** P4 Tranche-2 (returns domain) — widened with `warehouseId`, still an object-shape subset of the real `Promise<SalesOrder>`. */
  getOrder(orderId: string, requestingUserId: string): Promise<{ customerId: string; warehouseId: string | null }>;
  getOrderLines(orderId: string): Promise<
    Array<{ id: string; productId: string; quantity: number; unitPrice: string; discountAmount: string; lineTotal: string }>
  >;
  /**
   * P4 Tranche-2 (shipment domain) — matches the concrete method's real
   * return shape. Widened with `totalAmount` (Sales/Shipment/Returns
   * workflow review, CTO directive 2026-09-16) for the shipment detail
   * screen's "order total" field — same "widen an existing narrow
   * contract method" precedent as `warehouseId` on `getOrder` above,
   * not a new method.
   */
  getOrderSnapshot(orderId: string): Promise<{ id: string; orderNumber: string; customerId: string; salesRepUserId: string; totalAmount: string } | null>;
  /** P4 Tranche-2 (returns domain) — narrowed from the real `Promise<SalesOrderLine | null>` to the 4 fields actually read. */
  getOrderLineById(lineId: string): Promise<{ salesOrderId: string; productId: string; quantity: number; lineTotal: string } | null>;
  /** P4 Tranche-2 (returns domain) — real return is already a primitive `Promise<string>`. */
  getOrderStatus(orderId: string): Promise<string>;
  /** P4 Tranche-2 (reports domain) — narrowed to the fields both `reports.service.ts` and `customer-accounts.service.ts` actually read from the real `Promise<SalesOrder[]>`. */
  listOrders(actorUserId: string): Promise<
    Array<{
      id: string;
      orderNumber: string;
      createdAt: Date;
      customerId: string;
      salesRepUserId: string;
      workflowPolicy: string;
      totalAmount: string;
    }>
  >;
  /**
   * Sales Return "All Orders" eligibility (CTO directive, 2026-09-16 —
   * Sales/Shipment/Returns workflow batch). Real join over this
   * customer's OWN order-lines — never a global product list — so a
   * product is only offered for an "All Orders" return if it was
   * actually sold to this customer. `anchorDate` is, for V1,
   * `SalesOrder.createdAt` for every row: the CTO's ratification
   * explicitly allows this exact fallback ("if the current system does
   * not have a reliable item-level sale/invoice date, use the
   * originating Sales Order creation date") — a true item-level
   * invoice-posted-date anchor would require a new read method on
   * `FINANCE_INVOICE_CONTRACT` (customer-finance owns `SalesInvoice`),
   * which `sales-orders` must never query directly via a raw cross-
   * domain join (same module-boundary discipline as every other
   * contract in this file). Disclosed V1 scope cut, not a silent one —
   * see `SALES_ORDER_SHIPMENT_RETURNS_BLUEPRINT.md` §B.18 decision log.
   */
  findEligibleReturnPurchaseLines(
    customerId: string,
    returnDate: Date,
    windowDays: number,
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
  >;
}
export const SALES_ORDERS_READ_CONTRACT = Symbol('SALES_ORDERS_READ_CONTRACT');

/**
 * P4 Tranche-2 (reports domain) — public contract SALES (`deposit-control`)
 * exposes to REPORTING. `deposit-control` was previously only ever a
 * contract *consumer* (Task 1/2) — this is its first time as a provider.
 */
export type DepositStatusContract = 'submitted' | 'approved' | 'rejected';

export interface DepositViewContract {
  id: string;
  status: DepositStatusContract;
  amount: string;
  createdAt: Date;
  method: string;
}

export interface SalesDepositContract {
  listDepositsForOrder(salesOrderId: string, requestingUserId: string): Promise<DepositViewContract[]>;
  getLatestDepositForOrder(salesOrderId: string, requestingUserId: string): Promise<DepositViewContract | null>;
}
export const SALES_DEPOSIT_CONTRACT = Symbol('SALES_DEPOSIT_CONTRACT');
