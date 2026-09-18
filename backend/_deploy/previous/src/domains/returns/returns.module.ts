import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ReturnRequest } from './infrastructure/return-request.entity';
import { ReturnDisposition } from './infrastructure/return-disposition.entity';
import { ReturnCredit } from './infrastructure/return-credit.entity';
import { ReturnsService } from './application/returns.service';
import { ReturnsController } from './interface/returns.controller';
import { ProcessEngineModule } from '../../foundation/process-engine/process-engine.module';
import { AuthorizationModule } from '../../foundation/authorization/authorization.module';
import { AuditModule } from '../../foundation/audit/audit.module';
import { EventsModule } from '../../foundation/events/events.module';
import { AuthenticationModule } from '../../foundation/authentication/authentication.module';
import { NumberingModule } from '../../foundation/numbering/numbering.module';
import { InventoryWarehouseModule } from '../inventory-warehouse/inventory-warehouse.module';
import { SalesOrdersModule } from '../sales-orders/sales-orders.module';
import { ShipmentModule } from '../shipment/shipment.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { CustomerFinanceModule } from '../customer-finance/customer-finance.module';
import { CrmModule } from '../crm/crm.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([ReturnRequest, ReturnDisposition, ReturnCredit]),
    ProcessEngineModule,
    AuthorizationModule,
    AuditModule,
    EventsModule,
    AuthenticationModule,
    NumberingModule,
    InventoryWarehouseModule,
    SalesOrdersModule,
    // Returns Engine Phase B (custody returns) — one-directional, no
    // cycle: neither ShipmentModule nor DeliveryModule imports
    // ReturnsModule back.
    ShipmentModule,
    DeliveryModule,
    // Customer Financial Account / AR (CTO directive) — applyCreditToInvoice's
    // bridge into the Customer Ledger. One-directional, no cycle.
    CustomerFinanceModule,
    // ERP UI Integration (CTO directive) — listAllAvailableCredits' Scope
    // filtering via CustomersService.listCustomers. One-directional, no cycle.
    CrmModule,
  ],
  controllers: [ReturnsController],
  providers: [ReturnsService],
  exports: [ReturnsService],
})
export class ReturnsModule {}
