import { SalesOrder } from './infrastructure/sales-order.entity';
import { SalesOrderLine } from './infrastructure/sales-order-line.entity';

/**
 * ADR-074 (2026-09-25, CTO Decision: Hybrid B). Sales Orders' own
 * Company-connection-capable entities (`SalesOrdersService`, reached
 * today via `PreliminaryHoldExpiryScheduler.expireHoldForOrder`).
 */
export const SALES_ORDERS_COMPANY_ENTITIES = [SalesOrder, SalesOrderLine];
