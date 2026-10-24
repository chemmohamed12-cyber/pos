import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WorkOrder } from './infrastructure/work-order.entity';
import { WorkOrderComponent } from './infrastructure/work-order-component.entity';
import { WorkCenter } from './infrastructure/work-center.entity';
import { Routing } from './infrastructure/routing.entity';
import { RoutingOperation } from './infrastructure/routing-operation.entity';
import { WorkOrderOperation } from './infrastructure/work-order-operation.entity';
import { WorkOrderResult } from './infrastructure/work-order-result.entity';
import { ProductUnitConversion } from './infrastructure/product-unit-conversion.entity';
import { UnitConversionService } from './application/unit-conversion.service';
import { UnitConversionController } from './interface/unit-conversion.controller';
import { WorkCenterService } from './application/work-center.service';
import { RoutingService } from './application/routing.service';
import { ManufacturingBomController } from './interface/manufacturing-bom.controller';
import { WorkCenterController } from './interface/work-center.controller';
import { RoutingController } from './interface/routing.controller';
import { WorkOrderService } from './application/work-order.service';
import { ManufacturingWipLedgerService } from './application/manufacturing-wip-ledger.service';
import { WorkOrderController } from './interface/work-order.controller';
import { MANUFACTURING_WIP_CONTRACT } from '../../foundation/module-registry/contracts/manufacturing-wip.contract';
import { AuditModule } from '../../foundation/audit/audit.module';
import { AuthenticationModule } from '../../foundation/authentication/authentication.module';
import { AuthorizationModule } from '../../foundation/authorization/authorization.module';
import { NumberingModule } from '../../foundation/numbering/numbering.module';
import { ProcessEngineModule } from '../../foundation/process-engine/process-engine.module';
import { PermissionModule } from '../../foundation/permission/permission.module';
import { EventsModule } from '../../foundation/events/events.module';
import { CommerceModule } from '../commerce/commerce.module';
import { InventoryWarehouseModule } from '../inventory-warehouse/inventory-warehouse.module';
import { InventoryValuationModule } from '../inventory-valuation/inventory-valuation.module';
import { CompanyModule } from '../../foundation/company/company.module';
import { DatabaseRegistryModule } from '../../foundation/database-registry/database-registry.module';

/**
 * ADR-061 — Manufacturing (`depends_on: ['sales', 'inventory']` per the
 * manifest). `CommerceModule` for `SALES_BOM_CONTRACT` (BOM read),
 * `InventoryWarehouseModule` for the concrete `InventoryService`
 * (`recordMovement`/reservations — the same direct-import pattern
 * Procurement's `GoodsReceiptService` already uses), `InventoryValuationModule`
 * for F08 (`INVENTORY_VALUATION_CONTRACT`, REQUIRED here, not `@Optional()`).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([WorkOrder, WorkOrderComponent, WorkCenter, Routing, RoutingOperation, WorkOrderOperation, WorkOrderResult, ProductUnitConversion]),
    AuditModule,
    AuthenticationModule,
    AuthorizationModule,
    PermissionModule,
    NumberingModule,
    ProcessEngineModule,
    EventsModule,
    CommerceModule,
    InventoryWarehouseModule,
    InventoryValuationModule,
    // Area 21 Operational Company Scoping Retrofit (2026-09-28) — for `CompanyContextGuard`.
    CompanyModule,
    DatabaseRegistryModule,
  ],
  controllers: [WorkOrderController, ManufacturingBomController, WorkCenterController, RoutingController, UnitConversionController],
  providers: [
    UnitConversionService,
    WorkOrderService,
    WorkCenterService,
    RoutingService,
    ManufacturingWipLedgerService,
    // Month-End dependency (independent review, Phase 1) — MANUFACTURING_WIP_CONTRACT's real
    // implementation, mirroring `GRNI_LEDGER_CONTRACT: useExisting: GrniLedgerService` exactly.
    { provide: MANUFACTURING_WIP_CONTRACT, useExisting: ManufacturingWipLedgerService },
  ],
  exports: [UnitConversionService, WorkOrderService, RoutingService, WorkCenterService, MANUFACTURING_WIP_CONTRACT],
})
export class ManufacturingModule {}
