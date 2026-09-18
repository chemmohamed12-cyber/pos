import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { HealthModule } from './health/health.module';
import { DatabaseModule } from './database/database.module';
import { ConfigurationModule } from './foundation/configuration/configuration.module';
import { ConfigurationEngineModule } from './foundation/configuration-engine/configuration-engine.module';
import { EntitlementModule } from './foundation/entitlement/entitlement.module';
import { LimitEngineModule } from './foundation/limit-engine/limit-engine.module';
import { NavigationModule } from './foundation/navigation/navigation.module';
import { ModuleRoleTemplatesModule } from './foundation/module-role-templates/module-role-templates.module';
import { IdentityModule } from './foundation/identity/identity.module';
import { AuthenticationModule } from './foundation/authentication/authentication.module';
import { AuthorizationModule } from './foundation/authorization/authorization.module';
import { PermissionModule } from './foundation/permission/permission.module';
import { ScopeModule } from './foundation/scope/scope.module';
import { OrganizationModule } from './foundation/organization/organization.module';
import { AuditModule } from './foundation/audit/audit.module';
import { EventsModule } from './foundation/events/events.module';
import { ErrorContractModule } from './foundation/error-contract/error-contract.module';
import { ObservabilityModule } from './foundation/observability/observability.module';
import { TerminologyModule } from './foundation/terminology/terminology.module';
import { LocalizationModule } from './foundation/localization/localization.module';
import { NumberingModule } from './foundation/numbering/numbering.module';
import { ProcessEngineModule } from './foundation/process-engine/process-engine.module';
import { ApprovalEngineModule } from './foundation/approval-engine/approval-engine.module';
import { MediaModule } from './foundation/media/media.module';
import { CrmModule } from './domains/crm/crm.module';
import { CommerceModule } from './domains/commerce/commerce.module';
import { SalesModule } from './domains/sales/sales.module';
import { SalesOrdersModule } from './domains/sales-orders/sales-orders.module';
import { DepositControlModule } from './domains/deposit-control/deposit-control.module';
import { TreasuryModule } from './domains/treasury/treasury.module';
import { InventoryWarehouseModule } from './domains/inventory-warehouse/inventory-warehouse.module';
import { InventoryValuationModule } from './domains/inventory-valuation/inventory-valuation.module';
import { FulfillmentModule } from './domains/fulfillment/fulfillment.module';
import { ShipmentModule } from './domains/shipment/shipment.module';
import { DeliveryModule } from './domains/delivery/delivery.module';
import { ReturnsModule } from './domains/returns/returns.module';
import { CustomerFinanceModule } from './domains/customer-finance/customer-finance.module';
import { AdminModule } from './foundation/admin/admin.module';
import { IntegrationsModule } from './foundation/integrations/integrations.module';
import { ReportsModule } from './domains/reports/reports.module';
import { ReleaseModule } from './foundation/release/release.module';
import { HrModule } from './domains/hr/hr.module';
import { AccountingModule } from './domains/accounting/accounting.module';
import { ProcurementModule } from './domains/procurement/procurement.module';

/**
 * Composition root. Stage 2 build-order items 1-19 (Phase A, complete)
 * plus ALL Phase B domains 21-32 (Commerce, CRM, Sales, Sales Orders +
 * Approval, Deposit Control, Inventory & Warehouse, Fulfillment,
 * Shipment + Tracking, Delivery, Returns) — Phase B is now complete.
 */
@Module({
  imports: [
    // Security review (master continuation directive) — closes a real,
    // previously-undocumented gap: no rate limiting existed anywhere,
    // meaning `POST /auth/login` had zero protection against a scripted
    // brute-force password-guessing attempt (it failed safely per-attempt
    // — generic "Invalid email or password", no user enumeration — but
    // never blocked repeated attempts). A generous global default (every
    // route) plus a strict override on the auth-sensitive routes
    // specifically (registered below via @Throttle on AuthController).
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 300 }]),
    ConfigurationModule,
    DatabaseModule,
    ConfigurationEngineModule,
    EntitlementModule,
    LimitEngineModule,
    ModuleRoleTemplatesModule,
    IdentityModule,
    AuthenticationModule,
    AuthorizationModule,
    PermissionModule,
    ScopeModule,
    OrganizationModule,
    AuditModule,
    EventsModule,
    ErrorContractModule,
    ObservabilityModule,
    TerminologyModule,
    LocalizationModule,
    NumberingModule,
    ProcessEngineModule,
    ApprovalEngineModule,
    MediaModule,
    CommerceModule,
    CrmModule,
    SalesModule,
    SalesOrdersModule,
    DepositControlModule,
    TreasuryModule,
    InventoryWarehouseModule,
    InventoryValuationModule,
    FulfillmentModule,
    ShipmentModule,
    DeliveryModule,
    ReturnsModule,
    CustomerFinanceModule,
    AdminModule,
    IntegrationsModule,
    ReportsModule,
    HealthModule,
    ReleaseModule,
    NavigationModule,
    HrModule,
    AccountingModule,
    ProcurementModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
