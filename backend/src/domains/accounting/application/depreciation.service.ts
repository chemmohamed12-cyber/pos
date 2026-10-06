import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { FixedAsset } from '../infrastructure/fixed-asset.entity';
import { DepreciationRun } from '../infrastructure/depreciation-run.entity';
import { DepreciationRunLine } from '../infrastructure/depreciation-run-line.entity';
import { FIXED_ASSET_DEPRECIATION_CALCULATED_EVENT, FIXED_ASSET_ENTITY_TYPE, FIXED_ASSET_PROCESS, isValidDepreciationPeriod } from '../domain/fixed-asset';
import { normaliseAmount } from '../domain/money';
import { CurrencyService } from './currency.service';
import { FinancialEventService } from './financial-events/financial-event.service';
import { FinancialEventHandlerRegistry } from './financial-events/handler-registry';
import { handleFixedAssetDepreciationCalculated } from './financial-events/fixed-asset-depreciation.handler';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { AuditService } from '../../../foundation/audit/audit.service';

export interface RunDepreciationResult {
  depreciationRunId: string;
  depreciationPeriod: string;
  lines: Array<{ fixedAssetId: string; calculatedAmount: string; skipped?: 'already_posted' | 'fully_depreciated' | 'not_active'; failureReason?: string }>;
}

/**
 * F12 — Fixed Assets (ADR-045 D2/D5/D9, D2 CORRECTED during H4 implementation — see
 * `domain/fixed-asset.ts`'s `FIXED_ASSET_DEPRECIATION_CALCULATED_EVENT` doc comment and
 * `ADR-045-F12-FIXED-ASSETS.md`'s D2). Depreciation is a routine, non-discretionary,
 * system-calculated batch — it posts through the SAME `FinancialEventService.ingest` pipeline every
 * other automated poster in this codebase already uses (never through FA-01, unlike Disposal —
 * "direct" means no approval, not "bypasses the Financial Event Engine"). **Governing principle:
 * "Initiated by user ≠ Manual Journal" — the criterion is the operation's architectural nature, never
 * who triggered it.** F03/`JournalEntryService` is never called directly by this service and carries
 * no knowledge that Fixed Assets exists.
 *
 * The binding idempotency invariant (D2) is enforced twice, both keyed on a stable `(asset, period)`
 * identity: the ingest-level `idempotencyKey` (F03's own `FinancialEvent.UNIQUE` guard) and, inside
 * the handler, a real DB-level `UNIQUE (fixedAssetId, depreciationPeriod)` constraint on
 * `DepreciationRunLine`, written in the SAME posting transaction the journal entry is created in.
 */
@Injectable()
export class DepreciationService implements OnModuleInit {
  constructor(
    private readonly dataSource: DataSource,
    private readonly currencies: CurrencyService,
    private readonly financialEvents: FinancialEventService,
    private readonly registry: FinancialEventHandlerRegistry,
    private readonly processEngine: ProcessEngineService,
    private readonly audit: AuditService,
  ) {}

  private em(manager?: EntityManager): EntityManager {
    return manager ?? this.dataSource.manager;
  }

  onModuleInit(): void {
    if (!this.registry.get(FIXED_ASSET_DEPRECIATION_CALCULATED_EVENT)) {
      this.registry.register(FIXED_ASSET_DEPRECIATION_CALCULATED_EVENT, handleFixedAssetDepreciationCalculated);
    }
  }

  async listRuns(manager?: EntityManager): Promise<DepreciationRun[]> {
    return this.em(manager).getRepository(DepreciationRun).find({ order: { createdAt: 'DESC' } });
  }

  async getRunLines(depreciationRunId: string, manager?: EntityManager): Promise<DepreciationRunLine[]> {
    return this.em(manager).getRepository(DepreciationRunLine).find({ where: { depreciationRunId }, order: { createdAt: 'ASC' } });
  }

