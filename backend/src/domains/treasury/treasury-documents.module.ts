import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TreasuryDocument } from './infrastructure/treasury-document.entity';
import { TreasuryDocumentAllocation } from './infrastructure/treasury-document-allocation.entity';
import { TreasuryDocumentService } from './application/treasury-document.service';
import { TreasuryDocumentsController } from './interface/treasury-documents.controller';
import { BankStatementService } from './application/bank-statement.service';
import { CashSessionService } from './application/cash-session.service';
import { BankStatementsController, CashSessionsController } from './interface/bank-statements.controller';
import { BankStatement, BankStatementLine, BankStatementMatch, CashSession } from './infrastructure/bank-statement.entities';
import { TreasuryModule } from './treasury.module';
import { CustomerFinanceModule } from '../customer-finance/customer-finance.module';
import { ApprovalEngineModule } from '../../foundation/approval-engine/approval-engine.module';
import { AuditModule } from '../../foundation/audit/audit.module';
import { AuthenticationModule } from '../../foundation/authentication/authentication.module';
import { AuthorizationModule } from '../../foundation/authorization/authorization.module';
import { NumberingModule } from '../../foundation/numbering/numbering.module';
import { PermissionModule } from '../../foundation/permission/permission.module';
import { ScopeModule } from '../../foundation/scope/scope.module';
import { ErrorContractModule } from '../../foundation/error-contract/error-contract.module';
import { EventsModule } from '../../foundation/events/events.module';
import { CompanyModule } from '../../foundation/company/company.module';
import { DatabaseRegistryModule } from '../../foundation/database-registry/database-registry.module';

/**
 * T3 — Treasury Documents. A separate module (not part of `TreasuryModule`) because executing a customer collection needs customer-finance, which already depends on
 * Treasury: this module sits ABOVE both, so no cycle is introduced. Customer-finance is reached only through `FINANCE_COLLECTION_CONTRACT`.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([TreasuryDocument, TreasuryDocumentAllocation, BankStatement, BankStatementLine, BankStatementMatch, CashSession]),
    TreasuryModule,
    CustomerFinanceModule,
    ApprovalEngineModule,
    AuditModule,
    AuthenticationModule,
    AuthorizationModule,
    NumberingModule,
    PermissionModule,
    ScopeModule,
    ErrorContractModule,
    EventsModule,
    CompanyModule,
    DatabaseRegistryModule,
  ],
  controllers: [TreasuryDocumentsController, BankStatementsController, CashSessionsController],
  providers: [TreasuryDocumentService, BankStatementService, CashSessionService],
  exports: [TreasuryDocumentService, BankStatementService, CashSessionService],
})
export class TreasuryDocumentsModule {}
