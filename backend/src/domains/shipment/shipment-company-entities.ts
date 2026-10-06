import { Shipment } from './infrastructure/shipment.entity';
import { ShipmentLine } from './infrastructure/shipment-line.entity';
import { ShippingCompany } from './infrastructure/shipping-company.entity';
import { TrackingEvent } from './infrastructure/tracking-event.entity';
import { Vehicle } from './infrastructure/vehicle.entity';

/**
 * ADR-074 (2026-09-25, CTO Decision: Hybrid B). Shipment's own
 * Company-connection-capable entities (`ShipmentService`).
 */
export const SHIPMENT_COMPANY_ENTITIES = [Shipment, ShipmentLine, ShippingCompany, TrackingEvent, Vehicle];
