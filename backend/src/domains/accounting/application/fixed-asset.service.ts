import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { FixedAsset } from '../infrastructure/fixed-asset.entity';
import { FixedAssetCategoryAccountMapping } from '../infrastructure/fixed-asset-category-account-mapping.entity';
import { DepreciationRunLine } from '../infrastructure/depreciation-run-line.entity';
import { JournalEntry } from '../infrastructure/journal-entry.entity';
import { JournalLine } from '../infrastructure/journal-line.entity';
import { GLAccountService } from './gl-account.service';
import { FinancialDimensionValue } from '../infrastructure/financial-dimension-value.entity';
import { FIXED_ASSET_ENTITY_TYPE, FIXED_ASSET_PROCESS, DepreciationMethod, isDepreciationMethod } from '../domain/fixed-asset';
import { JOURNAL_ENTRY_ENTITY_TYPE, JOURNAL_ENTRY_PROCESS } from '../domain/journal';
import { normaliseAmount } from '../domain/money';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { AuditService } from '../../../foundation/audit/audit.service';

export interface CreateFixedAssetInput {
  code: string;
  name: string;
  categoryDimensionValueId?: string | null;
  acquisitionDate: string;
  cost: string;
  salvageValue?: string;
  usefulLifeMonths: number;
  depreciationMethod?: DepreciationMethod;
  costAccountId?: string;
  accumulatedDepreciationAccountId?: string;
  depreciationExpenseAccountId?: string;
  orgUnitId?: string | null;
  /** Supplying this at creation transitions the asset straight to `active` (ADR-045 D7). */
  acquisitionJournalEntryId?: string | null;
}

export interface UpdateFixedAssetInput {
  name?: string;
  orgUnitId?: string | null;
  categoryDimensionValueId?: string | null;
  // depreciation-affecting fields — only accepted before the asset's first DepreciationRunLine (D12)
  cost?: string;
  salvageValue?: string;
  usefulLifeMonths?: number;
  depreciationMethod?: DepreciationMethod;
  costAccountId?: string;
  accumulatedDepreciationAccountId?: string;
  depreciationExpenseAccountId?: string;
}

export interface FixedAssetView extends FixedAsset {
  lifecycleState: string;
}

const DEPRECIATION_AFFECTING_FIELDS = [
  'cost',
  'salvageValue',
  'usefulLifeMonths',
  'depreciationMethod',
  'costAccountId',
  'accumulatedDepreciationAccountId',
  'depreciationExpenseAccountId',
] as const;

/**
 * F12 — Fixed Assets (ADR-045). The register: create/update/link-acquisition, and lifecycle reads.
 * Depreciation-affecting fields LOCK once the asset's first `DepreciationRunLine` exists (D12) — never
 * silently accepted, never silently ignored: an edit attempt on a locked field is REJECTED.
 */
