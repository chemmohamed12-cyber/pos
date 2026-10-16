import type { EntityManager } from 'typeorm';

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

/**
 * Area 21 Operational Company Scoping Retrofit (2026-09-27): `manager?`
 * added to every method here — `Product`/`BillOfMaterial`/`BomComponent`
 * are Company-owned data, and this contract is exactly the seam a
 * Company-scoped caller (e.g. `InventoryController`/`InventoryService`)
 * crosses to reach them. The concrete implementations
 * (`ProductsService`/`BomService`) already accept `manager?` — this
 * widens the published INTERFACE to match, since a caller typed against
 * the contract (not the concrete class) could not otherwise pass it
 * through.
 */
export interface SalesProductsContract {
  getProductSnapshot(productId: string, manager?: EntityManager): Promise<ProductSnapshotContract | null>;
  getProductSnapshotBySku(sku: string, manager?: EntityManager): Promise<ProductSnapshotContract | null>;
  listAllProducts(manager?: EntityManager): Promise<Array<{ id: string; unitPrice: string }>>;
  /** D7 — a New Item Request creates a `draft` Product (price 0, unit optional) through the catalog's own creation path. */
  createDraftProduct(input: { sku: string; name: string; unit?: string | null }, actorUserId: string, manager?: EntityManager): Promise<ProductSnapshotContract>;
  /** D7 — approval of a New Item Request: the catalog's own `draft → active` transition (never a raw table write). */
  activateDraftProduct(productId: string, actorUserId: string, manager?: EntityManager): Promise<ProductSnapshotContract>;
  /**
   * Master data step 1 (2026-10-15) — the item's primary default warehouse. Called ONLY by the Inventory domain, after it has
   * validated that the warehouse exists, is active and is assigned to the item (D1); `null` clears it.
   */
  setDefaultWarehouse(productId: string, warehouseId: string | null, actorUserId: string | null, manager?: EntityManager): Promise<void>;
  /** Clears the default warehouse only when it is `warehouseId` (the item was unassigned from it). Returns whether it was cleared. */
  clearDefaultWarehouseIfMatches(productId: string, warehouseId: string, actorUserId: string | null, manager?: EntityManager): Promise<boolean>;
}
export const SALES_PRODUCTS_CONTRACT = Symbol('SALES_PRODUCTS_CONTRACT');

export interface BomComponentInputContract {
  componentProductId: string;
  quantityPerUnit: number;
}

export type BomStatusContract = 'active' | 'inactive';

export interface BomComponentViewContract extends BomComponentInputContract {
  sku: string;
  productName: string;
  /** The component Product's existing free-text `unit` label (display only — no UoM engine, ADR-061 Addendum 1 A2). */
  unit: string | null;
}

export interface BomViewContract {
  id: string;
  finishedProductId: string;
  finishedProductSku: string;
  finishedProductName: string;
  status: BomStatusContract;
  components: BomComponentViewContract[];
}

export interface BomListEntryContract {
  finishedProductId: string;
  sku: string;
  name: string;
  status: BomStatusContract;
  componentCount: number;
}

/**
 * `getBomForAssembly` (consumed by Inventory assembly + Work Order release) returns `null` for a
 * missing OR `inactive` BOM. The remaining members (ADR-061 Addendum 1, 2026-10-06) let the
 * Manufacturing workspace manage BOM master data through the SAME commerce `BomService` — one
 * store, one service, manufacturing-owned permission nodes (`manufacturing.bom.*`).
 */
