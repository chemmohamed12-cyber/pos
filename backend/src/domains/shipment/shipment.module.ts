import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Shipment } from './infrastructure/shipment.entity';
import { ShipmentLine } from './infrastructure/shipment-line.entity';
import { TrackingEvent } from './infrastructure/tracking-event.entity';
import { ShippingCompany } from './infrastructure/shipping-company.entity';
import { Vehicle } from './infrastructure/vehicle.entity';
import { ShipmentService } from './application/shipment.service';
import { ShipmentController } from './interface/shipment.controller';
import { NumberingModule } from '../../foundation/numbering/numbering.module';
import { ProcessEngineModule } from '../../foundation/process-engine/process-engine.module';
import { AuthorizationModule } from '../../foundation/authorization/authorization.module';
import { AuditModule } from '../../foundation/audit/audit.module';
import { EventsModule } from '../../foundation/events/events.module';
import { AuthenticationModule } from '../../foundation/authentication/authentication.module';
import { PermissionModule } from '../../foundation/permission/permission.module';
import { InventoryWarehouseModule } from '../inventory-warehouse/inventory-warehouse.module';
import { FulfillmentModule } from '../fulfillment/fulfillment.module';
import { TreasuryModule } from '../treasury/treasury.module';
import { SalesOrdersModule } from '../sales-orders/sales-orders.module';
import { CrmModule } from '../crm/crm.module';
import { IdentityModule } from '../../foundation/identity/identity.module';
import { LOGISTICS_SHIPMENT_CONTRACT } from '../../foundation/module-registry/contracts/logistics.contract';
import { CompanyModule } from '../../foundation/company/company.module';
import { DatabaseRegistryModule } from '../../foundation/database-registry/database-registry.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Shipment, ShipmentLine, TrackingEvent, ShippingCompany, Vehicle]),
    NumberingModule,
    ProcessEngineModule,
    AuthorizationModule,
    AuditModule,
    EventsModule,
    AuthenticationModule,
    PermissionModule,
    InventoryWarehouseModule,
    FulfillmentModule,
    TreasuryModule,
    // RSH Shipping Orders (CTO directive §3) — one-directional, no cycle:
    // SalesOrdersModule has no need to import ShipmentModule.
    SalesOrdersModule,
    // Returns Engine Phase B custody search ("search by Customer Code") —
    // one-directional, no cycle: CrmModule has no need to import ShipmentModule.
    CrmModule,
    // Warehouse / Shipment Operations Requirement (2026-09-17) — resolves
    // `salesRepUserId` to a display name for the board view (`listShipments`/
    // `listShipmentsPage`), the same foundation-level (not domain-to-domain)
    // import every other foundation service here already uses directly, no
    // contract indirection needed (ADR-027 only gates domain↔domain imports).
    IdentityModule,
    // Area 21 Operational Company Scoping Retrofit (2026-09-27) — for
    // `CompanyContextGuard`. `DatabaseRegistryModule` alongside it, the
    // same required pairing discovered during `products.controller.ts`'s
    // retrofit.
    CompanyModule,
    DatabaseRegistryModule,
  ],
  controllers: [ShipmentController],
  providers: [ShipmentService, { provide: LOGISTICS_SHIPMENT_CONTRACT, useExisting: ShipmentService }],
  exports: [ShipmentService, LOGISTICS_SHIPMENT_CONTRACT],
})
export class ShipmentModule {}