  /**
   * D9 — full-month convention: an asset is eligible for `depreciationPeriod` only once that period
   * starts AFTER the calendar month of `acquisitionDate` (the acquisition month itself is never
   * depreciated). `businessDate` defaults to `depreciationPeriod`'s own last calendar day — the REAL
   * accounting date, preserved even when the run is executed much later (D2 fix) — never "today."
   */
  async runDepreciation(depreciationPeriod: string, actorUserId: string, businessDate?: string, manager?: EntityManager): Promise<RunDepreciationResult> {
    if (!isValidDepreciationPeriod(depreciationPeriod)) {
      throw new BadRequestException(`"${depreciationPeriod}" is not a valid depreciation period (expected YYYY-MM).`);
    }
    const effectiveBusinessDate = businessDate ?? this.lastDayOf(depreciationPeriod);
    const base = await this.currencies.getBaseCurrency(manager);
    if (!base) throw new BadRequestException('No base/functional currency is configured — a depreciation run cannot post.');

    const run = await this.em(manager).getRepository(DepreciationRun).save(
      this.em(manager).getRepository(DepreciationRun).create({
        depreciationPeriod,
        businessDate: effectiveBusinessDate,
        createdBy: actorUserId,
      }),
    );

    const assets = await this.em(manager).getRepository(FixedAsset).find();
    const results: RunDepreciationResult['lines'] = [];

    for (const asset of assets) {
      const outcome = await this.runOneAsset(asset, run, depreciationPeriod, effectiveBusinessDate, base.code, manager);
      results.push(outcome);
    }

    // G — audit: who initiated the run, when, which period, and the outcome per asset (event ids +
    // journal presence are independently reconstructable from accounting_financial_events /
    // accounting_depreciation_run_lines, both keyed by this run's id).
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'accounting.fixed_asset.depreciation_run',
      resource: 'depreciation_run',
      resourceId: run.id,
      result: 'success',
      correlationId: null,
      after: { depreciationPeriod, businessDate: effectiveBusinessDate, assetCount: assets.length, posted: results.filter((r) => !r.skipped && !r.failureReason).length },
    }, manager);

    return { depreciationRunId: run.id, depreciationPeriod, lines: results };
  }

  private async runOneAsset(
    asset: FixedAsset,
    run: DepreciationRun,
    depreciationPeriod: string,
    businessDate: string,
    baseCurrencyCode: string, manager?: EntityManager): Promise<RunDepreciationResult['lines'][number]> {
    const state = await this.processEngine.getState(FIXED_ASSET_PROCESS, FIXED_ASSET_ENTITY_TYPE, asset.id, manager);
    if (state !== 'active') {
      return { fixedAssetId: asset.id, calculatedAmount: '0.0000', skipped: 'not_active' };
    }

    // cheap first filter — the real, binding defense is the DB constraint inside the handler (D2)
    const existing = await this.em(manager)
      .getRepository(DepreciationRunLine)
      .findOne({ where: { fixedAssetId: asset.id, depreciationPeriod } });
    if (existing) {
      return { fixedAssetId: asset.id, calculatedAmount: '0.0000', skipped: 'already_posted' };
    }

    const [row] = (await this.em(manager).query(
      `SELECT COALESCE(SUM("calculatedAmount"), 0)::numeric(20,4) AS total FROM accounting_depreciation_run_lines WHERE "fixedAssetId" = $1`,
      [asset.id],
    )) as Array<{ total: string }>;
    const accumulatedToDate = row.total;
    const openingNetBookValue = normaliseAmount(String(Number(asset.cost) - Number(accumulatedToDate)), 4);
    const remainingDepreciable = normaliseAmount(String(Number(asset.depreciableBase) - Number(accumulatedToDate)), 4);

    if (Number(remainingDepreciable) <= 0) {
      return { fixedAssetId: asset.id, calculatedAmount: '0.0000', skipped: 'fully_depreciated' };
    }

    // D9 full-month convention: not eligible until the period AFTER the acquisition month.
    const acquisitionYm = asset.acquisitionDate.slice(0, 7);
    if (depreciationPeriod <= acquisitionYm) {
      return { fixedAssetId: asset.id, calculatedAmount: '0.0000', skipped: 'not_active' };
    }

    const monthly = Number(asset.depreciableBase) / asset.usefulLifeMonths;
    const calculatedAmount = normaliseAmount(String(Math.min(monthly, Number(remainingDepreciable))), 4);
    if (Number(calculatedAmount) <= 0) {
      return { fixedAssetId: asset.id, calculatedAmount: '0.0000', skipped: 'fully_depreciated' };
    }

    const resultingAccumulatedDepreciation = normaliseAmount(String(Number(accumulatedToDate) + Number(calculatedAmount)), 4);
    const resultingNetBookValue = normaliseAmount(String(Number(asset.cost) - Number(resultingAccumulatedDepreciation)), 4);

    // D2 (corrected) — a stable identity keyed on (asset, period) alone, never a fresh UUID/timestamp,
    // so a retry, a redelivery, or a second call for the same pair always resolves to the SAME event.
    const idempotencyKey = `accounting:fixed_asset_depreciation:${asset.id}:${depreciationPeriod}`;

    let result = await this.financialEvents.ingest(FIXED_ASSET_DEPRECIATION_CALCULATED_EVENT, {
      idempotencyKey,
      businessDate,
      orgUnitId: asset.orgUnitId ?? null,
      currency: baseCurrencyCode,
      sourceEntityType: 'fixed_asset',
      sourceEntityId: asset.id,
      payloadVersion: 1,
      fixedAssetId: asset.id,
      depreciationRunId: run.id,
      depreciationPeriod,
      depreciationExpenseAccountId: asset.depreciationExpenseAccountId,
      accumulatedDepreciationAccountId: asset.accumulatedDepreciationAccountId,
      calculatedAmount,
      openingNetBookValue,
      depreciableBase: asset.depreciableBase,
      resultingAccumulatedDepreciation,
      resultingNetBookValue,
    }, manager);

    if (result.deduped) {
      if (result.status === 'POSTED') {
        return { fixedAssetId: asset.id, calculatedAmount: '0.0000', skipped: 'already_posted' };
      }
      // Case E — the SAME (asset, period) pair was already attempted and is stuck REJECTED (e.g. an
      // account was inactive at the time). `ingest()`'s idempotencyKey guard returns the EXISTING
      // (stale) event rather than re-running anything — a fresh, real attempt requires `redrive`,
      // the exact same mechanism this codebase already uses to re-drive any other stuck event. This
      // is still ONE FinancialEvent row throughout (never duplicated) and, if it now succeeds, ONE
      // JournalEntry — never two.
      result = await this.financialEvents.redrive(result.financialEventId, manager);
    }
    if (result.status === 'POSTED') {
      if (result.journalEntryId) {
        await this.em(manager).query(
          `UPDATE accounting_depreciation_run_lines SET "journalEntryId" = $1 WHERE "fixedAssetId" = $2 AND "depreciationPeriod" = $3`,
          [result.journalEntryId, asset.id, depreciationPeriod],
        );
      }
      return { fixedAssetId: asset.id, calculatedAmount };
    }

    // REJECTED — distinguish "a concurrent run already claimed this pair" (a safe, expected outcome,
    // D2's own concurrency case) from a genuine failure (surfaced, not silently swallowed).
    const event = await this.financialEvents.getEvent(result.financialEventId, manager);
    const reason = event.rejectionReason ?? '';
    if (/duplicate key value violates unique constraint/i.test(reason) || /UQ_accounting_depreciation_run_lines_asset_period/i.test(reason)) {
      return { fixedAssetId: asset.id, calculatedAmount: '0.0000', skipped: 'already_posted' };
    }
    return { fixedAssetId: asset.id, calculatedAmount: '0.0000', failureReason: reason };
  }

  private lastDayOf(period: string): string {
    const [y, m] = period.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0));
    return last.toISOString().slice(0, 10);
  }
}
