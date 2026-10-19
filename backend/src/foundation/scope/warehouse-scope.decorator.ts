import { SetMetadata } from '@nestjs/common';

/**
 * Authorization Foundation F6 — declares WHERE a route's warehouse comes from, so `WarehouseScopeGuard` can enforce the caller's scope before the handler runs.
 * Pilot domains only (A4): inventory / warehouse transactions, PR / PO / GR, sales orders. The sources are declarative, so the coverage spec can prove every route
 * of a pilot controller is either scoped here, filtered in its service (lists/reports), or explicitly exempt with a reason.
 */
export const WAREHOUSE_KEYED_TABLES = {
  warehouses: { table: 'warehouses', columns: ['id'] }, // the id IS the warehouse
  warehouse_transactions: { table: 'warehouse_transactions', columns: ['warehouseId', 'destinationWarehouseId'] }, // a transfer needs BOTH sides in scope
  stock_movements: { table: 'stock_movements', columns: ['warehouseId'] },
  inventory_opening_batches: { table: 'inventory_opening_batches', columns: ['warehouseId'] }, // C4
  stock_reservations: { table: 'stock_reservations', columns: ['warehouseId'] },
  purchase_requests: { table: 'purchase_requests', columns: ['warehouseId'] },
  purchase_orders: { table: 'purchase_orders', columns: ['warehouseId'] },
  goods_receipts: { table: 'goods_receipts', columns: ['warehouseId'] },
  sales_orders: { table: 'sales_orders', columns: ['warehouseId'] },
} as const;
export type WarehouseKeyedTable = keyof typeof WAREHOUSE_KEYED_TABLES;

export type WarehouseScopeSource =
  | { query: string } // ?warehouseId=...
  | { param: string } // /:warehouseId
  | { body: string } // { warehouseId } (also { fromWarehouseId, toWarehouseId } as two sources)
  | { recordOf: WarehouseKeyedTable; param?: string; query?: string; body?: string }; // the id of a warehouse-keyed record (path / query / body) -> its warehouseId

export const WAREHOUSE_SCOPE_KEY = 'daii:warehouse-scope-sources';
export const WAREHOUSE_SCOPE_FILTERED_KEY = 'daii:warehouse-scope-filtered';
export const WAREHOUSE_SCOPE_EXEMPT_KEY = 'daii:warehouse-scope-exempt';

/** The route addresses (or creates something in) the warehouse(s) found at these sources: outside the caller's scope -> 404 before the handler runs. */
export const WarehouseScoped = (...sources: WarehouseScopeSource[]) => SetMetadata(WAREHOUSE_SCOPE_KEY, sources);

/** The route returns a LIST/report: its service filters by the caller's visible warehouses (documented marker; the filter itself is in the service query). */
export const WarehouseScopeFiltered = (note: string) => SetMetadata(WAREHOUSE_SCOPE_FILTERED_KEY, note);

/** The route is deliberately outside warehouse scope (templates, lookups, reasons) — a reviewable declaration, never an omission. */
export const WarehouseScopeExempt = (reason: string) => SetMetadata(WAREHOUSE_SCOPE_EXEMPT_KEY, reason);
