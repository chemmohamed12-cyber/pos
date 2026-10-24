import { WorkOrder } from './infrastructure/work-order.entity';
import { WorkOrderComponent } from './infrastructure/work-order-component.entity';
import { WorkCenter } from './infrastructure/work-center.entity';
import { Routing } from './infrastructure/routing.entity';
import { RoutingOperation } from './infrastructure/routing-operation.entity';
import { WorkOrderOperation } from './infrastructure/work-order-operation.entity';
import { WorkOrderResult } from './infrastructure/work-order-result.entity';

/**
 * ADR-074 (2026-09-25, CTO Decision: Hybrid B). Manufacturing's own
 * Company-connection-capable entities — added 2026-09-28 (Area 21
 * Operational Company Scoping Retrofit, `work-order.controller.ts`'s own
 * turn). Found missing entirely (not merely unguarded), the same shape as
 * Delivery (§34) / Deposits (§36) / Warehouse Transactions (§37).
 *
 * 2026-10-06 (ADR-061 Addendum 1): Work Centers, Routings (+ operations) and the Work Order
 * operation snapshot join the registry so they live in each Company's own database.
 */
export const MANUFACTURING_COMPANY_ENTITIES = [WorkOrder, WorkOrderComponent, WorkCenter, Routing, RoutingOperation, WorkOrderOperation, WorkOrderResult];
