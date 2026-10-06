import { Inject, Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { SALES_ORDERS_READ_CONTRACT, SalesOrdersReadContract, SALES_CUSTOMERS_CONTRACT, SalesCustomersContract, SALES_DEPOSIT_CONTRACT, SalesDepositContract } from '../../../foundation/module-registry/contracts/sales.contract';
import {
  LOGISTICS_RETURNS_CONTRACT,
  LogisticsReturnsContract,
  LOGISTICS_SHIPMENT_CONTRACT,
  LogisticsShipmentContract,
  LOGISTICS_DELIVERY_CONTRACT,
  LogisticsDeliveryContract,
} from '../../../foundation/module-registry/contracts/logistics.contract';
import { FULFILLMENT_CONTRACT, FulfillmentContract } from '../../../foundation/module-registry/contracts/inventory.contract';
import {
  FINANCE_CUSTOMER_LEDGER_CONTRACT,
  FinanceCustomerLedgerContract,
  CustomerLedgerEntryTypeContract,
} from '../../../foundation/module-registry/contracts/finance.contract';

export interface CustomerAccountEntry {
  type: 'sales_order' | 'deposit' | 'collection' | 'return';
  date: string;
  salesOrderId: string;
  orderNumber: string;
  reference: string;
  description: string;
  amount: string | null;
  status: string;
}

export interface CustomerAccountStatement {
  customerId: string;
  customerCode: string;
  customerName: string;
  totalOrdered: string;
  totalDeposited: string;
  totalCollected: string;
  totalRemitted: string;
  returnCount: number;
  entries: CustomerAccountEntry[];
}

export interface LedgerCustomerAccountEntry {
  type: CustomerLedgerEntryTypeContract;
  date: string;
  reference: string;
  description: string;
  salesOrderId: string | null;
  invoiceId: string | null;
  debit: string;
  credit: string;
  runningBalance: string;
  status: 'posted' | 'reversed';
}

export interface LedgerCustomerAccountStatement {
  customerId: string;
  customerCode: string;
  customerName: string;
  balance: string;
  creditLimit: string | null;
  availableCredit: string | null;
  overdueAmount: string;
  totalSales: string;
  totalPaid: string;
  totalReturns: string;
  totalOutstanding: string;
  entries: LedgerCustomerAccountEntry[];
}

/**
 * Customer Account Foundation (CTO directive, extended by the Customer
 * Financial Account / Invoice / AR phase). `getCustomerAccountStatement`
 * is now the PRIMARY statement, sourced from the real Customer Ledger
 * (`CustomerLedgerService`) — per the directive's own "الرصيد يحسب من
 * Customer Ledger" instruction — never a second parallel ledger, and
 * never a cached balance column. The ORIGINAL live-composition logic
 * (walking Sales Order → Deposit → Delivery/Collection → Returns
 * directly, with no persisted ledger) is kept, renamed
 * `getCustomerAccountReconciliation`, and exposed as a separate
 * `/reconcile` endpoint — valuable specifically because pre-rollout
 * historical orders have no Customer Ledger rows unless later backfilled
 * with an `opening_balance` entry (an ops action, not part of this
 * change), so the two can be compared to catch drift.
 */
@Injectable()
export class CustomerAccountsService {
  constructor(
    @Inject(SALES_ORDERS_READ_CONTRACT) private readonly salesOrders: SalesOrdersReadContract,
    @Inject(SALES_CUSTOMERS_CONTRACT) private readonly customers: SalesCustomersContract,
    @Inject(SALES_DEPOSIT_CONTRACT) private readonly deposits: SalesDepositContract,
    @Inject(LOGISTICS_RETURNS_CONTRACT) private readonly returns: LogisticsReturnsContract,
    @Inject(FULFILLMENT_CONTRACT) private readonly fulfillment: FulfillmentContract,
    @Inject(LOGISTICS_SHIPMENT_CONTRACT) private readonly shipments: LogisticsShipmentContract,
    @Inject(LOGISTICS_DELIVERY_CONTRACT) private readonly delivery: LogisticsDeliveryContract,
    @Inject(FINANCE_CUSTOMER_LEDGER_CONTRACT) private readonly customerLedger: FinanceCustomerLedgerContract,
  ) {}

  /** The new primary statement (CTO directive §8) — Date/Type/Reference/SalesOrder/Invoice/Debit/Credit/RunningBalance/Status, every row traceable to its own source document, balance computed live from the Customer Ledger. */
  async getCustomerAccountStatement(customerId: string, actorUserId: string, manager?: EntityManager): Promise<LedgerCustomerAccountStatement> {
    const customer = await this.customers.getCustomer(customerId, actorUserId, manager); // Scope-checked, same gate every customer-scoped read in this codebase uses
    const [entries, creditSummary] = await Promise.all([
      this.customerLedger.listLedger(customerId, undefined, manager),
      this.customerLedger.getCreditSummary(customerId, manager),
    ]);

    let runningBalance = 0;
    let totalSales = 0;
    let totalPaid = 0;
    let totalReturns = 0;

    const mapped: LedgerCustomerAccountEntry[] = entries.map((entry) => {
      const amount = Number(entry.amount);
      const debit = entry.direction === 'debit' ? amount : 0;
      const credit = entry.direction === 'credit' ? amount : 0;
      if (entry.status === 'posted') {
        runningBalance += debit - credit;
        if (entry.entryType === 'sales_invoice') totalSales += debit;
        if (entry.entryType === 'payment') totalPaid += credit;
        if (entry.entryType === 'return_credit_note') totalReturns += credit;
      }
      return {
        type: entry.entryType,
        date: entry.entryDate.toISOString(),
        reference: entry.entryNumber,
        description: entry.reason ?? entry.entryType,
        salesOrderId: entry.salesOrderId,
        invoiceId: entry.invoiceId,
        debit: debit.toFixed(2),
        credit: credit.toFixed(2),
        runningBalance: runningBalance.toFixed(2),
        status: entry.status,
      };
    });

    return {
      customerId: customer.id,
      customerCode: customer.code,
      customerName: customer.name,
      balance: creditSummary.balance,
      creditLimit: creditSummary.creditLimit,
      availableCredit: creditSummary.availableCredit,
      overdueAmount: creditSummary.overdueAmount,
      totalSales: totalSales.toFixed(2),
      totalPaid: totalPaid.toFixed(2),
      totalReturns: totalReturns.toFixed(2),
      totalOutstanding: creditSummary.balance,
      entries: mapped,
    };
  }

  /**
   * The ORIGINAL Customer Account Foundation composition — kept verbatim
   * as a cross-check, not the primary statement any more. See this class's
   * own doc comment for why (historical orders predating the Customer
   * Ledger have no ledger rows to source from).
   *
   * Deliberately sequential per order (not batched) — a customer has a
   * small number of orders in practice, and this mirrors the exact same
   * per-order hop chain `DeliveryService.recordCollection`/`remitCollection`
   * already walk one order at a time; batching would mean either
   * duplicating that join logic outside the domains that own it, or a raw
   * multi-table SQL join that would cross the Cross-Domain Rule this whole
   * codebase otherwise holds to (DAII_DOMAIN_BOUNDARIES.md).
   */
  async getCustomerAccountReconciliation(customerId: string, actorUserId: string, manager?: EntityManager): Promise<CustomerAccountStatement> {
    const customer = await this.customers.getCustomer(customerId, actorUserId, manager);

    const orders = (await this.salesOrders.listOrders(actorUserId, manager)).filter((o) => o.customerId === customerId);
    const allReturns = await this.returns.listReturns(manager);

    const entries: CustomerAccountEntry[] = [];
    let totalOrdered = 0;
    let totalDeposited = 0;
    let totalCollected = 0;
    let totalRemitted = 0;
    let returnCount = 0;

    for (const order of orders) {
      totalOrdered += Number(order.totalAmount);
      const status = await this.salesOrders.getOrderStatus(order.id, manager);
      entries.push({
        type: 'sales_order',
        date: order.createdAt.toISOString(),
        salesOrderId: order.id,
        orderNumber: order.orderNumber,
        reference: order.orderNumber,
        description: `Sales Order ${order.orderNumber}`,
        amount: order.totalAmount,
        status,
      });

      const orderDeposits = await this.deposits.listDepositsForOrder(order.id, actorUserId, manager);
      for (const dep of orderDeposits) {
        if (dep.status === 'approved') totalDeposited += Number(dep.amount);
        entries.push({
          type: 'deposit',
          date: dep.createdAt.toISOString(),
          salesOrderId: order.id,
          orderNumber: order.orderNumber,
          reference: dep.id,
          description: `Deposit (${dep.method})`,
          amount: dep.amount,
          status: dep.status,
        });
      }

      for (const ret of allReturns.filter((r) => r.salesOrderId === order.id)) {
        returnCount += 1;
        // Returns Engine (CTO directive §7 — ERP/AR readiness): a return
        // now carries a real credit amount when one was issued
        // (value_credit/product_return dispositions) — an exchange still
        // shows null, since no credit is ever created for one.
        const credit = await this.returns.getCreditForReturnRequest(ret.id, manager);
        entries.push({
          type: 'return',
          date: ret.createdAt.toISOString(),
          salesOrderId: order.id,
          orderNumber: order.orderNumber,
          reference: ret.id,
          description: `Return — quantity ${ret.quantity} (${ret.reason})`,
          amount: credit?.originalAmount ?? null,
          status: ret.state,
        });
      }

      const fulfillmentOrder = await this.fulfillment.getFulfillmentOrderBySalesOrderId(order.id, manager);
      const shipment = fulfillmentOrder ? await this.shipments.getShipmentByFulfillmentOrderId(fulfillmentOrder.id, manager) : null;
      const collection = shipment ? await this.delivery.getCollectionForShipmentUnscoped(shipment.id, manager) : null;
      if (shipment && collection) {
        totalCollected += Number(collection.amount);
        if (collection.remittanceStatus === 'remitted') totalRemitted += Number(collection.amount);
        entries.push({
          type: 'collection',
          date: collection.occurredAt.toISOString(),
          salesOrderId: order.id,
          orderNumber: order.orderNumber,
          reference: collection.id,
          description: `Collection (${collection.method}) — waybill ${shipment.waybillNumber}`,
          amount: collection.amount,
          status: collection.remittanceStatus,
        });
      }
    }

    entries.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    return {
      customerId: customer.id,
      customerCode: customer.code,
      customerName: customer.name,
      totalOrdered: totalOrdered.toFixed(2),
      totalDeposited: totalDeposited.toFixed(2),
      totalCollected: totalCollected.toFixed(2),
      totalRemitted: totalRemitted.toFixed(2),
      returnCount,
      entries,
    };
  }
}
