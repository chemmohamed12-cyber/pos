import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { InventoryPostingPolicyRegistry } from '../../../foundation/inventory-posting-policy/inventory-posting-policy.registry';
import { INVENTORY_LOGISTICS_CONTRACT, InventoryLogisticsContract } from '../../../foundation/module-registry/contracts/inventory.contract';
import { SALES_ORDERS_READ_CONTRACT, SalesOrdersReadContract } from '../../../foundation/module-registry/contracts/sales.contract';
import {
  FINANCE_CUSTOMER_LEDGER_CONTRACT,
  FINANCE_INVOICE_CONTRACT,
  FinanceCustomerLedgerContract,
  FinanceInvoiceContract,
  InvoiceReturnBasis,
} from '../../../foundation/module-registry/contracts/finance.contract';
import { AR_EVENT_TOPICS } from '../../../foundation/module-registry/contracts/ar-events.contract';

export type ReturnKind = 'sales_return' | 'shipment_return';

export interface ReturnFinancialLineInput {
  /** `sales_return_lines.id` / `shipment_return_lines.id`. */
  lineId: string;
  salesOrderId: string;
  salesOrderLineId: string;
  productId: string;
  quantity: number;
}

export interface PlannedReturnLine extends ReturnFinancialLineInput {
  warehouseId: string;
  unitCostBase: string;
  costTotalBase: string;
  /** The original posted invoice this line reverses — `null` when the sale created no Revenue/AR. */
  invoiceId: string | null;
  creditNetBase: string | null;
  creditTaxBase: string | null;
}

export interface PlannedInvoiceCredit {
  invoiceId: string;
  invoiceNumber: string;
  customerId: string;
  salesOrderId: string;
  net: string;
  tax: string;
  gross: string;
}

export interface ReturnFinancialPlan {
  lines: PlannedReturnLine[];
  credits: PlannedInvoiceCredit[];
}

const cents = (v: string | number): number => Math.round(Number(v) * 100);
const fromCents = (c: number): string => (c / 100).toFixed(2);

/**
 * D4 (2026-10-05, CTO-approved Returns accounting policy — `D4-RETURNS-ACCOUNTING-POLICY-2026-10-05.md`).
 * The ONE financial policy shared by Sales Returns and Shipment Returns (neither service calls the other; both depend on this
 * stateless helper, like `OrderLineReturnCapacityService`).
 *
 * `plan()` runs the whole "validate → resolve cost → resolve accounts → validate quantities" half BEFORE any write — it only
 * reads, so a rejection leaves stock, valuation, ledger and outbox untouched. `apply()` is the mutation half and must run in
 * the SAME transaction: stock back at the ORIGINAL cost (valuation restored + `Dr Inventory / Cr COGS` event), then — only when
 * the original sale created Revenue/AR (a posted/partially_paid/paid invoice) — a Customer Ledger credit (AR reduction /
 * customer credit, never a cash refund) and the `Dr Sales Returns [+ Dr tax] / Cr AR` event, amounts derived from the ORIGINAL
 * invoice value (never from the declared return price). Fail-closed everywhere: cost indeterminable, no restock warehouse,
 * missing configuration → rejected, nothing written.
 */
@Injectable()
export class ReturnFinancialsService {
  constructor(
    @Inject(INVENTORY_LOGISTICS_CONTRACT) private readonly inventory: InventoryLogisticsContract,
    @Inject(SALES_ORDERS_READ_CONTRACT) private readonly salesOrders: SalesOrdersReadContract,
    @Inject(FINANCE_CUSTOMER_LEDGER_CONTRACT) private readonly ledger: FinanceCustomerLedgerContract,
    @Inject(FINANCE_INVOICE_CONTRACT) private readonly invoices: FinanceInvoiceContract,
    private readonly events: EventBusService,
    private readonly postingPolicy: InventoryPostingPolicyRegistry,
  ) {}

