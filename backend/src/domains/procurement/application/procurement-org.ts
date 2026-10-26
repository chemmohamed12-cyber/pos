import { EntityManager } from 'typeorm';

/**
 * Org engine Stage 6 — the organizational reference of procurement documents, derived on the server from business relationships (never a client field).
 * `purchase_orders.orgUnitId` (an existing column) is the stamp: set from the ordering warehouse's owning branch when the PO is created. Receipts, supplier
 * invoices, credit notes and returns carry the PO (or their own warehouse), so their financial events resolve the SAME branch — which is what lets the ledger
 * and the reports split by branch. A document with no branch information resolves to `null` (legacy / unassigned): no default branch is ever invented.
 */
export async function warehouseBranchOf(m: EntityManager, warehouseId: string | null | undefined): Promise<string | null> {
  if (!warehouseId) return null;
  const rows: Array<{ unit: string | null }> = await m.query(
    `SELECT COALESCE(w."orgUnitId", p."orgUnitId") AS unit FROM "warehouses" w LEFT JOIN "warehouses" p ON p."id" = w."parentWarehouseId" WHERE w."id" = $1`,
    [warehouseId],
  );
  return rows[0]?.unit ?? null;
}

/** The branch stamped on a purchase order when it was created (`null` for a legacy / unassigned order). */
export async function purchaseOrderBranchOf(m: EntityManager, purchaseOrderId: string | null | undefined): Promise<string | null> {
  if (!purchaseOrderId) return null;
  const rows: Array<{ unit: string | null }> = await m.query(`SELECT "orgUnitId" AS unit FROM "purchase_orders" WHERE "id" = $1`, [purchaseOrderId]);
  return rows[0]?.unit ?? null;
}
