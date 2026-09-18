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
import { CustomerFinanceModule } from '../customer-finance/customer-finance.module';

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
    // Customer Financial Account / AR (CTO directive) — one-directional,
    // no cycle: CustomerFinanceModule never imports DeliveryModule.
    CustomerFinanceModule,
  ],
  controllers: [DeliveryController],
  providers: [DeliveryService],
  exports: [DeliveryService],
})
export class DeliveryModule {}