  /** Read-only. Throws (BadRequest/Conflict) before anything is written. `manager` must be the completion transaction's manager. */
  async plan(lines: ReturnFinancialLineInput[], actorUserId: string, manager: EntityManager): Promise<ReturnFinancialPlan> {
    if (lines.length === 0) throw new BadRequestException('A return must have at least one line.');

    // Serialize concurrent completions against the same order lines (same lock the capacity helper uses) so the
    // cumulative amounts below are computed against a stable "already credited" total. Sorted ids — deterministic order.
    for (const orderLineId of [...new Set(lines.map((l) => l.salesOrderLineId))].sort()) {
      await manager.query(`SELECT id FROM "sales_order_lines" WHERE id = $1::uuid FOR UPDATE`, [orderLineId]);
    }

    // 1. Validate source: every order must exist and have a warehouse to restock into.
    const warehouseByOrder = new Map<string, string>();
    for (const orderId of [...new Set(lines.map((l) => l.salesOrderId))]) {
      const order = await this.salesOrders.getOrder(orderId, actorUserId, manager);
      if (!order.warehouseId) {
        throw new BadRequestException(`Sales order "${orderId}" has no warehouse to restock into — a financial return cannot restore inventory or cost without one.`);
      }
      warehouseByOrder.set(orderId, order.warehouseId);
    }

    // 2. Resolve the ORIGINAL cost per (order, product) — fail closed, never a current average / last purchase cost.
    const unitCostByKey = new Map<string, string>();
    for (const line of lines) {
      const key = `${line.salesOrderId}:${line.productId}`;
      if (unitCostByKey.has(key)) continue;
      const cost = await this.inventory.resolveOriginalSaleCost(line.salesOrderId, line.productId, manager);
      if (!cost) {
        throw new ConflictException(
          `The original cost of product "${line.productId}" sold on order "${line.salesOrderId}" cannot be determined (no costed dispatch of it) — the return cannot be posted financially and nothing was changed.`,
        );
      }
      unitCostByKey.set(key, cost.unitCostBase);
    }

    // 3. Original invoice value per order (only a posted/partially_paid/paid invoice created Revenue/AR).
    const basisByOrder = new Map<string, InvoiceReturnBasis | null>();
    for (const orderId of warehouseByOrder.keys()) basisByOrder.set(orderId, await this.invoices.getReturnBasis(orderId, manager));

    // 4. Amounts. Revenue part per order line is cumulative-rounded against the ORIGINAL invoice line, minus what earlier
    //    returns already credited (so a full return reverses the line exactly); tax is reversed pro-rata at invoice level with
    //    the same cumulative rounding.
    const inFlightQty = new Map<string, number>();
    const inFlightNetCents = new Map<string, number>();
    const planned: PlannedReturnLine[] = [];
    for (const line of lines) {
      const unitCostBase = unitCostByKey.get(`${line.salesOrderId}:${line.productId}`)!;
      const basis = basisByOrder.get(line.salesOrderId) ?? null;
      let creditNetCents: number | null = null;
      if (basis) {
        const invLine = basis.lines.find((l) => l.salesOrderLineId === line.salesOrderLineId);
        if (!invLine) {
          throw new ConflictException(`Invoice ${basis.invoiceNumber} does not cover order line "${line.salesOrderLineId}" — the original value of the returned goods cannot be determined.`);
        }
        const prior = await this.priorCreditedForOrderLine(line.salesOrderLineId, manager);
        const cumQty = prior.qty + (inFlightQty.get(line.salesOrderLineId) ?? 0) + line.quantity;
        if (cumQty > invLine.quantity) {
          throw new ConflictException(`Returned quantity ${cumQty} exceeds the invoiced quantity ${invLine.quantity} of order line "${line.salesOrderLineId}".`);
        }
        const cumNetCents = Math.round((cents(invLine.lineTotal) * cumQty) / invLine.quantity);
        creditNetCents = cumNetCents - prior.netCents - (inFlightNetCents.get(line.salesOrderLineId) ?? 0);
        inFlightQty.set(line.salesOrderLineId, (inFlightQty.get(line.salesOrderLineId) ?? 0) + line.quantity);
        inFlightNetCents.set(line.salesOrderLineId, (inFlightNetCents.get(line.salesOrderLineId) ?? 0) + creditNetCents);
      }
      planned.push({
        ...line,
        warehouseId: warehouseByOrder.get(line.salesOrderId)!,
        unitCostBase,
        costTotalBase: (line.quantity * Number(unitCostBase)).toFixed(4),
        invoiceId: basis ? basis.invoiceId : null,
        creditNetBase: creditNetCents === null ? null : fromCents(creditNetCents),
        creditTaxBase: null,
      });
    }

    // 5. Tax per invoice + the per-invoice credits.
    const credits: PlannedInvoiceCredit[] = [];
    for (const [orderId, basis] of basisByOrder) {
      if (!basis) continue;
      const mine = planned.filter((l) => l.salesOrderId === orderId);
      const thisNet = mine.reduce((s, l) => s + cents(l.creditNetBase ?? 0), 0);
      const priorInvoiceNet = await this.priorCreditedNetForInvoice(basis.invoiceId, manager);
      const totalNetC = cents(basis.totalNet);
      const taxC = cents(basis.taxAmount);
      if (priorInvoiceNet + thisNet > totalNetC) {
        throw new ConflictException(`Credited value would exceed the original net value of invoice ${basis.invoiceNumber}.`);
      }
      const taxCum = (netC: number) => (totalNetC > 0 ? Math.round((taxC * netC) / totalNetC) : 0);
      const taxThis = taxCum(priorInvoiceNet + thisNet) - taxCum(priorInvoiceNet);
      // allocate the tax across the lines for the per-line snapshot (remainder to the last line)
      let allocated = 0;
      mine.forEach((l, i) => {
        const share = i === mine.length - 1 ? taxThis - allocated : thisNet > 0 ? Math.round((taxThis * cents(l.creditNetBase ?? 0)) / thisNet) : 0;
        allocated += share;
        l.creditTaxBase = fromCents(share);
      });
      if (thisNet <= 0 && taxThis <= 0) continue; // nothing of value to reverse (e.g. a free item) — inventory/COGS only
      credits.push({
        invoiceId: basis.invoiceId,
        invoiceNumber: basis.invoiceNumber,
        customerId: basis.customerId,
        salesOrderId: orderId,
        net: fromCents(thisNet),
        tax: fromCents(taxThis),
        gross: fromCents(thisNet + taxThis),
      });
    }

    // 6. Resolve every GL account BEFORE any mutation (inventory + COGS always; Sales Returns/AR/tax when an invoice is reversed).
    const policy = this.postingPolicy.get();
    if (!policy) throw new ConflictException('Returns cannot be validated: the accounting posting policy is not available — nothing was changed.');
    if (credits.length === 0) await policy.assertSaleReturnPostable({ invoiceId: null, taxAmount: '0' }, manager);
    for (const credit of credits) await policy.assertSaleReturnPostable({ invoiceId: credit.invoiceId, taxAmount: credit.tax }, manager);

    return { lines: planned, credits };
  }

