import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TreasuryAccount } from './infrastructure/treasury-account.entity';
import { TreasuryAccountType } from './infrastructure/treasury-account-type.entity';
import { TreasuryTransaction } from './infrastructure/treasury-transaction.entity';
import { TreasuryService } from './application/treasury.service';
import { TreasuryLedgerReportService } from './application/treasury-ledger-report.service';
import { TreasuryController } from './interface/treasury.controller';
import { AuditModule } from '../../foundation/audit/audit.module';
import { AuthenticationModule } from '../../foundation/authentication/authentication.module';
import { AuthorizationModule } from '../../foundation/authorization/authorization.module';
import { NumberingModule } from '../../foundation/numbering/numbering.module';
import { FINANCE_TREASURY_CONTRACT } from '../../foundation/module-registry/contracts/finance.contract';
import { PermissionModule } from '../../foundation/permission/permission.module';
import { ScopeModule } from '../../foundation/scope/scope.module';
import { ErrorContractModule } from '../../foundation/error-contract/error-contract.module';
import { EventsModule } from '../../foundation/events/events.module';
import { CompanyModule } from '../../foundation/company/company.module';
import { DatabaseRegistryModule } from '../../foundation/database-registry/database-registry.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([TreasuryAccount, TreasuryAccountType, TreasuryTransaction]),
    AuditModule,
    AuthenticationModule,
    AuthorizationModule,
    NumberingModule,
    PermissionModule,
    ScopeModule,
    ErrorContractModule,
    EventsModule, // F06-H1 — the Transactional Outbox for `treasury.cash.recorded` / `treasury.transfer.completed`
    // Area 21 Operational Company Scoping Retrofit (2026-09-27) — for
    // `CompanyContextGuard`. `DatabaseRegistryModule` alongside it, the
    // same required pairing discovered during `products.controller.ts`'s
    // retrofit.
    CompanyModule,
    DatabaseRegistryModule,
  ],
  controllers: [TreasuryController],
  providers: [TreasuryService, TreasuryLedgerReportService, { provide: FINANCE_TREASURY_CONTRACT, useExisting: TreasuryService }],
  exports: [TreasuryService, FINANCE_TREASURY_CONTRACT],
})
export class TreasuryModule {}
