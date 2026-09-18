import { Module } from '@nestjs/common';
import { ReportsService } from './application/reports.service';
import { CustomerAccountsService } from './application/customer-accounts.service';
import { ReportsController } from './interface/reports.controller';
import { SalesOrdersModule } from '../sales-orders/sales-orders.module';
import { CrmModule } from '../crm/crm.module';
import { DepositControlModule } from '../deposit-control/deposit-control.module';
import { ReturnsModule } from '../returns/returns.module';
import { FulfillmentModule } from '../fulfillment/fulfillment.module';
import { ShipmentModule } from '../shipment/shipment.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { IdentityModule } from '../../foundation/identity/identity.module';
import { AuthenticationModule } from '../../foundation/authentication/authentication.module';
import { AuthorizationModule } from '../../foundation/authorization/authorization.module';
import { ExcelModule } from '../../foundation/excel/excel.module';
import { CustomerFinanceModule } from '../customer-finance/customer-finance.module';

/**
 * Operational Reports — a cross-domain composition layer (see
 * `reports.service.ts`'s own doc comment). Consumes every domain only
 * through its exported services (DAII_DOMAIN_BOUNDARIES.md Cross-Domain
 * Rule) — never imports another domain's `infrastructure/*.entity.ts` or
 * repository directly. `CustomerAccountsService` (Customer Account
 * Foundation) lives here for the same reason: it belongs to no single
 * domain, only composes across five of them.
 */
@Module({
  imports: [
    SalesOrdersModule,
    CrmModule,
    DepositControlModule,
    ReturnsModule,
    FulfillmentModule,
    ShipmentModule,
    DeliveryModule,
    IdentityModule,
    AuthenticationModule,
    AuthorizationModule,
    ExcelModule,
    CustomerFinanceModule,
  ],
  controllers: [ReportsController],
  providers: [ReportsService, CustomerAccountsService],
})
export class ReportsModule {}
