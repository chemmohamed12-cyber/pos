import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Currency } from './infrastructure/currency.entity';
import { ExchangeRate } from './infrastructure/exchange-rate.entity';
import { FiscalYear } from './infrastructure/fiscal-year.entity';
import { FiscalPeriod } from './infrastructure/fiscal-period.entity';
import { TaxCode } from './infrastructure/tax-code.entity';
import { TaxPeriod } from './infrastructure/tax-period.entity';
import { FinancialDimensionType } from './infrastructure/financial-dimension-type.entity';
import { FinancialDimensionValue } from './infrastructure/financial-dimension-value.entity';
import { ProcessedEvent } from './infrastructure/processed-event.entity';
import { GLAccount } from './infrastructure/gl-account.entity';
import { GLAccountDimensionRule } from './infrastructure/gl-account-dimension-rule.entity';
import { JournalEntry } from './infrastructure/journal-entry.entity';
import { JournalLine } from './infrastructure/journal-line.entity';
import { JournalLineDimension } from './infrastructure/journal-line-dimension.entity';
import { FinancialEvent } from './infrastructure/financial-event.entity';
import { ArReconciliationRun } from './infrastructure/ar-reconciliation-run.entity';
import { ApReconciliationRun } from './infrastructure/ap-reconciliation-run.entity';
import { CashBankReconciliationRun } from './infrastructure/cash-bank-reconciliation-run.entity';
import { InventoryReconciliationRun } from './infrastructure/inventory-reconciliation-run.entity';
import { FixedAsset } from './infrastructure/fixed-asset.entity';
import { FixedAssetCategoryAccountMapping } from './infrastructure/fixed-asset-category-account-mapping.entity';
import { DepreciationRun } from './infrastructure/depreciation-run.entity';
import { DepreciationRunLine } from './infrastructure/depreciation-run-line.entity';
import { FixedAssetDisposal } from './infrastructure/fixed-asset-disposal.entity';
import { CurrencyService } from './application/currency.service';
import { FiscalPeriodService } from './application/fiscal-period.service';
import { TaxCodeService } from './application/tax-code.service';
import { TaxPeriodService } from './application/tax-period.service';
import { FinancialDimensionService } from './application/financial-dimension.service';
import { ProcessedEventService } from './application/processed-event.service';
import { GLAccountService } from './application/gl-account.service';
import { JournalEntryService } from './application/journal-entry.service';
import { LedgerService } from './application/ledger.service';
import { FinancialReportingService } from './application/financial-reporting.service';
import { FinancialEventHandlerRegistry } from './application/financial-events/handler-registry';
import { FinancialEventService } from './application/financial-events/financial-event.service';
import { ArReconciliationService } from './application/ar-reconciliation.service';
import { ArAdjustmentService } from './application/ar-adjustment.service';
import { ApReconciliationService } from './application/ap-reconciliation.service';
import { ApAdjustmentService } from './application/ap-adjustment.service';
import { CashBankReconciliationService } from './application/cash-bank-reconciliation.service';
import { CashBankAdjustmentService } from './application/cash-bank-adjustment.service';
import { InventoryReconciliationService } from './application/inventory-reconciliation.service';
import { InventoryAdjustmentService } from './application/inventory-adjustment.service';
import { InventoryCostingHandlerService } from './application/financial-events/inventory-costing-handler.service';
import { FixedAssetService } from './application/fixed-asset.service';
import { DepreciationService } from './application/depreciation.service';
import { FixedAssetDisposalService } from './application/fixed-asset-disposal.service';
import { FixedAssetReconciliationService } from './application/fixed-asset-reconciliation.service';
import { AccountingController } from './interface/accounting.controller';
import { GeneralLedgerController } from './interface/general-ledger.controller';
import { ArController } from './interface/ar.controller';
import { ApController } from './interface/ap.controller';
import { CashBankController } from './interface/cash-bank.controller';
import { InventoryAccountingController } from './interface/inventory-accounting.controller';
import { FixedAssetController } from './interface/fixed-asset.controller';
import { AuthenticationModule } from '../../foundation/authentication/authentication.module';
import { PermissionModule } from '../../foundation/permission/permission.module';
import { AuditModule } from '../../foundation/audit/audit.module';
import { ProcessEngineModule } from '../../foundation/process-engine/process-engine.module';
import { EventsModule } from '../../foundation/events/events.module';
import { OrganizationModule } from '../../foundation/organization/organization.module';
import { NumberingModule } from '../../foundation/numbering/numbering.module';
import { ApprovalEngineModule } from '../../foundation/approval-engine/approval-engine.module';
import { ExcelModule } from '../../foundation/excel/excel.module';
import { CustomerFinanceModule } from '../customer-finance/customer-finance.module';
import { TreasuryModule } from '../treasury/treasury.module';
import { InventoryValuationModule } from '../inventory-valuation/inventory-valuation.module';