export interface SalesBomContract {
  getBomForAssembly(finishedProductId: string, manager?: EntityManager): Promise<BomComponentInputContract[] | null>;
  listBoms(manager?: EntityManager): Promise<BomListEntryContract[]>;
  getBom(finishedProductId: string, manager?: EntityManager): Promise<BomViewContract | null>;
  defineBom(finishedProductId: string, components: BomComponentInputContract[], actorUserId: string | null, manager?: EntityManager): Promise<{ id: string }>;
  setBomStatus(finishedProductId: string, status: BomStatusContract, actorUserId: string | null, manager?: EntityManager): Promise<void>;
  deleteBom(finishedProductId: string, actorUserId: string | null, manager?: EntityManager): Promise<void>;
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

/**
 * Area 21 Operational Company Scoping Retrofit (2026-09-27): `manager?`
 * added to `getCustomer`/`listCustomers`/`getCreditLimit` — the concrete
 * `CustomersService` implementations of the first two have accepted it
 * since §16/§20; `getCreditLimit`'s own concrete method gains it now,
 * for `customer-ledger.controller.ts`'s retrofit (its first real caller
 * through this published contract).
 */
export interface SalesCustomersContract {
  /** P4 Tranche-2 (reports domain) — widened with `id`/`code`/`name`, still an object-shape subset of the real `Promise<Customer>`. */
  getCustomer(customerId: string, requestingUserId: string, manager?: EntityManager): Promise<{ id: string; code: string; name: string; paymentTermsDays: number | null }>;
  listCustomers(requestingUserId: string, manager?: EntityManager): Promise<Array<{ id: string; code: string; name: string }>>;
  getCreditLimit(customerId: string, manager?: EntityManager): Promise<string | null>;
  /** P4 Tranche-2 (shipment domain) — only `.id` is ever read; narrowed from the concrete `Promise<Customer | null>`. Area 21: `manager?` added — concrete `CustomersService.findByCode` gained it in the same pass (had none at all before). */
  findByCode(code: string, manager?: EntityManager): Promise<{ id: string } | null>;
  /** P4 Tranche-2 (shipment domain) — matches the concrete method's real return shape exactly (already a narrow, purpose-built cross-domain DTO, not the raw entity). Area 21: `manager?` added — concrete `CustomersService.getCustomerSnapshot` already had it. */
  getCustomerSnapshot(customerId: string, manager?: EntityManager): Promise<CustomerSnapshotContract | null>;
}
export const SALES_CUSTOMERS_CONTRACT = Symbol('SALES_CUSTOMERS_CONTRACT');

/**
 * P4 Tranche-2 — public contract SALES (`sales-orders`) exposes to
 * FINANCE's `invoices.service.ts` (`createDraftInvoice`'s pricing +
 * `getInvoice`'s reused Scope check). Narrowed the same way as the
 * contract above: only the fields actually read at the call sites.
 */
/**
 * Area 21 Operational Company Scoping Retrofit (2026-09-27): `manager?`
 * added to `getOrder`/`getOrderLines`/`getOrderSnapshot`/`getOrderLineById`/
 * `getOrderStatus` — the concrete `SalesOrdersService` implementations
 * have accepted it since §16; this contract was simply never widened to
 * match (same class of drift as `SalesProductsContract`/`SalesBomContract`
 * in §21.1, `SalesCustomersContract` in §25.1). Discovered while
 * evaluating `shipment.controller.ts`/`returns.controller.ts` (§23/§26).
 */
export interface SalesOrdersReadContract {
  /** P4 Tranche-2 (returns domain) — widened with `warehouseId`, still an object-shape subset of the real `Promise<SalesOrder>`. */
  getOrder(orderId: string, requestingUserId: string, manager?: EntityManager): Promise<{ customerId: string; warehouseId: string | null }>;
  getOrderLines(orderId: string, manager?: EntityManager): Promise<
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
  getOrderSnapshot(orderId: string, manager?: EntityManager): Promise<{ id: string; orderNumber: string; customerId: string; salesRepUserId: string; totalAmount: string } | null>;
  /** P4 Tranche-2 (returns domain) — narrowed from the real `Promise<SalesOrderLine | null>` to the 4 fields actually read. */
  getOrderLineById(lineId: string, manager?: EntityManager): Promise<{ salesOrderId: string; productId: string; quantity: number; lineTotal: string } | null>;
  /** P4 Tranche-2 (returns domain) — real return is already a primitive `Promise<string>`. */
  getOrderStatus(orderId: string, manager?: EntityManager): Promise<string>;
  /** P4 Tranche-2 (reports domain) — narrowed to the fields both `reports.service.ts` and `customer-accounts.service.ts` actually read from the real `Promise<SalesOrder[]>`. */
  listOrders(actorUserId: string, manager?: EntityManager): Promise<
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
  listDepositsForOrder(salesOrderId: string, requestingUserId: string, manager?: EntityManager): Promise<DepositViewContract[]>;
  /** Area 21 Operational Company Scoping Retrofit (2026-09-28): `manager?` added — the concrete `DepositsService.getLatestDepositForOrder` gained it during `deposits.controller.ts`'s own retrofit. */
  getLatestDepositForOrder(salesOrderId: string, requestingUserId: string, manager?: EntityManager): Promise<DepositViewContract | null>;
}
export const SALES_DEPOSIT_CONTRACT = Symbol('SALES_DEPOSIT_CONTRACT');
