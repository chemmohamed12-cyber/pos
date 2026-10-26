import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DeliveryOutcome } from './infrastructure/delivery-outcome.entity';
import { Collection } from './infrastructure/collection.entity';
import { ShipmentCustody } from './infrastructure/shipment-custody.entity';
import { ShipmentLineDelivery } from './infrastructure/shipment-line-delivery.entity';
import { LineDeliveryService } from './application/line-delivery.service';
import { CustodyExpense } from './infrastructure/custody-expense.entity';
import { CustodyExpenseService } from './application/custody-expense.service';
import { CustodyHandover } from './infrastructure/custody-handover.entity';
import { CustodyHandoverService } from './application/custody-handover.service';
import { DeliveryOrgScopeService } from './application/delivery-org-scope.service';
import { ApprovalEngineModule } from '../../foundation/approval-engine/approval-engine.module';
import { ScopeModule } from '../../foundation/scope/scope.module';
import { DeliveryService } from './application/delivery.service';
import { DeliveryController } from './interface/delivery.controller';
import { VehicleWorkspaceService } from './application/vehicle-workspace.service';
import { VehicleWorkspaceController } from './interface/vehicle-workspace.controller';
import { ShipmentModule } from '../shipment/shipment.module';
import { FulfillmentModule } from '../fulfillment/fulfillment.module';
import { SalesOrdersModule } from '../sales-orders/sales-orders.module';
import { TreasuryModule } from '../treasury/treasury.module';
import { InventoryWarehouseModule } from '../inventory-warehouse/inventory-warehouse.module';
import { AuditModule } from '../../foundation/audit/audit.module';
import { NumberingModule } from '../../foundation/numbering/numbering.module';
import { EventsModule } from '../../foundation/events/events.module';
import { AuthenticationModule } from '../../foundation/authentication/authentication.module';
import { AuthorizationModule } from '../../foundation/authorization/authorization.module';
import { PermissionModule } from '../../foundation/permission/permission.module';
import { CustomerFinanceModule } from '../customer-finance/customer-finance.module';
import { LOGISTICS_DELIVERY_CONTRACT } from '../../foundation/module-registry/contracts/logistics.contract';
import { CompanyModule } from '../../foundation/company/company.module';
import { DatabaseRegistryModule } from '../../foundation/database-registry/database-registry.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([DeliveryOutcome, Collection, ShipmentCustody, ShipmentLineDelivery, CustodyExpense, CustodyHandover]),
    ShipmentModule,
    FulfillmentModule,
    SalesOrdersModule,
    TreasuryModule,
    InventoryWarehouseModule,
    AuditModule,
    NumberingModule,
    ApprovalEngineModule,
    ScopeModule, // org-engine branch scope on the vehicle endpoints (integration of the org engine and the vehicle workspace)
    EventsModule,
    AuthenticationModule,
    AuthorizationModule,
    PermissionModule,
    // Customer Financial Account / AR (CTO directive) — one-directional,
    // no cycle: CustomerFinanceModule never imports DeliveryModule.
    CustomerFinanceModule,
    // Area 21 Operational Company Scoping Retrofit (2026-09-28) — for
    // `CompanyContextGuard`. `DatabaseRegistryModule` alongside it, the
    // same required pairing discovered during `products.controller.ts`'s
    // retrofit.
    CompanyModule,
    DatabaseRegistryModule,
  ],
  controllers: [DeliveryController, VehicleWorkspaceController],
  providers: [DeliveryService, LineDeliveryService, CustodyExpenseService, CustodyHandoverService, DeliveryOrgScopeService, VehicleWorkspaceService, { provide: LOGISTICS_DELIVERY_CONTRACT, useExisting: DeliveryService }],
  exports: [DeliveryService, LOGISTICS_DELIVERY_CONTRACT],
})
export class DeliveryModule {}
