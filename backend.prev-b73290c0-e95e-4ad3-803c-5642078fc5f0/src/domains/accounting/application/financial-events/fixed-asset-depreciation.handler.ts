import { FinancialEvent } from '../../infrastructure/financial-event.entity';
import { DepreciationRunLine } from '../../infrastructure/depreciation-run-line.entity';
import { HandlerContext, HandlerResult } from './handler-registry';

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/**
 * F12 — Fixed Assets (ADR-045 D2, corrected during implementation — see `domain/fixed-asset.ts`'s
 * `FIXED_ASSET_DEPRECIATION_CALCULATED_EVENT` doc comment). `DepreciationService` computes the
 * period's charge (straight-line math, full-month convention, remaining-balance cap) and ingests ONE
 * of these events per eligible asset; this handler does two things, both INSIDE the same posting
 * transaction `ctx.manager` represents:
 *
 * 1. Inserts the `DepreciationRunLine` calculation snapshot FIRST — the `UNIQUE (fixedAssetId,
 *    depreciationPeriod)` constraint (ADR-045 D2's binding architecture invariant) is checked right
 *    here. A concurrent run that already claimed this exact pair makes this insert fail, which rolls
 *    back this entire transaction (no orphan journal entry) and the FinancialEvent lands REJECTED —
 *    a safe, handled outcome, never a crash, never a duplicate.
 * 2. Returns the balanced 2-line draft (Dr Depreciation Expense / Cr Accumulated Depreciation).
 *
 * `journalEntryId` is intentionally left `null` here — `DepreciationService` backfills it once
 * `ingest()` returns the real id (the same "backfill after ingest resolves" shape
 * `FixedAssetDisposalService` already uses for its own `journalEntryId`).
 */
export async function handleFixedAssetDepreciationCalculated(event: FinancialEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const p = event.payload;
  const fixedAssetId = str(p.fixedAssetId);
  const depreciationRunId = str(p.depreciationRunId);
  const depreciationPeriod = str(p.depreciationPeriod);
  const depreciationExpenseAccountId = str(p.depreciationExpenseAccountId);
  const accumulatedDepreciationAccountId = str(p.accumulatedDepreciationAccountId);
  const calculatedAmount = str(p.calculatedAmount);

  if (!fixedAssetId || !depreciationRunId || !depreciationPeriod || !depreciationExpenseAccountId || !accumulatedDepreciationAccountId || !calculatedAmount) {
    return { kind: 'rejected', reason: 'fixed asset depreciation: missing required fields in payload' };
  }

  const lineRepo = ctx.manager.getRepository(DepreciationRunLine);
  await lineRepo.save(
    lineRepo.create({
      depreciationRunId,
      fixedAssetId,
      depreciationPeriod,
      openingNetBookValue: str(p.openingNetBookValue) ?? '0.0000',
      depreciableBase: str(p.depreciableBase) ?? '0.0000',
      calculatedAmount,
      resultingAccumulatedDepreciation: str(p.resultingAccumulatedDepreciation) ?? '0.0000',
      resultingNetBookValue: str(p.resultingNetBookValue) ?? '0.0000',
      journalEntryId: null,
    }),
  );

  return {
    kind: 'draft',
    draft: {
      businessDate: event.businessDate,
      description: `Depreciation — asset ${fixedAssetId} — ${depreciationPeriod}`,
      transactionCurrencyCode: event.transactionCurrencyCode,
      orgUnitId: event.orgUnitId,
      lines: [
        { accountId: depreciationExpenseAccountId, debit: calculatedAmount, description: `Depreciation expense — ${depreciationPeriod}` },
        { accountId: accumulatedDepreciationAccountId, credit: calculatedAmount, description: `Accumulated depreciation — ${depreciationPeriod}` },
      ],
    },
  };
}