@Injectable()
export class FixedAssetService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly glAccounts: GLAccountService,
    private readonly processEngine: ProcessEngineService,
    private readonly audit: AuditService,
  ) {}

  private em(manager?: EntityManager): EntityManager {
    return manager ?? this.dataSource.manager;
  }

  async listAssets(manager?: EntityManager): Promise<FixedAssetView[]> {
    const assets = await this.em(manager).getRepository(FixedAsset).find({ order: { code: 'ASC' } });
    return Promise.all(assets.map((a) => this.toView(a, manager)));
  }

  async getAsset(id: string, manager?: EntityManager): Promise<FixedAssetView> {
    const asset = await this.em(manager).getRepository(FixedAsset).findOne({ where: { id } });
    if (!asset) throw new NotFoundException(`Fixed asset "${id}" not found.`);
    return this.toView(asset, manager);
  }

  private async toView(asset: FixedAsset, manager?: EntityManager): Promise<FixedAssetView> {
    const lifecycleState = await this.processEngine.getState(FIXED_ASSET_PROCESS, FIXED_ASSET_ENTITY_TYPE, asset.id, manager);
    return { ...asset, lifecycleState };
  }

  // ---------------------------------------------------------------------------
  // Create
  // ---------------------------------------------------------------------------

  async createAsset(input: CreateFixedAssetInput, actorUserId: string, manager?: EntityManager): Promise<FixedAssetView> {
    const salvageValue = input.salvageValue ?? '0';
    if (Number(salvageValue) > Number(input.cost)) {
      throw new BadRequestException('salvageValue cannot exceed cost.');
    }
    if (!Number.isInteger(input.usefulLifeMonths) || input.usefulLifeMonths <= 0) {
      throw new BadRequestException('usefulLifeMonths must be a positive integer.');
    }
    const depreciationMethod = input.depreciationMethod ?? 'straight_line';
    if (!isDepreciationMethod(depreciationMethod)) {
      throw new BadRequestException(`Unknown depreciation method "${depreciationMethod}".`);
    }

    let categoryDefault: FixedAssetCategoryAccountMapping | null = null;
    if (input.categoryDimensionValueId) {
      await this.assertDimensionValueExists(input.categoryDimensionValueId, manager);
      categoryDefault = await this.em(manager)
        .getRepository(FixedAssetCategoryAccountMapping)
        .findOne({ where: { categoryDimensionValueId: input.categoryDimensionValueId } });
    }

    const costAccountId = input.costAccountId ?? categoryDefault?.defaultCostAccountId;
    const accumulatedDepreciationAccountId = input.accumulatedDepreciationAccountId ?? categoryDefault?.defaultAccumulatedDepreciationAccountId;
    const depreciationExpenseAccountId = input.depreciationExpenseAccountId ?? categoryDefault?.defaultDepreciationExpenseAccountId;
    if (!costAccountId || !accumulatedDepreciationAccountId || !depreciationExpenseAccountId) {
      throw new BadRequestException(
        'costAccountId, accumulatedDepreciationAccountId, and depreciationExpenseAccountId are required (directly, or via a category default mapping).',
      );
    }
    await this.assertAccountShape(costAccountId, 'asset', false, 'costAccountId', manager);
    await this.assertAccountShape(accumulatedDepreciationAccountId, 'asset', true, 'accumulatedDepreciationAccountId', manager);
    await this.assertAccountShape(depreciationExpenseAccountId, 'expense', false, 'depreciationExpenseAccountId', manager);

    const depreciableBase = normaliseAmount(String(Number(input.cost) - Number(salvageValue)), 4);

    const asset = await this.em(manager).transaction(async (manager) => {
      const repo = manager.getRepository(FixedAsset);
      let saved: FixedAsset;
      try {
        saved = await repo.save(
          repo.create({
            code: input.code,
            name: input.name,
            categoryDimensionValueId: input.categoryDimensionValueId ?? null,
            acquisitionDate: input.acquisitionDate,
            cost: normaliseAmount(input.cost, 4),
            salvageValue: normaliseAmount(salvageValue, 4),
            usefulLifeMonths: input.usefulLifeMonths,
            depreciationMethod,
            depreciableBase,
            costAccountId,
            accumulatedDepreciationAccountId,
            depreciationExpenseAccountId,
            orgUnitId: input.orgUnitId ?? null,
            acquisitionJournalEntryId: null,
          }),
        );
      } catch (err) {
        throw this.translateDbError(err, input.code);
      }
      await this.processEngine.start(FIXED_ASSET_PROCESS, FIXED_ASSET_ENTITY_TYPE, saved.id, manager);

      if (input.acquisitionJournalEntryId) {
        await this.linkAcquisitionInternal(manager, saved, input.acquisitionJournalEntryId, actorUserId);
      }

      await this.audit.record(
        {
          actorUserId,
          organizationId: null,
          action: 'accounting.fixed_asset.created',
          resource: 'fixed_asset',
          resourceId: saved.id,
          result: 'success',
          correlationId: null,
          after: { code: saved.code, cost: saved.cost, usefulLifeMonths: saved.usefulLifeMonths },
        },
        manager,
      );
      return saved;
    });

    return this.getAsset(asset.id, manager);
  }

  // ---------------------------------------------------------------------------
  // Update (D12 — depreciation-affecting fields lock after the first posted charge)
  // ---------------------------------------------------------------------------

  async updateAsset(id: string, input: UpdateFixedAssetInput, actorUserId: string, manager?: EntityManager): Promise<FixedAssetView> {
    return this.em(manager)
      .transaction(async (manager) => {
        const repo = manager.getRepository(FixedAsset);
        const asset = await repo.findOne({ where: { id } });
        if (!asset) throw new NotFoundException(`Fixed asset "${id}" not found.`);

        const requestedDepreciationFields = DEPRECIATION_AFFECTING_FIELDS.filter((f) => input[f] !== undefined);
        if (requestedDepreciationFields.length > 0) {
          const postedLineCount = await manager.getRepository(DepreciationRunLine).count({ where: { fixedAssetId: id } });
          if (postedLineCount > 0) {
            throw new ConflictException(
              `Fixed asset "${asset.code}" has at least one posted depreciation charge — ${requestedDepreciationFields.join(', ')} ` +
                'can no longer be edited (ADR-045 D12). A recalculation/policy-change pathway is out of scope for V1.',
            );
          }
        }

        const before = { ...asset };
        if (input.name !== undefined) asset.name = input.name;
        if (input.orgUnitId !== undefined) asset.orgUnitId = input.orgUnitId;
        if (input.categoryDimensionValueId !== undefined) {
          if (input.categoryDimensionValueId) await this.assertDimensionValueExists(input.categoryDimensionValueId, manager);
          asset.categoryDimensionValueId = input.categoryDimensionValueId;
        }
        if (input.cost !== undefined) asset.cost = normaliseAmount(input.cost, 4);
        if (input.salvageValue !== undefined) asset.salvageValue = normaliseAmount(input.salvageValue, 4);
        if (input.usefulLifeMonths !== undefined) {
          if (!Number.isInteger(input.usefulLifeMonths) || input.usefulLifeMonths <= 0) {
            throw new BadRequestException('usefulLifeMonths must be a positive integer.');
          }
          asset.usefulLifeMonths = input.usefulLifeMonths;
        }
        if (input.depreciationMethod !== undefined) {
          if (!isDepreciationMethod(input.depreciationMethod)) throw new BadRequestException(`Unknown depreciation method "${input.depreciationMethod}".`);
          asset.depreciationMethod = input.depreciationMethod;
        }
        if (input.costAccountId !== undefined) {
          await this.assertAccountShape(input.costAccountId, 'asset', false, 'costAccountId', manager);
          asset.costAccountId = input.costAccountId;
        }
        if (input.accumulatedDepreciationAccountId !== undefined) {
          await this.assertAccountShape(input.accumulatedDepreciationAccountId, 'asset', true, 'accumulatedDepreciationAccountId', manager);
          asset.accumulatedDepreciationAccountId = input.accumulatedDepreciationAccountId;
        }
        if (input.depreciationExpenseAccountId !== undefined) {
          await this.assertAccountShape(input.depreciationExpenseAccountId, 'expense', false, 'depreciationExpenseAccountId', manager);
          asset.depreciationExpenseAccountId = input.depreciationExpenseAccountId;
        }
        if (Number(asset.salvageValue) > Number(asset.cost)) {
          throw new BadRequestException('salvageValue cannot exceed cost.');
        }
        if (input.cost !== undefined || input.salvageValue !== undefined) {
          asset.depreciableBase = normaliseAmount(String(Number(asset.cost) - Number(asset.salvageValue)), 4);
        }

        const saved = await repo.save(asset);
        await this.audit.record(
          {
            actorUserId,
            organizationId: null,
            action: 'accounting.fixed_asset.updated',
            resource: 'fixed_asset',
            resourceId: id,
            result: 'success',
            correlationId: null,
            before: { name: before.name, cost: before.cost, salvageValue: before.salvageValue, usefulLifeMonths: before.usefulLifeMonths },
            after: { name: saved.name, cost: saved.cost, salvageValue: saved.salvageValue, usefulLifeMonths: saved.usefulLifeMonths },
          },
          manager,
        );
        return saved.id;
      })
      .then((id) => this.getAsset(id, manager));
  }

  // ---------------------------------------------------------------------------
  // Link acquisition (ADR-045 D7 — full 5-point validation, Mandatory Correction #3)
  // ---------------------------------------------------------------------------

  /**
   * D8 (2026-10-05, CTO: keep the manual-JE + link-acquisition architecture, complete the UI workflow) — the POSTED journal entries
   * the maker may link as this asset's acquisition: a line on the asset's cost account whose debit EXACTLY equals the cost, not
   * already the acquisition of another asset. READ-ONLY — it creates nothing and posts nothing; `linkAcquisitionJournalEntry` still
   * re-validates every rule at link time. Only a `pending_acquisition` asset has candidates.
   */
  async listAcquisitionCandidates(
    id: string,
    manager?: EntityManager,
  ): Promise<Array<{ journalEntryId: string; entryNumber: string | null; businessDate: string; description: string | null; debit: string }>> {
    const asset = await this.em(manager).getRepository(FixedAsset).findOne({ where: { id } });
    if (!asset) throw new NotFoundException(`Fixed asset "${id}" not found.`);
    const state = await this.processEngine.getState(FIXED_ASSET_PROCESS, FIXED_ASSET_ENTITY_TYPE, id, manager);
    if (state !== 'pending_acquisition') return [];
    const rows: Array<{ id: string; entryNumber: string | null; businessDate: string; description: string | null; debit: string }> = await this.em(manager).query(
      `SELECT je.id, je."entryNumber", je."businessDate"::text AS "businessDate", je.description, jl."debitTransaction"::text AS debit
         FROM "accounting_journal_entries" je
         JOIN "accounting_journal_lines" jl ON jl."journalEntryId" = je.id
        WHERE jl."accountId" = $1::uuid AND jl."debitTransaction" = $2::numeric
          AND NOT EXISTS (SELECT 1 FROM "accounting_fixed_assets" fa WHERE fa."acquisitionJournalEntryId" = je.id)
        ORDER BY je."businessDate" DESC, je."createdAt" DESC
        LIMIT 100`,
      [asset.costAccountId, normaliseAmount(asset.cost, 4)],
    );
    const posted: typeof rows = [];
    for (const row of rows) {
      if ((await this.processEngine.getState(JOURNAL_ENTRY_PROCESS, JOURNAL_ENTRY_ENTITY_TYPE, row.id, manager)) === 'POSTED') posted.push(row);
      if (posted.length >= 50) break;
    }
    return posted.map((r) => ({ journalEntryId: r.id, entryNumber: r.entryNumber, businessDate: r.businessDate, description: r.description, debit: r.debit }));
  }

  async linkAcquisitionJournalEntry(id: string, journalEntryId: string, actorUserId: string, manager?: EntityManager): Promise<FixedAssetView> {
    await this.em(manager).transaction(async (manager) => {
      const asset = await manager.getRepository(FixedAsset).findOne({ where: { id } });
      if (!asset) throw new NotFoundException(`Fixed asset "${id}" not found.`);
      const state = await this.processEngine.getState(FIXED_ASSET_PROCESS, FIXED_ASSET_ENTITY_TYPE, id, manager);
      if (state !== 'pending_acquisition') {
        throw new ConflictException(`Fixed asset "${asset.code}" is "${state}", not "pending_acquisition" — nothing to link.`);
      }
      await this.linkAcquisitionInternal(manager, asset, journalEntryId, actorUserId);
    });
    return this.getAsset(id, manager);
  }

  private async linkAcquisitionInternal(manager: EntityManager, asset: FixedAsset, journalEntryId: string, actorUserId: string): Promise<void> {
    // 1. POSTED
    const entry = await manager.getRepository(JournalEntry).findOne({ where: { id: journalEntryId } });
    if (!entry) throw new NotFoundException(`Journal entry "${journalEntryId}" not found.`);
    const entryState = await this.processEngine.getState(JOURNAL_ENTRY_PROCESS, JOURNAL_ENTRY_ENTITY_TYPE, journalEntryId, manager);
    if (entryState !== 'POSTED') {
      throw new ConflictException(`Journal entry "${journalEntryId}" is "${entryState}", not POSTED — cannot use it as an acquisition reference.`);
    }
    // 2/3. has a line on costAccountId, debit EXACTLY equal to cost
    const lines = await manager.getRepository(JournalLine).find({ where: { journalEntryId } });
    const match = lines.find((l) => l.accountId === asset.costAccountId);
    if (!match) {
      throw new ConflictException(`Journal entry "${journalEntryId}" has no line on this asset's cost account "${asset.costAccountId}".`);
    }
    if (normaliseAmount(match.debitTransaction, 4) !== normaliseAmount(asset.cost, 4)) {
      throw new ConflictException(
        `Journal entry "${journalEntryId}"'s debit on the cost account (${match.debitTransaction}) does not exactly match the asset's cost (${asset.cost}).`,
      );
    }
    // 4. balanced — guaranteed by construction for any POSTED entry (F03's posting gate), confirmed not re-checked.
    // 5. uniqueness — enforced by the DB constraint; translate its violation into a clear message.
    asset.acquisitionJournalEntryId = journalEntryId;
    try {
      await manager.getRepository(FixedAsset).save(asset);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/duplicate key value violates unique constraint/i.test(msg) || /UQ_accounting_fixed_assets_acquisition_journal/i.test(msg)) {
        throw new ConflictException(`Journal entry "${journalEntryId}" is already linked as the acquisition reference of a different fixed asset.`);
      }
      throw err;
    }
    await this.processEngine.transition(FIXED_ASSET_PROCESS, FIXED_ASSET_ENTITY_TYPE, asset.id, 'link_acquisition', actorUserId, manager);
    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'accounting.fixed_asset.acquisition_linked',
        resource: 'fixed_asset',
        resourceId: asset.id,
        result: 'success',
        correlationId: journalEntryId,
        after: { journalEntryId },
      },
      manager,
    );
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async assertDimensionValueExists(id: string, manager?: EntityManager): Promise<void> {
    const value = await this.em(manager).getRepository(FinancialDimensionValue).findOne({ where: { id } });
    if (!value) throw new NotFoundException(`Financial dimension value "${id}" not found.`);
    if (!value.isActive) throw new ConflictException(`Financial dimension value "${value.code}" is inactive.`);
  }

  private async assertAccountShape(accountId: string, accountType: string, isContra: boolean, fieldName: string, manager?: EntityManager): Promise<void> {
    const account = await this.glAccounts.getAccount(accountId, manager); // throws NotFoundException
    if (!account.isActive) throw new ConflictException(`${fieldName}: GL account "${account.code}" is inactive.`);
    if (account.accountType !== accountType) {
      throw new ConflictException(`${fieldName}: GL account "${account.code}" must be of type "${accountType}", not "${account.accountType}".`);
    }
    if (account.isContra !== isContra) {
      throw new ConflictException(`${fieldName}: GL account "${account.code}" must have isContra=${isContra}.`);
    }
  }

  private translateDbError(err: unknown, code: string): Error {
    const message = err instanceof Error ? err.message : String(err);
    if (/duplicate key value violates unique constraint/i.test(message) || /UQ_accounting_fixed_assets_code/i.test(message)) {
      return new ConflictException(`A fixed asset with code "${code}" already exists.`);
    }
    return err instanceof Error ? err : new Error(message);
  }
}
