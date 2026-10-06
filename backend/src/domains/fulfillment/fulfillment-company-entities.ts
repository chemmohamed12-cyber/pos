import { FulfillmentOrder } from './infrastructure/fulfillment-order.entity';
import { PickTask } from './infrastructure/pick-task.entity';
import { PickTaskLine } from './infrastructure/pick-task-line.entity';
import { PackTask } from './infrastructure/pack-task.entity';

/**
 * ADR-074 (2026-09-25, CTO Decision: Hybrid B). Fulfillment's own
 * Company-connection-capable entities — added 2026-09-27 (Area 21
 * Operational Company Scoping Retrofit) when `FulfillmentService.
 * getFulfillmentOrder`/`getFulfillmentOrderBySalesOrderId` became
 * `manager?`-capable (needed by `ShipmentService`/`ReturnsService` via
 * `FulfillmentContract` — Fulfillment has no controller of its own in
 * the 43, so this fix has no other "owning turn," see
 * AREA21-RETROFIT-MATRIX.md §26).
 */
export const FULFILLMENT_COMPANY_ENTITIES = [FulfillmentOrder, PickTask, PickTaskLine, PackTask];
