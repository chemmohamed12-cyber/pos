import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Shipment } from './infrastructure/shipment.entity';
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
import { InventoryWarehouseModule } from '../inventory-warehouse/inventory-warehouse.module';
import { FulfillmentModule } from '../fulfillment/fulfillment.module';
import { TreasuryModule } from '../treasury/treasury.module';
import { SalesOrdersModule } from '../sales-orders/sales-orders.module';
import { CrmModule } from '../crm/crm.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Shipment, TrackingEvent, ShippingCompany, Vehicle]),
    NumberingModule,
    ProcessEngineModule,
    AuthorizationModule,
    AuditModule,
    EventsModule,
    AuthenticationModule,
    InventoryWarehouseModule,
    FulfillmentModule,
    TreasuryModule,
    // RSH Shipping Orders (CTO directive §3) — one-directional, no cycle:
    // SalesOrdersModule has no need to import ShipmentModule.
    SalesOrdersModule,
    // Returns Engine Phase B custody search ("search by Customer Code") —
    // one-directional, no cycle: CrmModule has no need to import ShipmentModule.
    CrmModule,
  ],
  controllers: [ShipmentController],
  providers: [ShipmentService],
  exports: [ShipmentService],
})
export class ShipmentModule {}
