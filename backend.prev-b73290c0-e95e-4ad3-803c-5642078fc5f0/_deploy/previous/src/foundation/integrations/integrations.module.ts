import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IntegrationConnector } from './infrastructure/integration-connector.entity';
import { IntegrationCredential } from './infrastructure/integration-credential.entity';
import { IntegrationProductMapping } from './infrastructure/integration-product-mapping.entity';
import { IntegrationSyncLog } from './infrastructure/integration-sync-log.entity';
import { CredentialCipherService } from './application/credential-cipher.service';
import { IntegrationsService } from './application/integrations.service';
import { QrStoreConnector } from './application/connectors/qr-store.connector';
import { IntegrationsController } from './interface/integrations.controller';
import { IntegrationOrderIntakeController } from './interface/integration-order-intake.controller';
import { IntegrationAuthGuard } from './interface/integration-auth.guard';
import { AuditModule } from '../audit/audit.module';
import { AuthenticationModule } from '../authentication/authentication.module';
import { AuthorizationModule } from '../authorization/authorization.module';
import { EventsModule } from '../events/events.module';
import { CommerceModule } from '../../domains/commerce/commerce.module';
import { CrmModule } from '../../domains/crm/crm.module';
import { SalesOrdersModule } from '../../domains/sales-orders/sales-orders.module';
import { InventoryWarehouseModule } from '../../domains/inventory-warehouse/inventory-warehouse.module';

/**
 * External Integrations (Control Center) — CTO handover directive "Daii
 * <-> QR Store Integration & Pairing Architecture". Consumes every
 * domain it needs ONLY through their exported services
 * (DAII_DOMAIN_BOUNDARIES.md Cross-Domain Rule) — never imports another
 * domain's `infrastructure/*.entity.ts` directly. This module owns
 * nothing about Products, Customers, Sales Orders, or Inventory; it only
 * orchestrates calls into their already-built, already-tested public
 * contracts, exactly the same discipline Sales Orders itself uses for
 * Commerce/CRM.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([IntegrationConnector, IntegrationCredential, IntegrationProductMapping, IntegrationSyncLog]),
    AuditModule,
    AuthenticationModule,
    AuthorizationModule,
    EventsModule,
    CommerceModule,
    CrmModule,
    SalesOrdersModule,
    InventoryWarehouseModule,
  ],
  controllers: [IntegrationsController, IntegrationOrderIntakeController],
  providers: [CredentialCipherService, QrStoreConnector, IntegrationsService, IntegrationAuthGuard],
  exports: [IntegrationsService],
})
export class IntegrationsModule {}
