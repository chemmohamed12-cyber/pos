import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CustomerLedgerEntry } from './infrastructure/customer-ledger-entry.entity';
import { SalesInvoice } from './infrastructure/sales-invoice.entity';
import { SalesInvoiceLine } from './infrastructure/sales-invoice-line.entity';
import { CustomerPaymentReversal } from './infrastructure/customer-payment-reversal.entity';
import { Payment } from './infrastructure/payment.entity';
import { CustomerLedgerService } from './application/customer-ledger.service';
import { InvoiceService } from './application/invoices.service';
import { PaymentsService } from './application/payments.service';
import { FINANCE_COLLECTION_CONTRACT } from '../../foundation/module-registry/contracts/collection.contract';
import { CustomerStatementService } from './application/customer-statement.service';
import { CustomerStatementExportService } from './application/customer-statement-export.service';
import { CustomerStatementController } from './interface/customer-statement.controller';
import { InvoicesController } from './interface/invoices.controller';
import { PaymentsController } from './interface/payments.controller';
import { CustomerLedgerController } from './interface/customer-ledger.controller';
import { NumberingModule } from '../../foundation/numbering/numbering.module';
import { EventsModule } from '../../foundation/events/events.module';
import { ProcessEngineModule } from '../../foundation/process-engine/process-engine.module';
import { AuthorizationModule } from '../../foundation/authorization/authorization.module';
import { AuditModule } from '../../foundation/audit/audit.module';
import { AuthenticationModule } from '../../foundation/authentication/authentication.module';
import { TreasuryModule } from '../treasury/treasury.module';
import { CrmModule } from '../crm/crm.module';
import { SalesOrdersModule } from '../sales-orders/sales-orders.module';
import { FINANCE_CUSTOMER_LEDGER_CONTRACT, FINANCE_INVOICE_CONTRACT } from '../../foundation/module-registry/contracts/finance.contract';
import { PermissionModule } from '../../foundation/permission/permission.module';
import { ErrorContractModule } from '../../foundation/error-contract/error-contract.module';
import { TaxEngineModule } from '../accounting/tax-engine.module';
import { CompanyModule } from '../../foundation/company/company.module';
import { DatabaseRegistryModule } from '../../foundation/database-registry/database-registry.module';

/**
 * Customer Financial Account / Invoice / AR (CTO directive) — a genuinely
 * new domain (the first customer-facing subledger this codebase has),
 * mirroring how `treasury`/`deposit-control`/`returns` are each their own
 * domain. Imported by `DepositControlModule`/`DeliveryModule`/
 * `ReturnsModule`/`ReportsModule` for their own bridges into the Customer
 * Ledger — one-directional, no cycle: this module never imports any of
 * those back.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([CustomerLedgerEntry, SalesInvoice, SalesInvoiceLine, Payment, CustomerPaymentReversal]),
    NumberingModule,
    EventsModule,
    ProcessEngineModule,
    AuthorizationModule,
    AuditModule,
    AuthenticationModule,
    TreasuryModule,
    CrmModule,
    SalesOrdersModule,
    PermissionModule,
    ErrorContractModule,
    // F10 (ADR-043 D1) — TAX_ENGINE_CONTRACT. A separate small module, not
    // AccountingModule itself (which already imports CustomerFinanceModule) —
    // see tax-engine.module.ts's own doc comment for why importing
    // AccountingModule here would create a real NestJS module cycle.
    TaxEngineModule,
    // Area 21 Operational Company Scoping Retrofit (2026-09-27/28) — for
    // `CompanyContextGuard`, now on both `CustomerLedgerController` (§25)
    // and `PaymentsController` (§32). `InvoicesController`, also in this
    // module, is still BLOCKED on `TaxEngineService` — see
    // AREA21-RETROFIT-MATRIX.md §24. `DatabaseRegistryModule` alongside
    // it, the same required pairing discovered during
    // `products.controller.ts`'s retrofit.
    CompanyModule,
    DatabaseRegistryModule,
  ],
  controllers: [InvoicesController, PaymentsController, CustomerLedgerController, CustomerStatementController],
  providers: [
    CustomerLedgerService,
    InvoiceService,
    PaymentsService,
    { provide: FINANCE_COLLECTION_CONTRACT, useExisting: PaymentsService },
    CustomerStatementService,
    CustomerStatementExportService,
    { provide: FINANCE_CUSTOMER_LEDGER_CONTRACT, useExisting: CustomerLedgerService },
    { provide: FINANCE_INVOICE_CONTRACT, useExisting: InvoiceService },
  ],
  exports: [CustomerLedgerService, InvoiceService, PaymentsService, FINANCE_CUSTOMER_LEDGER_CONTRACT, FINANCE_INVOICE_CONTRACT, FINANCE_COLLECTION_CONTRACT],
})
export class CustomerFinanceModule {}
