import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FulfillmentOrder } from './infrastructure/fulfillment-order.entity';
import { PickTask } from './infrastructure/pick-task.entity';
import { PackTask } from './infrastructure/pack-task.entity';
import { PickTaskLine } from './infrastructure/pick-task-line.entity';
import { FulfillmentService } from './application/fulfillment.service';
import { FulfillmentController } from './interface/fulfillment.controller';
import { ProcessEngineModule } from '../../foundation/process-engine/process-engine.module';
import { AuthorizationModule } from '../../foundation/authorization/authorization.module';
import { AuditModule } from '../../foundation/audit/audit.module';
import { EventsModule } from '../../foundation/events/events.module';
import { AuthenticationModule } from '../../foundation/authentication/authentication.module';
import { InventoryWarehouseModule } from '../inventory-warehouse/inventory-warehouse.module';
import { NumberingModule } from '../../foundation/numbering/numbering.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([FulfillmentOrder, PickTask, PackTask, PickTaskLine]),
    ProcessEngineModule,
    AuthorizationModule,
    AuditModule,
    EventsModule,
    AuthenticationModule,
    InventoryWarehouseModule,
    NumberingModule,
  ],
  controllers: [FulfillmentController],
  providers: [FulfillmentService],
  exports: [FulfillmentService],
})
export class FulfillmentModule {}
