import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DeliveryOutcome } from './infrastructure/delivery-outcome.entity';
import { Collection } from './infrastructure/collection.entity';
import { DeliveryService } from './application/delivery.service';
import { DeliveryController } from './interface/delivery.controller';
import { ShipmentModule } from '../shipment/shipment.module';
import { FulfillmentModule } from '../fulfillment/fulfillment.module';
import { SalesOrdersModule } from '../sales-orders/sales-orders.module';
import { TreasuryModule } from '../treasury/treasury.module';
import { InventoryWarehouseModule } from '../inventory-warehouse/inventory-warehouse.module';
import { AuditModule } from '../../foundation/audit/audit.module';
import { EventsModule } from '../../foundation/events/events.module';
import { AuthenticationModule } from '../../foundation/authentication/authentication.module';
import { AuthorizationModule } from '../../foundation/authorization/authorization.module';
import { PermissionModule } from '../../foundation/permission/permission.module';
import { CustomerFinanceModule } from '../customer-finance/customer-finance.module';
import { LOGISTICS_DELIVERY_CONTRACT } from '../../foundation/module-registry/contracts/logistics.contract';

@Module({
  imports: [
    TypeOrmModule.forFeature([DeliveryOutcome, Collection]),
    ShipmentModule,
    FulfillmentModule,
    SalesOrdersModule,
    TreasuryModule,
    InventoryWarehouseModule,
    AuditModule,
    EventsModule,
    AuthenticationModule,
    AuthorizationModule,
    PermissionModule,
    // Customer Financial Account / AR (CTO directive) — one-directional,
    // no cycle: CustomerFinanceModule never imports DeliveryModule.
    CustomerFinanceModule,
  ],
  controllers: [DeliveryController],
  providers: [DeliveryService, { provide: LOGISTICS_DELIVERY_CONTRACT, useExisting: DeliveryService }],
  exports: [DeliveryService, LOGISTICS_DELIVERY_CONTRACT],
})
export class DeliveryModule {}