  /** The mutation half — must run in the SAME transaction (`manager`) as `plan()` and the document's own state transition. */
  async apply(
    kind: ReturnKind,
    doc: { id: string; number: string; customerId: string },
    plan: ReturnFinancialPlan,
    actorUserId: string,
    manager: EntityManager,
  ): Promise<void> {
    const lineTable = kind === 'sales_return' ? 'sales_return_lines' : 'shipment_return_lines';
    const headerTable = kind === 'sales_return' ? 'sales_returns' : 'shipment_returns';

    // Inventory leg: stock back in at the ORIGINAL cost → valuation restored + `Dr Inventory / Cr COGS` event.
    for (const line of plan.lines) {
      await this.inventory.recordSaleReturnIn(line.warehouseId, line.productId, line.quantity, line.unitCostBase, kind, doc.id, actorUserId, manager);
      await manager.query(
        `UPDATE "${lineTable}" SET "unitCostBase" = $1, "costTotalBase" = $2, "creditNetBase" = $3, "creditTaxBase" = $4, "creditInvoiceId" = $5 WHERE id = $6::uuid`,
        [line.unitCostBase, line.costTotalBase, line.creditNetBase, line.creditTaxBase, line.invoiceId, line.lineId],
      );
    }

    // Revenue / AR leg — only for an invoiced sale. Customer credit (ledger AR reduction) + `Dr Sales Returns [+ tax] / Cr AR` event.
    let creditedGross = 0;
    for (const credit of plan.credits) {
      await this.ledger.postEntry(
        {
          customerId: credit.customerId,
          entryType: 'return_credit_note',
          direction: 'credit',
          amount: credit.gross,
          salesOrderId: credit.salesOrderId,
          invoiceId: credit.invoiceId,
          reference: doc.number,
          reason: kind === 'sales_return' ? 'Sales return credit' : 'Shipment return credit',
          createdByUserId: actorUserId,
        },
        manager,
      );
      await this.events.publish(manager, AR_EVENT_TOPICS.salesReturnCredited, {
        idempotencyKey: `returns:${kind}:${doc.id}:${credit.invoiceId}:credited`,
        businessDate: new Date().toISOString().slice(0, 10),
        orgUnitId: null,
        currency: 'EGP',
        sourceEntityType: 'credit_note',
        sourceEntityId: doc.id,
        externalDocument: null,
        payloadVersion: 1,
        returnKind: kind,
        returnId: doc.id,
        returnNumber: doc.number,
        customerId: credit.customerId,
        invoiceId: credit.invoiceId,
        invoiceNumber: credit.invoiceNumber,
        salesOrderId: credit.salesOrderId,
        netAmount: credit.net,
        taxAmount: credit.tax,
        grossAmount: credit.gross,
      });
      await this.invoices.recomputeStatus(credit.invoiceId, actorUserId, manager);
      creditedGross += cents(credit.gross);
    }
    if (plan.credits.length > 0) {
      await manager.query(`UPDATE "${headerTable}" SET "creditedGrossBase" = $1 WHERE id = $2::uuid`, [fromCents(creditedGross), doc.id]);
    }
  }

