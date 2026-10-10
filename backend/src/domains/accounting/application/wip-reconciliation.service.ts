import { ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { utcBusinessDate } from '../../../foundation/localization/business-date';
import { DataSource, EntityManager } from 'typeorm';
import { WipReconciliationRun } from '../infrastructure/wip-reconciliation-run.entity';
import { GLAccount } from '../infrastructure/gl-account.entity';
import { LedgerService } from './ledger.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { MANUFACTURING_WIP_CONTRACT, ManufacturingWipContract } from '../../../foundation/module-registry/contracts/manufacturing-wip.contract';

export interface WipReconcileInput {
  fiscalPeriodId?: string | null;
  asOfDate?: string;
  orgUnitId?: string | null;
}

/**
 * ADR-061 (Manufacturing) Month-End dependency, resolved per the independent
 * post-implementation review's Phase 1 finding. WIP↔GL reconciliation — a
 * NEW, SEPARATE reconciliation dimension, exactly mirroring how GRNI became
 * its own Phase 8 reconciliation type rather than being folded into AP
 * (`ADR-056`) — never merged into `InventoryReconciliationService`, because
 * netting the two together would silently hide a real failure a split
 * reconciliation catches: a rejected Manufacturing Financial Event (F08
 * moves value from a real warehouse into a WIP sub-warehouse synchronously,
 * independent of whether the async GL post later succeeds) nets to zero
 * under a combined inventory+wip comparison but shows up correctly as
 * drift on exactly one of the two lines under this split design.
 *
 * `InventoryReconciliationService` was narrowed (same session) to exclude
 * every WIP sub-warehouse from ITS OWN subledger sum — this service is the
 * other half of that split, covering exactly the excluded slice.
 *
 *   - `MANUFACTURING_WIP_CONTRACT` UNBOUND (Manufacturing not installed):
 *     every run records `no_subledger_source` and shows the GL side (the
 *     `wip` control account balance, if one is even configured) for
 *     reference only — **never `matched`**;
 *   - contract BOUND: Σ every Work Order's WIP sub-warehouse value (via the
 *     contract, never a raw table read) vs the `wip` GL control account,
 *     `matched | drift_found`.
 *
 * Read-only — it never posts a correcting entry. All arithmetic SQL
 * `NUMERIC` (ADR-035 D4), same discipline as the other six reconciliation
 * services.
 */
@Injectable()
export class WipReconciliationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    @Optional() @Inject(MANUFACTURING_WIP_CONTRACT) private readonly manufacturingWip?: ManufacturingWipContract,
  ) {}

  async listRuns(filter?: { status?: string; from?: string; to?: string }, manager?: EntityManager): Promise<WipReconciliationRun[]> {
    const qb = (manager ?? this.dataSource).getRepository(WipReconciliationRun).createQueryBuilder('r');
    if (filter?.status) qb.andWhere('r.status = :s', { s: filter.status });
    if (filter?.from) qb.andWhere('r."asOfDate" >= :f', { f: filter.from });
    if (filter?.to) qb.andWhere('r."asOfDate" <= :t', { t: filter.to });
    return qb.orderBy('r."createdAt"', 'DESC').getMany();
  }

  async getRun(id: string, manager?: EntityManager): Promise<WipReconciliationRun> {
    const run = await (manager ?? this.dataSource).getRepository(WipReconciliationRun).findOne({ where: { id } });
    if (!run) throw new NotFoundException(`WIP reconciliation run "${id}" not found.`);
    return run;
  }

  private async wipAccount(manager?: EntityManager): Promise<GLAccount | null> {
    return (manager ?? this.dataSource).getRepository(GLAccount).findOne({ where: { controlFunction: 'wip', isActive: true } });
  }

  /**
   * Mirrors `GrniReconciliationService.reconcile`'s "never throw, report
   * `no_subledger_source`" discipline for a not-yet-configured control
   * account (ADR-056) — a chart with no `wip` account configured is the
   * expected state for every installation until Manufacturing is both
   * installed AND has posted its first Work Order Financial Event
   * (`SeedManufacturingTerminology`/the live test both create one lazily;
   * a fresh chart otherwise has none).
   */
  async reconcile(input: WipReconcileInput, actorUserId: string, manager?: EntityManager): Promise<WipReconciliationRun> {
    const asOfDate = input.asOfDate ?? utcBusinessDate();
    const wip = await this.wipAccount(manager);
    const repo = (manager ?? this.dataSource).getRepository(WipReconciliationRun);

    if (!wip) {
      const saved = await this.save(repo, {
        input,
        asOfDate,
        subledgerTotalBase: null,
        glBalanceBase: '0.0000',
        driftBase: null,
        status: 'no_subledger_source',
        driftBreakdown: {
          note:
            'No active `wip` control account exists in the chart of accounts yet — assign controlFunction "wip" to an account to activate this check. ' +
            'Expected for every installation until Manufacturing has posted its first Work Order Financial Event (ADR-061 §13).',
        },
        actorUserId,
      });
      await this.recordAudit(actorUserId, saved, { asOfDate, status: 'no_subledger_source', reason: 'no_wip_account_configured' }, manager);
      return saved;
    }

    const gl = await this.ledger.getAccountLedger(wip.id, { to: asOfDate, orgUnitId: input.orgUnitId ?? undefined }, manager);
    const glBalanceBase = gl.closingBalanceBase;

    if (!this.manufacturingWip) {
      const saved = await this.save(repo, {
        input,
        asOfDate,
        subledgerTotalBase: null,
        glBalanceBase,
        driftBase: null,
        status: 'no_subledger_source',
        driftBreakdown: {
          note:
            'No operational Manufacturing WIP source is registered (MANUFACTURING_WIP_CONTRACT unbound). ' +
            'WIP reconciliation activates when the `manufacturing` module (ADR-061) is installed. ' +
            'The GL side (the `wip` control account balance) is shown for reference only — this is NOT a match.',
          glClosingBalanceBase: glBalanceBase,
          glLineCount: gl.lines.length,
        },
        actorUserId,
      });
      await this.recordAudit(actorUserId, saved, { asOfDate, glBalanceBase, status: 'no_subledger_source' }, manager);
      return saved;
    }

    const sub = await this.manufacturingWip.getAllWipBalances(asOfDate, manager);
    const subledgerTotalBase = sub.total;
    // `wip` is an asset control account (debit-normal, same as `inventory`) — no sign flip needed,
    // unlike GRNI's credit-normal liability comparison.
    const [d] = (await (manager ?? this.dataSource).query(`SELECT ($1::numeric(20,4) - $2::numeric(20,4))::numeric(20,4) AS drift`, [
      subledgerTotalBase,
      glBalanceBase,
    ])) as Array<{ drift: string }>;
    const driftBase = d.drift;
    const matched = Number(driftBase) === 0;

    const driftBreakdown: Record<string, unknown> | null = matched
      ? null
      : {
          note: 'Outstanding Work Order WIP balances and the GL `wip` account differ. Common causes: a Manufacturing FinancialEvent REJECTED (never posted); a manual journal on the wip account (blocked — allowManualJournal=false).',
          workOrderCount: sub.balances.length,
          workOrderBalances: sub.balances.slice(0, 200),
          glClosingBalanceBase: glBalanceBase,
          glLineCount: gl.lines.length,
        };

    const saved = await this.save(repo, {
      input,
      asOfDate,
      subledgerTotalBase,
      glBalanceBase,
      driftBase,
      status: matched ? 'matched' : 'drift_found',
      driftBreakdown,
      actorUserId,
    });
    await this.recordAudit(actorUserId, saved, { asOfDate, subledgerTotalBase, glBalanceBase, driftBase, status: saved.status }, manager);
    return saved;
  }

  async closeRun(id: string, actorUserId: string, manager?: EntityManager): Promise<WipReconciliationRun> {
    const run = await this.getRun(id, manager);
    if (run.status === 'closed') return run;
    run.status = 'closed';
    run.closedAt = new Date();
    const saved = await (manager ?? this.dataSource).getRepository(WipReconciliationRun).save(run);
    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'accounting.wip_reconciliation.closed',
        resource: 'wip_reconciliation_run',
        resourceId: id,
        result: 'success',
        correlationId: null,
      },
      manager,
    );
    return saved;
  }

  private async save(
    repo: ReturnType<DataSource['getRepository']>,
    data: {
      input: WipReconcileInput;
      asOfDate: string;
      subledgerTotalBase: string | null;
      glBalanceBase: string;
      driftBase: string | null;
      status: WipReconciliationRun['status'];
      driftBreakdown: Record<string, unknown> | null;
      actorUserId: string;
    },
  ): Promise<WipReconciliationRun> {
    try {
      return (await repo.save(
        repo.create({
          fiscalPeriodId: data.input.fiscalPeriodId ?? null,
          asOfDate: data.asOfDate,
          orgUnitId: data.input.orgUnitId ?? null,
          subledgerTotalBase: data.subledgerTotalBase,
          glBalanceBase: data.glBalanceBase,
          driftBase: data.driftBase,
          status: data.status,
          driftBreakdown: data.driftBreakdown,
          runByUserId: data.actorUserId,
          closedAt: null,
        }),
      )) as WipReconciliationRun;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/one_open/i.test(msg) || /duplicate key value/i.test(msg)) {
        throw new ConflictException('An open WIP reconciliation run already exists for this period/org scope — close it first.');
      }
      throw err;
    }
  }

  private async recordAudit(actorUserId: string, saved: WipReconciliationRun, after: Record<string, unknown>, manager?: EntityManager): Promise<void> {
    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'accounting.wip_reconciliation.run',
        resource: 'wip_reconciliation_run',
        resourceId: saved.id,
        result: 'success',
        correlationId: null,
        after,
      },
      manager,
    );
  }
}
