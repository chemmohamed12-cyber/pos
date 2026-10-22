import { DeliveryOutcome } from './infrastructure/delivery-outcome.entity';
import { Collection } from './infrastructure/collection.entity';
import { ShipmentCustody } from './infrastructure/shipment-custody.entity';
import { ShipmentLineDelivery } from './infrastructure/shipment-line-delivery.entity';
import { CustodyExpense } from './infrastructure/custody-expense.entity';

/**
 * ADR-074 (2026-09-25, CTO Decision: Hybrid B). Delivery's own
 * Company-connection-capable entities — added 2026-09-28 (Area 21
 * Operational Company Scoping Retrofit, `delivery.controller.ts`'s own
 * turn, §34). Found missing entirely (not merely unguarded) by the
 * real-PG isolation spec's first run — `EntityMetadataNotFoundError`,
 * a genuine production gap, not a test-harness artifact: any Company
 * DataSource would have thrown the same error on a live request.
 */
export const DELIVERY_COMPANY_ENTITIES = [DeliveryOutcome, Collection, ShipmentCustody, ShipmentLineDelivery, CustodyExpense];
