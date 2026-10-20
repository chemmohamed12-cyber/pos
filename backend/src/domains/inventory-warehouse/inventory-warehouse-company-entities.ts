import { StockMovement } from './infrastructure/stock-movement.entity';
import { StockReservation } from './infrastructure/stock-reservation.entity';
import { Warehouse } from './infrastructure/warehouse.entity';
import { WarehouseItem } from './infrastructure/warehouse-item.entity';
import { WarehouseTransaction } from './infrastructure/warehouse-transaction.entity';
import { WarehouseTransactionLine } from './infrastructure/warehouse-transaction-line.entity';
import { OpeningBatch } from './infrastructure/opening-batch.entity';
import { OpeningBatchLine } from './infrastructure/opening-batch-line.entity';

/**
 * ADR-074 (2026-09-25, CTO Decision: Hybrid B). Inventory Warehouse's own
 * Company-connection-capable entities (`InventoryService`, reached today
 * via `PreliminaryHoldExpiryScheduler`). `WarehouseTransaction`/
 * `WarehouseTransactionLine` added 2026-09-28 (Area 21 Operational Company
 * Scoping Retrofit, `warehouse-transactions.controller.ts`'s own turn) —
 * found missing entirely by the real-PG isolation spec, the same shape as
 * Delivery (§34) and Deposits (§36).
 */
// C4 (ADR-INV-01): the Opening Balance Batch header and lines are Company-scoped.
export const INVENTORY_WAREHOUSE_COMPANY_ENTITIES = [StockMovement, StockReservation, Warehouse, WarehouseTransaction, WarehouseTransactionLine, WarehouseItem, OpeningBatch, OpeningBatchLine];
