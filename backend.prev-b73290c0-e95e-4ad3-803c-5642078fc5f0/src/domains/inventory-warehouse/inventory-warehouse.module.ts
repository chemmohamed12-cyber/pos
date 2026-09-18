import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Warehouse } from './infrastructure/warehouse.entity';
import { StockMovement } from './infrastructure/stock-movement.entity';
import { StockReservation } from './infrastructure/stock-reservation.entity';
import { WarehouseTransaction } from './infrastructure/warehouse-transaction.entity';
import { WarehouseTransactionLine } from './infrastructure/warehouse-transaction-line.entity';
import { InventoryService } from './application/inventory.service';
import { WarehouseTransactionsService } from './application/warehouse-transactions.service';
import { InventoryController } from './interface/inventory.controller';
import { WarehouseTransactionsController } from './interface/warehouse-transactions.controller';
import { AuditModule } from '../../foundation/audit/audit.module';
import { AuthenticationModule } from '../../foundation/authentication/authentication.module';
import { AuthorizationModule } from '../../foundation/authorization/authorization.module';
import { CommerceModule } from '../commerce/commerce.module';
import { ExcelModule } from '../../foundation/excel/excel.module';
import { NumberingModule } from '../../foundation/numbering/numbering.module';
import { ProcessEngineModule } from '../../foundation/process-engine/process-engine.module';
import { INVENTORY_RESERVATION_CONTRACT, INVENTORY_LOGISTICS_CONTRACT } from '../../foundation/module-registry/contracts/inventory.contract';
import { PermissionModule } from '../../foundation/permission/permission.module';
import { EventsModule } from '../../foundation/events/events.module';
import { InventoryValuationModule } from '../inventory-valuation/inventory-valuation.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Warehouse, StockMovement, StockReservation, WarehouseTransaction, WarehouseTransactionLine]),
    AuditModule,
    AuthenticationModule,
    AuthorizationModule,
    CommerceModule,
    ExcelModule,
    NumberingModule,
    ProcessEngineModule,
    PermissionModule,
    // F07-H1 (ADR-040) — EventBusService, for the `inventory.movement.recorded`
    // transactional-outbox publish in `InventoryService.recordMovement`.
    EventsModule,
    // F08 (ADR-041 D18c) — binds INVENTORY_VALUATION_CONTRACT (`@Optional()` in InventoryService)
    // so the one approved opening-stock/receipt cost-input flow (D3/D7/D20) can reach F08's
    // valuation state. No import from `domains/inventory-valuation`'s own classes — DI token only.
    InventoryValuationModule,
  ],
  controllers: [InventoryController, WarehouseTransactionsController],
  providers: [
    InventoryService,
    WarehouseTransactionsService,
    { provide: INVENTORY_RESERVATION_CONTRACT, useExisting: InventoryService },
    { provide: INVENTORY_LOGISTICS_CONTRACT, useExisting: InventoryService },
  ],
  exports: [InventoryService, WarehouseTransactionsService, INVENTORY_RESERVATION_CONTRACT, INVENTORY_LOGISTICS_CONTRACT],
})
export class InventoryWarehouseModule {}
