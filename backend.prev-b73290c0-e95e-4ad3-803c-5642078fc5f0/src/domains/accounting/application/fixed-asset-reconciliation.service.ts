import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { FixedAsset } from '../infrastructure/fixed-asset.entity';
import { LedgerService } from './ledger.service';
import { FIXED_ASSET_ENTITY_TYPE, FIXED_ASSET_PROCESS } from '../domain/fixed-asset';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';

export interface FixedAssetReconciliationPair {
  costAccountId: string;
  accumulatedDepreciationAccountId: string;
  registerCost: string;
  costGlBalance: string;
  costMatched: boolean;
  registerAccumulatedDepreciation: string;
  accumulatedDepreciationGlBalance: string;
  accumulatedDepreciationMatched: boolean;
  registerNetBookValue: string;
  glNetBookValue: string;
  netBookValueMatched: boolean;
  pendingAcquisitionCount: number;
  pendingAcquisitionCost: string;
  /** Disposed assets contribute ZERO to the register-side sums above (their cost/accumulated
   * depreciation were fully removed from the GL by the disposal posting) — counted here so their
   * absence from `registerCost`/`registerAccumulatedDepreciation` is disclosed, never silent. */
  disposedAssetCount: number;
}

/**
 * F12 — Fixed Assets (ADR-045 D3). Read-only, three independent checks per (cost, accumulated
 * depreciation) account pair — NEVER a single blended `SUM(...WHERE controlFunction='fixed_asset')`,
 * which would mix a debit-normal and a credit-normal balance into one meaningless number. Never
 * auto-corrects (same discipline as every prior reconciliation service in this codebase).
 * `PENDING_ACQUISITION` assets are reported in their own named bucket (ADR-045 D7) — never as silent,
 * unexplained drift against the pairs above.
 */
@Injectable()
export class FixedAssetReconciliationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly ledger: LedgerService,
    private readonly processEngine: ProcessEngineService,
  ) {}

  async reconcile(asOfDate?: string, orgUnitId?: string): Promise<{ pairs: FixedAssetReconciliationPair[] }> {
    const assets = await this.dataSource.getRepository(FixedAsset).find();
    const activeAssets: FixedAsset[] = [];
    const disposedAssets: FixedAsset[] = [];
    const pendingAssets: FixedAsset[] = [];
    for (const asset of assets) {
      const state = await this.processEngine.getState(FIXED_ASSET_PROCESS, FIXED_ASSET_ENTITY_TYPE, asset.id);
      if (state === 'pending_acquisition') pendingAssets.push(asset);
      else if (state === 'disposed') disposedAssets.push(asset);
      else activeAssets.push(asset);
    }

    // Pairs are DISCOVERED from every non-pending asset (active or disposed) — a pair whose only
    // assets have all since been disposed must still be reconciled (it should show 0 = 0, not vanish
    // silently). The register-side SUMS below, however, only ever include `active` assets — a disposed
    // asset's cost/accumulated depreciation were fully removed from the GL by its own disposal
    // posting, so including it in the "current" register figures would permanently desync them from
    // the GL by exactly that asset's own numbers. This is NOT the same gap as D7's `PENDING_ACQUISITION`
    // bucket (a timing lag still to be resolved) — a disposed asset is correctly, permanently gone from
    // both sides at once.
    const pairKey = (a: FixedAsset) => `${a.costAccountId}::${a.accumulatedDepreciationAccountId}`;
    const pairs = new Map<string, FixedAsset[]>();
    for (const asset of [...activeAssets, ...disposedAssets]) {
      const key = pairKey(asset);
      if (!pairs.has(key)) pairs.set(key, []);
      pairs.get(key)!.push(asset);
    }

    const results: FixedAssetReconciliationPair[] = [];
    for (const [, groupAssets] of pairs) {
      const { costAccountId, accumulatedDepreciationAccountId } = groupAssets[0];
      const activeGroupAssets = groupAssets.filter((a) => activeAssets.includes(a));

      const [costGl, accumDepGl] = await Promise.all([
        this.ledger.getAccountLedger(costAccountId, { to: asOfDate, orgUnitId }),
        this.ledger.getAccountLedger(accumulatedDepreciationAccountId, { to: asOfDate, orgUnitId }),
      ]);
      // `getAccountLedger`'s own convention: closingBalanceBase = Σdebit − Σcredit. For a debit-normal
      // cost account this is already the positive balance; for the credit-normal (isContra) accumulated
      // depreciation account it is already negative, so adding the two directly yields Cost − AccumDep.
      const [nbvRow] = (await this.dataSource.query(
        `SELECT ($1::numeric(20,4) + $2::numeric(20,4))::numeric(20,4) AS nbv`,
        [costGl.closingBalanceBase, accumDepGl.closingBalanceBase],
      )) as Array<{ nbv: string }>;
      const [accumDepPositiveRow] = (await this.dataSource.query(
        `SELECT (-1 * $1::numeric(20,4))::numeric(20,4) AS v`,
        [accumDepGl.closingBalanceBase],
      )) as Array<{ v: string }>;

      const activeGroupAssetIds = activeGroupAssets.map((a) => a.id);
      const registerCost = await this.registerCostSum(activeGroupAssetIds);
      const registerAccumulatedDepreciation = await this.registerAccumulatedDepreciation(activeGroupAssetIds);
      const [registerNbvRow] = (await this.dataSource.query(
        `SELECT ($1::numeric(20,4) - $2::numeric(20,4))::numeric(20,4) AS nbv`,
        [registerCost, registerAccumulatedDepreciation],
      )) as Array<{ nbv: string }>;

      const pendingForPair = pendingAssets.filter((a) => pairKey(a) === `${costAccountId}::${accumulatedDepreciationAccountId}`);
      const disposedForPair = groupAssets.length - activeGroupAssets.length;

      results.push({
        costAccountId,
        accumulatedDepreciationAccountId,
        registerCost,
        costGlBalance: costGl.closingBalanceBase,
        costMatched: registerCost === costGl.closingBalanceBase,
        registerAccumulatedDepreciation,
        accumulatedDepreciationGlBalance: accumDepPositiveRow.v,
        accumulatedDepreciationMatched: registerAccumulatedDepreciation === accumDepPositiveRow.v,
        registerNetBookValue: registerNbvRow.nbv,
        glNetBookValue: nbvRow.nbv,
        netBookValueMatched: registerNbvRow.nbv === nbvRow.nbv,
        pendingAcquisitionCount: pendingForPair.length,
        pendingAcquisitionCost: await this.registerCostSum(pendingForPair.map((a) => a.id)),
        disposedAssetCount: disposedForPair,
      });
    }
    return { pairs: results };
  }

  private async registerCostSum(fixedAssetIds: string[]): Promise<string> {
    if (fixedAssetIds.length === 0) return '0.0000';
    const [row] = (await this.dataSource.query(
      `SELECT COALESCE(SUM("cost"), 0)::numeric(20,4) AS total FROM accounting_fixed_assets WHERE id = ANY($1::uuid[])`,
      [fixedAssetIds],
    )) as Array<{ total: string }>;
    return row.total;
  }

  private async registerAccumulatedDepreciation(fixedAssetIds: string[]): Promise<string> {
    if (fixedAssetIds.length === 0) return '0.0000';
    const [row] = (await this.dataSource.query(
      `SELECT COALESCE(SUM("calculatedAmount"), 0)::numeric(20,4) AS total FROM accounting_depreciation_run_lines WHERE "fixedAssetId" = ANY($1::uuid[])`,
      [fixedAssetIds],
    )) as Array<{ total: string }>;
    return row.total;
  }
}
