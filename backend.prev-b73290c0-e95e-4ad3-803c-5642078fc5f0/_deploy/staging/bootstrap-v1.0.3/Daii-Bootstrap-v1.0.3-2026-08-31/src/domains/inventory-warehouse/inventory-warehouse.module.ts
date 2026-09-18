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
  ],
  controllers: [InventoryController, WarehouseTransactionsController],
  providers: [InventoryService, WarehouseTransactionsService],
  exports: [InventoryService, WarehouseTransactionsService],
})
export class InventoryWarehouseModule {}
