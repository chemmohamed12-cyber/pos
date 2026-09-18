import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Deposit } from './infrastructure/deposit.entity';
import { DepositsService } from './application/deposits.service';
import { DepositsController } from './interface/deposits.controller';
import { SalesOrdersModule } from '../sales-orders/sales-orders.module';
import { TreasuryModule } from '../treasury/treasury.module';
import { AuditModule } from '../../foundation/audit/audit.module';
import { EventsModule } from '../../foundation/events/events.module';
import { AuthenticationModule } from '../../foundation/authentication/authentication.module';
import { AuthorizationModule } from '../../foundation/authorization/authorization.module';
import { CustomerFinanceModule } from '../customer-finance/customer-finance.module';
import { SALES_DEPOSIT_CONTRACT } from '../../foundation/module-registry/contracts/sales.contract';
import { PermissionModule } from '../../foundation/permission/permission.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Deposit]),
    SalesOrdersModule,
    TreasuryModule,
    AuditModule,
    EventsModule,
    AuthenticationModule,
    AuthorizationModule,
    // Customer Financial Account / AR (CTO directive) — one-directional,
    // no cycle: CustomerFinanceModule never imports DepositControlModule.
    CustomerFinanceModule,
    PermissionModule,
  ],
  controllers: [DepositsController],
  providers: [DepositsService, { provide: SALES_DEPOSIT_CONTRACT, useExisting: DepositsService }],
  exports: [DepositsService, SALES_DEPOSIT_CONTRACT],
})
export class DepositControlModule {}
