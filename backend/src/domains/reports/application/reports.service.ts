import { Inject, Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { SALES_ORDERS_READ_CONTRACT, SalesOrdersReadContract, SALES_CUSTOMERS_CONTRACT, SalesCustomersContract, SALES_DEPOSIT_CONTRACT, SalesDepositContract } from '../../../foundation/module-registry/contracts/sales.contract';
import { UsersService } from '../../../foundation/identity/users.service';
import {
  LOGISTICS_SHIPMENT_CONTRACT,
  LogisticsShipmentContract,
  LOGISTICS_DELIVERY_CONTRACT,
  LogisticsDeliveryContract,
} from '../../../foundation/module-registry/contracts/logistics.contract';

export interface SalesOrderReportRow {
  id: string;
  orderNumber: string;
  createdAt: string;
  customerId: string;
  customerName: string;
  salesRepUserId: string;
  salesRepName: string;
  status: string;
  workflowPolicy: string;
  totalAmount: string;
  depositStatus: string | null;
  depositAmount: string | null;
}

export interface SalesByPeriodRow {
  period: string; // 'YYYY-MM-DD' or 'YYYY-MM'
  orderCount: number;
  totalAmount: string;
}

export interface SalesByCustomerRow {
  customerId: string;
  customerName: string;
  orderCount: number;
  totalAmount: string;
}

export interface SalesByRepRow {
  salesRepUserId: string;
  salesRepName: string;
  orderCount: number;
  totalAmount: string;
}

export interface CustodyCodReportRow {
  custodianType: 'company' | 'vehicle';
  custodianId: string;
  custodianCode: string;
  custodianName: string;
  custodyBalance: string;
  activeShipmentsCount: number;
  codCollectedTotal: string;
  codPendingTotal: string;
  codRemittedTotal: string;
}

export interface CustodyCodReport {
  rows: CustodyCodReportRow[];
  totals: {
    custodyBalance: string;
    codCollectedTotal: string;
    codPendingTotal: string;
    codRemittedTotal: string;
  };
}

/**
 * Operational Reports — a cross-domain composition layer, not owned by
 * any single business domain (no Reports entry exists in
 * `DAII_DOMAIN_BOUNDARIES.md` — the closest precedent is `Dashboard.tsx`,
 * which composes existing list endpoints client-side; this is the same
 * idea moved server-side only where aggregation/Excel export genuinely
 * needs it). Every row here comes from calling an EXISTING domain
 * service's own published method — `SalesOrdersService.listOrders` (already
 * Scope-filtered: a plain sales_rep sees only their own orders, a
 * reviewer/admin sees everything — Scope enforcement is inherited for
 * free, never reimplemented here), `getOrderStatus`, `CustomersService`,
 * `DepositsService`, `UsersService`. This service computes NO business
 * rule of its own — only grouping/summing already-server-computed,
 * already-trusted fields (`totalAmount`, `status`), per CTO handover
 * directive's "reuse existing domain services... no duplicated business
 * calculations."
 */
@Injectable()
export class ReportsService {
  constructor(
    @Inject(SALES_ORDERS_READ_CONTRACT) private readonly salesOrders: SalesOrdersReadContract,
    @Inject(SALES_CUSTOMERS_CONTRACT) private readonly customers: SalesCustomersContract,
    @Inject(SALES_DEPOSIT_CONTRACT) private readonly deposits: SalesDepositContract,
    private readonly users: UsersService,
    @Inject(LOGISTICS_SHIPMENT_CONTRACT) private readonly shipments: LogisticsShipmentContract,
    @Inject(LOGISTICS_DELIVERY_CONTRACT) private readonly delivery: LogisticsDeliveryContract,
  ) {}

  /**
   * The base row set every other Sales report method aggregates over —
   * one order per row, enriched with customer/rep names, current status,
   * and (Gap G-1-adjacent) its latest deposit status if one exists. Also
   * IS the "Deposit / order operational status" report on its own.
   */
  async getSalesOrdersReport(actorUserId: string, manager?: EntityManager): Promise<SalesOrderReportRow[]> {
    const orders = await this.salesOrders.listOrders(actorUserId, manager);

    const customerNames = new Map<string, string>();
    for (const c of await this.customers.listCustomers(actorUserId, manager)) customerNames.set(c.id, c.name);

    const repNames = new Map<string, string>();
    for (const repId of new Set(orders.map((o) => o.salesRepUserId))) {
      if (repNames.has(repId)) continue;
      const user = await this.users.findById(repId).catch(() => null);
      repNames.set(repId, user?.fullName ?? repId);
    }

    // PERFORMANCE FIX (measured this session: 74 orders took ~460ms on this
    // endpoint alone, ~4x slower than comparable list endpoints of similar
    // row count) — this loop was sequential (`for...of` with an `await`
    // per iteration), so each order's status+deposit lookup waited for the
    // previous order's to fully complete before starting, turning N
    // independent reads into N sequential round-trips. Parallelized via
    // `Promise.all` — same per-order queries, same result shape, but now
    // issued concurrently instead of one-at-a-time.
    const rows = await Promise.all(
      orders.map(async (order) => {
        const [status, deposit] = await Promise.all([
          this.salesOrders.getOrderStatus(order.id, manager),
          this.deposits.getLatestDepositForOrder(order.id, actorUserId, manager),
        ]);
        return {
          id: order.id,
          orderNumber: order.orderNumber,
          createdAt: order.createdAt.toISOString(),
          customerId: order.customerId,
          customerName: customerNames.get(order.customerId) ?? order.customerId,
          salesRepUserId: order.salesRepUserId,
          salesRepName: repNames.get(order.salesRepUserId) ?? order.salesRepUserId,
          status,
          workflowPolicy: order.workflowPolicy,
          totalAmount: order.totalAmount,
          depositStatus: deposit?.status ?? null,
          depositAmount: deposit?.amount ?? null,
        };
      }),
    );
    return rows;
  }

  async getSalesByPeriod(actorUserId: string, groupBy: 'day' | 'month', manager?: EntityManager): Promise<SalesByPeriodRow[]> {
    const rows = await this.getSalesOrdersReport(actorUserId, manager);
    const groups = new Map<string, { count: number; total: number }>();
    for (const row of rows) {
      const period = groupBy === 'month' ? row.createdAt.slice(0, 7) : row.createdAt.slice(0, 10);
      const g = groups.get(period) ?? { count: 0, total: 0 };
      g.count += 1;
      g.total += Number(row.totalAmount);
      groups.set(period, g);
    }
    return [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([period, g]) => ({ period, orderCount: g.count, totalAmount: g.total.toFixed(2) }));
  }

  async getSalesByCustomer(actorUserId: string, manager?: EntityManager): Promise<SalesByCustomerRow[]> {
    const rows = await this.getSalesOrdersReport(actorUserId, manager);
    const groups = new Map<string, { customerName: string; count: number; total: number }>();
    for (const row of rows) {
      const g = groups.get(row.customerId) ?? { customerName: row.customerName, count: 0, total: 0 };
      g.count += 1;
      g.total += Number(row.totalAmount);
      groups.set(row.customerId, g);
    }
    return [...groups.entries()]
      .sort(([, a], [, b]) => b.total - a.total)
      .map(([customerId, g]) => ({ customerId, customerName: g.customerName, orderCount: g.count, totalAmount: g.total.toFixed(2) }));
  }

  async getSalesByRep(actorUserId: string, manager?: EntityManager): Promise<SalesByRepRow[]> {
    const rows = await this.getSalesOrdersReport(actorUserId, manager);
    const groups = new Map<string, { salesRepName: string; count: number; total: number }>();
    for (const row of rows) {
      const g = groups.get(row.salesRepUserId) ?? { salesRepName: row.salesRepName, count: 0, total: 0 };
      g.count += 1;
      g.total += Number(row.totalAmount);
      groups.set(row.salesRepUserId, g);
    }
    return [...groups.entries()]
      .sort(([, a], [, b]) => b.total - a.total)
      .map(([salesRepUserId, g]) => ({ salesRepUserId, salesRepName: g.salesRepName, orderCount: g.count, totalAmount: g.total.toFixed(2) }));
  }

  /**
   * Custody / COD Reporting (CTO directive, Phase 5 — "custody/COD
   * reporting"). Composes from ShipmentService/DeliveryService's own
   * published, already-unscoped reads (`listShippingCompanies`,
   * `listVehicles`, `getCustodianOverview`, `listAllCollections`) — never a
   * new calculation. A Collection's `custodyAccountId` IS the custodian's
   * own `custodyAccountId` (set the moment cash is collected into custody,
   * per `delivery.service.ts`'s own doc comment), so collections group to
   * their custodian directly, with no need to join through Shipment.
   */
  async getCustodyCodReport(manager?: EntityManager): Promise<CustodyCodReport> {
    const [companies, vehicles, collections] = await Promise.all([
      this.shipments.listShippingCompanies(manager),
      this.shipments.listVehicles(manager),
      this.delivery.listAllCollections(manager),
    ]);

    const collectionsByCustodyAccount = new Map<string, typeof collections>();
    for (const c of collections) {
      if (!c.custodyAccountId) continue;
      const list = collectionsByCustodyAccount.get(c.custodyAccountId) ?? [];
      list.push(c);
      collectionsByCustodyAccount.set(c.custodyAccountId, list);
    }

    const rows: CustodyCodReportRow[] = [];
    for (const [custodianType, custodians] of [
      ['company', companies] as const,
      ['vehicle', vehicles] as const,
    ]) {
      for (const custodian of custodians) {
        if (!custodian.custodyAccountId) continue;
        const overview = await this.shipments.getCustodianOverview(custodianType, custodian.id, manager);
        const custodianCollections = collectionsByCustodyAccount.get(custodian.custodyAccountId) ?? [];
        const collected = custodianCollections.reduce((sum, c) => sum + Number(c.amount), 0);
        const pending = custodianCollections
          .filter((c) => c.remittanceStatus === 'pending')
          .reduce((sum, c) => sum + Number(c.amount), 0);
        const remitted = custodianCollections
          .filter((c) => c.remittanceStatus === 'remitted')
          .reduce((sum, c) => sum + Number(c.amount), 0);
        rows.push({
          custodianType,
          custodianId: custodian.id,
          custodianCode: custodian.code,
          custodianName: custodianType === 'vehicle' ? (custodian as { plateNumber: string }).plateNumber : (custodian as { name: string }).name,
          custodyBalance: overview.custodyBalance ?? '0.00',
          activeShipmentsCount: overview.activeShipmentsCount,
          codCollectedTotal: collected.toFixed(2),
          codPendingTotal: pending.toFixed(2),
          codRemittedTotal: remitted.toFixed(2),
        });
      }
    }

    const totals = rows.reduce(
      (acc, r) => ({
        custodyBalance: (Number(acc.custodyBalance) + Number(r.custodyBalance)).toFixed(2),
        codCollectedTotal: (Number(acc.codCollectedTotal) + Number(r.codCollectedTotal)).toFixed(2),
        codPendingTotal: (Number(acc.codPendingTotal) + Number(r.codPendingTotal)).toFixed(2),
        codRemittedTotal: (Number(acc.codRemittedTotal) + Number(r.codRemittedTotal)).toFixed(2),
      }),
      { custodyBalance: '0.00', codCollectedTotal: '0.00', codPendingTotal: '0.00', codRemittedTotal: '0.00' },
    );

    return { rows, totals };
  }
}
