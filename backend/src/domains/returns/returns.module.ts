import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ReturnRequest } from './infrastructure/return-request.entity';
import { ReturnDisposition } from './infrastructure/return-disposition.entity';
import { ReturnCredit } from './infrastructure/return-credit.entity';
import { ShipmentReturn } from './infrastructure/shipment-return.entity';
import { ShipmentReturnLine } from './infrastructure/shipment-return-line.entity';
import { SalesReturn } from './infrastructure/sales-return.entity';
import { SalesReturnLine } from './infrastructure/sales-return-line.entity';
import { ReturnsService } from './application/returns.service';
import { ShipmentReturnsService } from './application/shipment-returns.service';
import { SalesReturnsService } from './application/sales-returns.service';
import { OrderLineReturnCapacityService } from './application/order-line-return-capacity.service';
import { ReturnFinancialsService } from './application/return-financials.service';
import { ReturnsController } from './interface/returns.controller';
import { ShipmentReturnsController } from './interface/shipment-returns.controller';
import { SalesReturnsController } from './interface/sales-returns.controller';
import { ProcessEngineModule } from '../../foundation/process-engine/process-engine.module';
import { AuthorizationModule } from '../../foundation/authorization/authorization.module';
import { AuditModule } from '../../foundation/audit/audit.module';
import { EventsModule } from '../../foundation/events/events.module';
import { AuthenticationModule } from '../../foundation/authentication/authentication.module';
import { PermissionModule } from '../../foundation/permission/permission.module';
import { NumberingModule } from '../../foundation/numbering/numbering.module';
import { InventoryWarehouseModule } from '../inventory-warehouse/inventory-warehouse.module';
import { SalesOrdersModule } from '../sales-orders/sales-orders.module';
import { ShipmentModule } from '../shipment/shipment.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { CustomerFinanceModule } from '../customer-finance/customer-finance.module';
import { CrmModule } from '../crm/crm.module';
import { LOGISTICS_RETURNS_CONTRACT } from '../../foundation/module-registry/contracts/logistics.contract';
import { CompanyModule } from '../../foundation/company/company.module';
import { DatabaseRegistryModule } from '../../foundation/database-registry/database-registry.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([ReturnRequest, ReturnDisposition, ReturnCredit, ShipmentReturn, ShipmentReturnLine, SalesReturn, SalesReturnLine]),
    ProcessEngineModule,
    AuthorizationModule,
    AuditModule,
    EventsModule,
    AuthenticationModule,
    PermissionModule,
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
    // Area 21 Operational Company Scoping Retrofit (2026-09-28) — for `CompanyContextGuard`
    // (first used by `SalesReturnsController`; `ReturnsController` stays BLOCKED, §23).
    CompanyModule,
    DatabaseRegistryModule,
  ],
  controllers: [ReturnsController, ShipmentReturnsController, SalesReturnsController],
  providers: [
    ReturnsService,
    // Sales/Shipment/Returns workflow review (CTO directive, 2026-09-16) — additive only,
    // ReturnsService/ReturnRequest untouched. Neither new service implements
    // LOGISTICS_RETURNS_CONTRACT (that contract's shape is ReturnRequest-specific); they are
    // consumed directly by their own controllers only, same as any other domain service that
    // has no cross-module contract yet.
    ShipmentReturnsService,
    SalesReturnsService,
    // Cross-Return Data Integrity (CTO-approved Option 1, 2026-09-16) — a stateless
    // lock/query helper, NOT a new Return Ledger entity. Both services above depend on
    // it independently; it depends on neither of them (no service-to-service coupling
    // between ShipmentReturnsService and SalesReturnsService).
    OrderLineReturnCapacityService,
    // D4 (2026-10-05) — the ONE financial policy (cost, original invoice value, accounts, ledger credit) both return types share.
    ReturnFinancialsService,
    { provide: LOGISTICS_RETURNS_CONTRACT, useExisting: ReturnsService },
  ],
  exports: [ReturnsService, ShipmentReturnsService, SalesReturnsService, LOGISTICS_RETURNS_CONTRACT],
})
export class ReturnsModule {}
