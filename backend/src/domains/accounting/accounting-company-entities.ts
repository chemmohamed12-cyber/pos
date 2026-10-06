import { ApReconciliationRun } from './infrastructure/ap-reconciliation-run.entity';
import { ArReconciliationRun } from './infrastructure/ar-reconciliation-run.entity';
import { CashBankReconciliationRun } from './infrastructure/cash-bank-reconciliation-run.entity';
import { ClosingAuditRun } from './infrastructure/closing-audit-run.entity';
import { ClosingSnapshotSigningKey } from './infrastructure/closing-snapshot-signing-key.entity';
import { DepreciationRunLine } from './infrastructure/depreciation-run-line.entity';
import { DepreciationRun } from './infrastructure/depreciation-run.entity';
import { FixedAssetCategoryAccountMapping } from './infrastructure/fixed-asset-category-account-mapping.entity';
import { FixedAssetDisposal } from './infrastructure/fixed-asset-disposal.entity';
import { FixedAsset } from './infrastructure/fixed-asset.entity';
import { InventoryReconciliationRun } from './infrastructure/inventory-reconciliation-run.entity';
import { ProcessedEvent } from './infrastructure/processed-event.entity';
import { TaxCode } from './infrastructure/tax-code.entity';
import { ClosingSnapshotRun } from './infrastructure/closing-snapshot-run.entity';
import { FiscalPeriod } from './infrastructure/fiscal-period.entity';
import { FiscalYear } from './infrastructure/fiscal-year.entity';
import { ClosingException } from './infrastructure/closing-exception.entity';
import { FinancialEvent } from './infrastructure/financial-event.entity';
import { JournalEntry } from './infrastructure/journal-entry.entity';
import { JournalLine } from './infrastructure/journal-line.entity';
import { JournalLineDimension } from './infrastructure/journal-line-dimension.entity';
import { GLAccount } from './infrastructure/gl-account.entity';
import { GrniReconciliationRun } from './infrastructure/grni-reconciliation-run.entity';
import { WipReconciliationRun } from './infrastructure/wip-reconciliation-run.entity';
import { Currency } from './infrastructure/currency.entity';
import { ExchangeRate } from './infrastructure/exchange-rate.entity';
import { GLAccountDimensionRule } from './infrastructure/gl-account-dimension-rule.entity';
import { FinancialDimensionType } from './infrastructure/financial-dimension-type.entity';
import { FinancialDimensionValue } from './infrastructure/financial-dimension-value.entity';
import { TaxPeriod } from './infrastructure/tax-period.entity';
import { ClosingWorkflowRun } from './infrastructure/closing-workflow-run.entity';

/**
 * ADR-074 (2026-09-25, CTO Decision: Hybrid B — Domain-Owned Company
 * Entity Sets + Single Aggregated Company Entity Registry). The Accounting
 * domain's own list of entities its services touch through a Company
 * connection (`manager?: EntityManager`) — `ClosingSnapshotService` and
 * everything it reaches (`JournalEntryService`, `LedgerService`). Owned
 * and reviewed here, alongside this domain's own code, not in a
 * central list someone else maintains. `GrniReconciliationRun` added 2026-09-28
 * (Area 21, `grni.controller.ts`'s own turn); `WipReconciliationRun` added the same
 * day (`wip.controller.ts`'s turn). Currency/ExchangeRate/GLAccountDimensionRule/
 * FinancialDimensionType/FinancialDimensionValue/TaxPeriod/ClosingWorkflowRun added the same day —
 * the collaborators `JournalEntryService`/`FinancialReportingService` read on
 * `general-ledger.controller.ts`'s own turn (found missing, §52).
 */
export const ACCOUNTING_COMPANY_ENTITIES = [ClosingSnapshotRun, FiscalPeriod, FiscalYear, ClosingException, FinancialEvent, JournalEntry, JournalLine, JournalLineDimension, GLAccount, GrniReconciliationRun, WipReconciliationRun, Currency, ExchangeRate, GLAccountDimensionRule, FinancialDimensionType, FinancialDimensionValue, TaxPeriod, ClosingWorkflowRun, TaxCode, ApReconciliationRun, ArReconciliationRun, CashBankReconciliationRun, ClosingAuditRun, ClosingSnapshotSigningKey, DepreciationRunLine, DepreciationRun, FixedAssetCategoryAccountMapping, FixedAssetDisposal, FixedAsset, InventoryReconciliationRun, ProcessedEvent];