  /** Quantity and Revenue already credited, across BOTH return types, against one ORIGINAL order line. */
  private async priorCreditedForOrderLine(salesOrderLineId: string, manager: EntityManager): Promise<{ qty: number; netCents: number }> {
    const rows: Array<{ qty: number; net: string }> = await manager.query(
      `SELECT COALESCE(SUM(q), 0)::int AS qty, COALESCE(SUM(n), 0)::text AS net FROM (
         SELECT "returnQuantity" AS q, "creditNetBase" AS n FROM "sales_return_lines"
          WHERE "sourceSalesOrderLineId" = $1::uuid AND "creditNetBase" IS NOT NULL
         UNION ALL
         SELECT srl."returnQuantity", srl."creditNetBase" FROM "shipment_return_lines" srl
           JOIN "shipment_lines" sl ON sl.id = srl."shipmentLineId"
          WHERE sl."salesOrderLineId" = $1::uuid AND srl."creditNetBase" IS NOT NULL
       ) x`,
      [salesOrderLineId],
    );
    return { qty: Number(rows[0].qty), netCents: cents(rows[0].net) };
  }

  /** Revenue already credited, across BOTH return types, against one ORIGINAL invoice. */
  private async priorCreditedNetForInvoice(invoiceId: string, manager: EntityManager): Promise<number> {
    const rows: Array<{ net: string }> = await manager.query(
      `SELECT COALESCE(SUM(n), 0)::text AS net FROM (
         SELECT "creditNetBase" AS n FROM "sales_return_lines" WHERE "creditInvoiceId" = $1::uuid
         UNION ALL
         SELECT "creditNetBase" FROM "shipment_return_lines" WHERE "creditInvoiceId" = $1::uuid
       ) x`,
      [invoiceId],
    );
    return cents(rows[0].net);
  }
}
