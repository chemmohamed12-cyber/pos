import { ConflictException, Injectable, OnModuleInit } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { FixedAssetService, FixedAssetView } from './fixed-asset.service';
import { FinancialEventService } from './financial-events/financial-event.service';
import { FinancialEventHandlerRegistry } from './financial-events/handler-registry';
import {
  ACQUISITION_CLEARING_ACCOUNT_CONFIG_KEY,
  FIXED_ASSET_ACQUISITION_REQUESTED_EVENT,
  handleFixedAssetAcquisitionRequested,
} from './financial-events/fixed-asset-acquisition.handler';
import { AuditService } from '../../../foundation/audit/audit.service';

/**
 * D8 Acquisition-Journal Helper (2026-10-06, CTO decision: Option C — Acquisition Clearing). One action on a `pending_acquisition` asset:
 * creates and POSTS the acquisition journal **Dr asset cost account / Cr Fixed Asset Acquisition Clearing** for exactly the asset's cost, then
 * links it through the existing, unchanged `linkAcquisitionJournalEntry` (which re-validates every rule) so the asset becomes `active`.
 *
 * Scope discipline (CTO): the helper never assumes the asset was bought on credit or for cash — it does NOT touch Accounts Payable or Treasury;
 * the clearing account is settled later by the real workflow. The clearing account comes only from configuration
 * (`accounting.fixed_asset_acquisition_clearing_account_code`, no default) and must exist, be active, postable and not a control account;
 * otherwise the request is rejected BEFORE any mutation. The whole operation (event + journal + link) is ONE transaction. The manual-JE +
 * link workflow stays available and unchanged.
 */
@Injectable()
export class FixedAssetAcquisitionService implements OnModuleInit {
  constructor(
    private readonly dataSource: DataSource,
    private readonly assets: FixedAssetService,
    private readonly financialEvents: FinancialEventService,
    private readonly registry: FinancialEventHandlerRegistry,
    private readonly audit: AuditService,
  ) {}

  private em(manager?: EntityManager): EntityManager {
    return manager ?? this.dataSource.manager;
  }

  onModuleInit(): void {
    if (!this.registry.get(FIXED_ASSET_ACQUISITION_REQUESTED_EVENT)) {
      this.registry.register(FIXED_ASSET_ACQUISITION_REQUESTED_EVENT, handleFixedAssetAcquisitionRequested);
    }
  }

  async createAcquisitionJournal(
    assetId: string,
    actorUserId: string,
    manager?: EntityManager,
  ): Promise<{ journalEntryId: string; asset: FixedAssetView }> {
    const asset = await this.assets.getAsset(assetId, manager);
    if (asset.lifecycleState !== 'pending_acquisition') {
      throw new ConflictException(`Fixed asset "${asset.code}" is "${asset.lifecycleState}" — an acquisition journal can only be created for a "pending_acquisition" asset.`);
    }
    // Fail closed BEFORE any mutation: the clearing account must be configured and usable (same resolution the posting handler will perform).
    const resolved = await this.financialEvents.preflightConfiguredPostableAccount(ACQUISITION_CLEARING_ACCOUNT_CONFIG_KEY, this.em(manager));
    if (!resolved.ok) {
      throw new ConflictException(
        `The Fixed Asset Acquisition Clearing account is not usable (${resolved.reason}). Configure "${ACQUISITION_CLEARING_ACCOUNT_CONFIG_KEY}" with an active, postable, non-control account before creating an acquisition journal.`,
      );
    }

    return this.em(manager).transaction(async (tx) => {
      const result = await this.financialEvents.ingest(
        FIXED_ASSET_ACQUISITION_REQUESTED_EVENT,
        {
          idempotencyKey: `accounting:fixed_asset_acquisition:${asset.id}`,
          sourceEntityType: 'fixed_asset',
          sourceEntityId: asset.id,
          payloadVersion: 1,
          businessDate: String(asset.acquisitionDate).slice(0, 10),
          orgUnitId: asset.orgUnitId ?? null,
          fixedAssetId: asset.id,
          costAccountId: asset.costAccountId,
          cost: asset.cost,
        },
        tx,
      );
      if (result.status !== 'POSTED' || !result.journalEntryId) {
        const row = (await tx.query(`SELECT "rejectionReason" FROM accounting_financial_events WHERE id = $1`, [result.financialEventId])) as Array<{ rejectionReason: string | null }>;
        throw new ConflictException(`The acquisition journal could not be posted (${result.status}${row[0]?.rejectionReason ? `: ${row[0].rejectionReason}` : ''}). Nothing was created.`);
      }
      const linked = await this.assets.linkAcquisitionJournalEntry(asset.id, result.journalEntryId, actorUserId, tx);
      await this.audit.record(
        {
          actorUserId,
          organizationId: null,
          action: 'accounting.fixed_asset.acquisition_journal_created',
          resource: 'fixed_asset',
          resourceId: asset.id,
          result: 'success',
          correlationId: result.journalEntryId,
          after: { journalEntryId: result.journalEntryId, cost: asset.cost },
        },
        tx,
      );
      return { journalEntryId: result.journalEntryId, asset: linked };
    });
  }
}
