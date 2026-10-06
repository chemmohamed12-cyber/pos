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
import { FULFILLMENT_CONTRACT } from '../../foundation/module-registry/contracts/inventory.contract';
import { CompanyModule } from '../../foundation/company/company.module';
import { DatabaseRegistryModule } from '../../foundation/database-registry/database-registry.module';

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
    // Area 21 Operational Company Scoping Retrofit (2026-09-28) — for
    // `CompanyContextGuard`. `DatabaseRegistryModule` alongside it, the
    // same required pairing discovered during `products.controller.ts`'s
    // retrofit.
    CompanyModule,
    DatabaseRegistryModule,
  ],
  controllers: [FulfillmentController],
  providers: [FulfillmentService, { provide: FULFILLMENT_CONTRACT, useExisting: FulfillmentService }],
  exports: [FulfillmentService, FULFILLMENT_CONTRACT],
})
export class FulfillmentModule {}
