import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WorkOrder } from './infrastructure/work-order.entity';
import { WorkOrderComponent } from './infrastructure/work-order-component.entity';
import { WorkOrderService } from './application/work-order.service';
import { WorkOrderController } from './interface/work-order.controller';
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
    TypeOrmModule.forFeature([WorkOrder, WorkOrderComponent]),
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
  ],
  controllers: [WorkOrderController],
  providers: [WorkOrderService],
  exports: [WorkOrderService],
})
export class ManufacturingModule {}