/**
 * F01 — Financial Foundation (ADR-032). `accounting`'s composition root.
 * `depends_on: ['finance']` per the manifest — but note that dependency
 * is an ENTITLEMENT dependency, not a code-import one: this module
 * imports only cross-cutting Platform-Core foundation modules, the same
 * set every domain module imports, plus `ProcessEngineModule`,
 * `AuditModule`, `EventsModule`, `OrganizationModule` and `NumberingModule`
 * for the reuse F01–F03 mandate. **No import from `src/domains/finance`,
 * `src/domains/treasury`, or `src/domains/customer-finance`** — every
 * financial event this module consumes arrives via the Transactional
 * Outbox (`foundation/events`, `EventBusService.subscribe`), never a
 * direct import (ADR-018 / `DAII_FINANCE_INTEGRATION_BOUNDARY.md`).
 *
 * F03 (ADR-035) adds: `JournalEntry` / `JournalLine` / `JournalLineDimension`
 * / `FinancialEvent`; `JournalEntryService` (+ the posting gate),
 * `LedgerService` (SQL-aggregation read model), `FinancialEventService`
 * (+ `FinancialEventHandlerRegistry`).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Currency,
      ExchangeRate,
      FiscalYear,
      FiscalPeriod,
      TaxCode,
      TaxPeriod,
      FinancialDimensionType,
      FinancialDimensionValue,
      ProcessedEvent,
      GLAccount,
      GLAccountDimensionRule,
      JournalEntry,
      JournalLine,
      JournalLineDimension,
      FinancialEvent,
      ArReconciliationRun,
      ApReconciliationRun,
      CashBankReconciliationRun,
      InventoryReconciliationRun,
      FixedAsset,
      FixedAssetCategoryAccountMapping,
      DepreciationRun,
      DepreciationRunLine,
      FixedAssetDisposal,
    ]),
    AuthenticationModule,
    PermissionModule,
    AuditModule,
    ProcessEngineModule,
    EventsModule,
    OrganizationModule,
    NumberingModule,
    ApprovalEngineModule,
    // F14 (ADR-047 D8) — for ExcelService, the platform's own established `.../export` convention
    // (`domains/reports/interface/reports.controller.ts`), reused as-is for the 3 new report exports.
    ExcelModule,
    // F04 (ADR-036) — for FINANCE_CUSTOMER_LEDGER_CONTRACT (the sanctioned ADR-027 route
    // to the customer-finance AR subledger; same pattern `returns`/`reports` already use).
    // Makes `accounting depends_on ['finance']` a real code edge (resolves the C-8 warning).
    CustomerFinanceModule,
    // F06 (ADR-038) — for FINANCE_TREASURY_CONTRACT (the sanctioned ADR-027 route to the
    // Treasury operational ledger — Cash/Bank↔GL reconciliation reads it, never a raw table).
    TreasuryModule,
    // F08 (ADR-041 D18/D19) — binds INVENTORY_VALUATION_CONTRACT for real: lights up
    // InventoryReconciliationService's @Optional() dormancy (zero change to that service's own
    // code) and gives InventoryCostingHandlerService the interface it self-registers against.
    // No import from `domains/inventory-valuation`'s own classes anywhere — DI token only.
    InventoryValuationModule,
  ],
  controllers: [
    AccountingController,
    GeneralLedgerController,
    ArController,
    ApController,
    CashBankController,
    InventoryAccountingController,
    FixedAssetController,
  ],
  providers: [
    CurrencyService,
    FiscalPeriodService,
    TaxCodeService,
    TaxPeriodService,
    FinancialDimensionService,
    ProcessedEventService,
    GLAccountService,
    JournalEntryService,
    LedgerService,
    FinancialReportingService,
    FinancialEventHandlerRegistry,
    FinancialEventService,
    ArReconciliationService,
    ArAdjustmentService,
    ApReconciliationService,
    ApAdjustmentService,
    CashBankReconciliationService,
    CashBankAdjustmentService,
    InventoryReconciliationService,
    InventoryAdjustmentService,
    InventoryCostingHandlerService,
    FixedAssetService,
    DepreciationService,
    FixedAssetDisposalService,
    FixedAssetReconciliationService,
  ],
  exports: [
    CurrencyService,
    FiscalPeriodService,
    TaxCodeService,
    TaxPeriodService,
    FinancialDimensionService,
    ProcessedEventService,
    GLAccountService,
    JournalEntryService,
    LedgerService,
    FinancialReportingService,
    FinancialEventService,
    ArReconciliationService,
    ApReconciliationService,
    CashBankReconciliationService,
    InventoryReconciliationService,
  ],
})
export class AccountingModule {}
