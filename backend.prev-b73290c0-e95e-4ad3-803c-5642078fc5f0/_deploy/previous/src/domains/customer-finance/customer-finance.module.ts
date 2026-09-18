import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CustomerLedgerEntry } from './infrastructure/customer-ledger-entry.entity';
import { SalesInvoice } from './infrastructure/sales-invoice.entity';
import { SalesInvoiceLine } from './infrastructure/sales-invoice-line.entity';
import { Payment } from './infrastructure/payment.entity';
import { CustomerLedgerService } from './application/customer-ledger.service';
import { InvoiceService } from './application/invoices.service';
import { PaymentsService } from './application/payments.service';
import { InvoicesController } from './interface/invoices.controller';
import { PaymentsController } from './interface/payments.controller';
import { CustomerLedgerController } from './interface/customer-ledger.controller';
import { NumberingModule } from '../../foundation/numbering/numbering.module';
import { ProcessEngineModule } from '../../foundation/process-engine/process-engine.module';
import { AuthorizationModule } from '../../foundation/authorization/authorization.module';
import { AuditModule } from '../../foundation/audit/audit.module';
import { AuthenticationModule } from '../../foundation/authentication/authentication.module';
import { TreasuryModule } from '../treasury/treasury.module';
import { CrmModule } from '../crm/crm.module';
import { SalesOrdersModule } from '../sales-orders/sales-orders.module';

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
    TypeOrmModule.forFeature([CustomerLedgerEntry, SalesInvoice, SalesInvoiceLine, Payment]),
    NumberingModule,
    ProcessEngineModule,
    AuthorizationModule,
    AuditModule,
    AuthenticationModule,
    TreasuryModule,
    CrmModule,
    SalesOrdersModule,
  ],
  controllers: [InvoicesController, PaymentsController, CustomerLedgerController],
  providers: [CustomerLedgerService, InvoiceService, PaymentsService],
  exports: [CustomerLedgerService, InvoiceService, PaymentsService],
})
export class CustomerFinanceModule {}
