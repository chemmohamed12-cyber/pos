import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SalesOrder } from './infrastructure/sales-order.entity';
import { SalesOrderLine } from './infrastructure/sales-order-line.entity';
import { SalesOrdersService } from './application/sales-orders.service';
import { PreliminaryHoldExpiryScheduler } from './application/preliminary-hold-expiry.scheduler';
import { SalesOrdersController } from './interface/sales-orders.controller';
import { CommerceModule } from '../commerce/commerce.module';
import { CrmModule } from '../crm/crm.module';
import { NumberingModule } from '../../foundation/numbering/numbering.module';
import { ScopeModule } from '../../foundation/scope/scope.module';
import { AuditModule } from '../../foundation/audit/audit.module';
import { AuthorizationModule } from '../../foundation/authorization/authorization.module';
import { ProcessEngineModule } from '../../foundation/process-engine/process-engine.module';
import { AuthenticationModule } from '../../foundation/authentication/authentication.module';
import { IdentityModule } from '../../foundation/identity/identity.module';
import { InventoryWarehouseModule } from '../inventory-warehouse/inventory-warehouse.module';

/**
 * Consumes Commerce and CRM only through their exported services
 * (CommerceModule's ProductsService, CrmModule's CustomersService — Gap
 * G-1's workflow-policy snapshot) per DAII_DOMAIN_BOUNDARIES.md's
 * Cross-Domain Rule — never imports either domain's `infrastructure/*.entity.ts`
 * or its repository directly.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([SalesOrder, SalesOrderLine]),
    CommerceModule,
    CrmModule,
    NumberingModule,
    ScopeModule,
    AuditModule,
    AuthorizationModule,
    ProcessEngineModule,
    AuthenticationModule,
    IdentityModule,
    InventoryWarehouseModule,
  ],
  controllers: [SalesOrdersController],
  providers: [SalesOrdersService, PreliminaryHoldExpiryScheduler],
  exports: [SalesOrdersService],
})
export class SalesOrdersModule {}
