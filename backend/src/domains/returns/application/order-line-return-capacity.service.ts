import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

export interface OrderLineReturnCapacity {
  soldQuantity: number;
  shippedQuantity: number;
  returnedViaSalesReturn: number;
  returnedViaShipmentReturn: number;
  /** `min(soldQuantity, shippedQuantity)` — the CTO-approved invariant ceiling (2026-09-16, Cross-Return Data Integrity, Option 1). */
  cap: number;
  remaining: number;
}

/**
 * Cross-Return Data Integrity (CTO-approved Option 1, 2026-09-16).
 *
 * NOT a new Return Ledger entity — no table, no persisted state. A
 * stateless query/lock helper both `ShipmentReturnsService` and
 * `SalesReturnsService` depend on INDEPENDENTLY (neither imports or
 * calls the other — the explicit ban on service-to-service coupling
 * between the two return paths). The shared invariant:
 *
 *   Σ(non-rejected SalesReturnLine.returnQty for this order line)
 * + Σ(non-rejected ShipmentReturnLine.returnQty for this order line)
 *  <= min(SalesOrderLine.quantity, Σ ShipmentLine.quantity for this order line)
 *
 * is enforced by both callers reading through THIS class, inside their
 * OWN transaction, using their OWN `manager` — never by either service
 * calling the other's methods.
 *
 * Locking: `getLockedCapacity` takes a `SELECT ... FOR UPDATE` on the
 * `sales_order_lines` row itself — the single shared serialization
 * boundary for both return types (ADR-008/existing-codebase row-lock
 * pattern, same shape as `NumberingService.getNextNumber`'s own lock).
 * `ShipmentLine.quantity` is write-once/immutable after `createShipment`
 * — it never needs its own lock, only the *cumulative-returned* reads
 * derived from it are contended, and those are always read under this
 * same lock. Callers touching more than one order line in one request
 * MUST call this once per distinct id, in ascending-id order, before
 * validating any of them — the same deterministic-lock-order discipline
 * both services already use — to avoid a cross-request deadlock.
 */
@Injectable()
export class OrderLineReturnCapacityService {
  async getLockedCapacity(manager: EntityManager, salesOrderLineId: string): Promise<OrderLineReturnCapacity> {
    // Explicit `::uuid` casts throughout (matching the existing precedent in
    // `accounting/application/fixed-asset-reconciliation.service.ts`) — without them, the pg
    // driver can send a bare string parameter typed as `character varying`, and Postgres then
    // refuses `uuid = character varying` outright (caught live during verification: a real
    // `QueryFailedError`, not a hypothetical).
    const lineRows: Array<{ quantity: number }> = await manager.query(
      `SELECT quantity FROM "sales_order_lines" WHERE id = $1::uuid FOR UPDATE`,
      [salesOrderLineId],
    );
    if (lineRows.length === 0) {
      throw new NotFoundException(`Sales order line "${salesOrderLineId}" not found.`);
    }
    const soldQuantity = Number(lineRows[0].quantity);

    const shippedRows: Array<{ sum: string }> = await manager.query(
      `SELECT COALESCE(SUM(quantity), 0)::text as sum FROM "shipment_lines" WHERE "salesOrderLineId" = $1::uuid`,
      [salesOrderLineId],
    );
    const shippedQuantity = Number(shippedRows[0].sum);

    // Non-rejected only — a rejected header's lines must not consume capacity. `COALESCE(pi."currentState", 'requested')`
    // treats a header with no process instance yet (should never happen — `start()` runs in the same transaction as the
    // header insert) as still-active rather than silently excluding it.
    // `process_instances."entityId"` is a polymorphic `character varying(255)` (it stores ids for
    // many different entity types, not all of which are uuids) — the uuid side of the join must be
    // cast to `::text` explicitly, the same direction this column is written in elsewhere
    // (ProcessEngineService.start/transition pass entityId as a plain string). Caught live during
    // verification: a second, distinct `QueryFailedError` from the one the `$1::uuid` fix resolved.
    const salesRows: Array<{ sum: string }> = await manager.query(
      `SELECT COALESCE(SUM(srl."returnQuantity"), 0)::text as sum
       FROM "sales_return_lines" srl
       JOIN "sales_returns" sr ON sr.id = srl."salesReturnId"
       LEFT JOIN "process_instances" pi ON pi."definitionKey" = 'sales_return' AND pi."entityType" = 'sales_return' AND pi."entityId" = sr.id::text
       WHERE srl."sourceSalesOrderLineId" = $1::uuid
         AND COALESCE(pi."currentState", 'requested') != 'rejected'`,
      [salesOrderLineId],
    );
    const returnedViaSalesReturn = Number(salesRows[0].sum);

    const shipmentRows: Array<{ sum: string }> = await manager.query(
      `SELECT COALESCE(SUM(srl."returnQuantity"), 0)::text as sum
       FROM "shipment_return_lines" srl
       JOIN "shipment_returns" sr ON sr.id = srl."shipmentReturnId"
       JOIN "shipment_lines" sl ON sl.id = srl."shipmentLineId"
       LEFT JOIN "process_instances" pi ON pi."definitionKey" = 'shipment_return' AND pi."entityType" = 'shipment_return' AND pi."entityId" = sr.id::text
       WHERE sl."salesOrderLineId" = $1::uuid
         AND COALESCE(pi."currentState", 'requested') != 'rejected'`,
      [salesOrderLineId],
    );
    const returnedViaShipmentReturn = Number(shipmentRows[0].sum);

    const cap = Math.min(soldQuantity, shippedQuantity);
    const remaining = cap - returnedViaSalesReturn - returnedViaShipmentReturn;

    return { soldQuantity, shippedQuantity, returnedViaSalesReturn, returnedViaShipmentReturn, cap, remaining };
  }
}
