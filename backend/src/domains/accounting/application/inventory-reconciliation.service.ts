import { ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { utcBusinessDate } from '../../../foundation/localization/business-date';
import { DataSource, EntityManager } from 'typeorm';
import { InventoryReconciliationRun } from '../infrastructure/inventory-reconciliation-run.entity';
import { GLAccount } from '../infrastructure/gl-account.entity';
import { LedgerService } from './ledger.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { INVENTORY_VALUATION_CONTRACT, InventoryValuationContract } from '../../../foundation/module-registry/contracts/inventory-events.contract';
import { MANUFACTURING_WIP_CONTRACT, ManufacturingWipContract } from '../../../foundation/module-registry/contracts/manufacturing-wip.contract';

export interface InventoryReconcileInput {
  fiscalPeriodId?: string | null;
  asOfDate?: string;
  orgUnitId?: string | null;
}

/**
 * F07 — Inventory Accounting (ADR-040 D10, CTO Mandatory Condition E).
 * Inventory↔GL reconciliation. The mirror of `ApReconciliationService`,
 * **guarded/inactive** until an `InventoryValuationContract` implementation
 * is provided by the future F08 (Inventory Valuation) phase:
 *   - contract UNBOUND (today): every run records `no_valuation_source`
 *     and shows the GL side (the `inventory` control account balance) for
 *     reference only — **NEVER `matched`**;
 *   - contract BOUND (future F08): identical to `ApReconciliationService`'s
 *     bound branch — Σ valued on-hand (via the contract, never a raw table
 *     read) vs the `inventory` GL balance, `matched | drift_found`.
 *
 * Read-only — it never posts a correcting entry. All arithmetic SQL
 * `NUMERIC` (ADR-035 D4). No auto-correction, ever.
 */
@Injectable()
export class InventoryReconciliationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    @Optional() @Inject(INVENTORY_VALUATION_CONTRACT) private readonly valuation?: InventoryValuationContract,
    // Month-End dependency (independent review, Phase 1) — when Manufacturing is installed, every
    // Work Order's dedicated WIP sub-warehouse (ADR-061 §6) is EXCLUDED from this service's own
    // subledger sum below: its value has already been reclassified out of the `inventory` GL
    // control account into `wip` (Dr WIP / Cr Inventory), so it belongs to `WipReconciliationService`'s
    // own comparison against the `wip` account, never this one's. `@Optional()` — when Manufacturing
    // is not installed, `valued` is used exactly as before, unchanged (Case F: no behavior change for
    // any non-Manufacturing installation).
    @Optional() @Inject(MANUFACTURING_WIP_CONTRACT) private readonly manufacturingWip?: ManufacturingWipContract,
  ) {}

  private em(manager?: EntityManager): EntityManager {
    return manager ?? this.dataSource.manager;
  }

  async listRuns(filter?: { status?: string; from?: string; to?: string }, manager?: EntityManager): Promise<InventoryReconciliationRun[]> {
    const qb = this.em(manager).getRepository(InventoryReconciliationRun).createQueryBuilder('r');
    if (filter?.status) qb.andWhere('r.status = :s', { s: filter.status });
    if (filter?.from) qb.andWhere('r."asOfDate" >= :f', { f: filter.from });
    if (filter?.to) qb.andWhere('r."asOfDate" <= :t', { t: filter.to });
    return qb.orderBy('r."createdAt"', 'DESC').getMany();
  }

  async getRun(id: string, manager?: EntityManager): Promise<InventoryReconciliationRun> {
    const run = await this.em(manager).getRepository(InventoryReconciliationRun).findOne({ where: { id } });
    if (!run) throw new NotFoundException(`Inventory reconciliation run "${id}" not found.`);
    return run;
  }

  private async inventoryAccount(manager?: EntityManager): Promise<GLAccount> {
    const acc = await this.em(manager).getRepository(GLAccount).findOne({ where: { controlFunction: 'inventory', isActive: true } });
    if (!acc) {
      throw new ConflictException('No active `inventory` control account in the chart of accounts — assign controlFunction "inventory" to an account first.');
    }
    return acc;
  }

  async reconcile(input: InventoryReconcileInput, actorUserId: string, manager?: EntityManager): Promise<InventoryReconciliationRun> {
    const asOfDate = input.asOfDate ?? utcBusinessDate();
    const inv = await this.inventoryAccount(manager);

    // GL side — always computed
    const gl = await this.ledger.getAccountLedger(inv.id, { to: asOfDate, orgUnitId: input.orgUnitId ?? undefined }, manager);
    const glBalanceBase = gl.closingBalanceBase;

    const repo = this.em(manager).getRepository(InventoryReconciliationRun);

    // --- No valuation source (ADR-040 D3/D10) --------------------------------
    if (!this.valuation) {
      const saved = await this.save(repo, {
        input,
        asOfDate,
        subledgerTotalBase: null,
        glBalanceBase,
        driftBase: null,
        status: 'no_valuation_source',
        driftBreakdown: {
          note:
            'No inventory valuation source is registered (INVENTORY_VALUATION_CONTRACT unbound). ' +
            'Inventory reconciliation activates when F08 (Inventory Valuation) provides it. ' +
            'The GL side (the `inventory` control account balance) is shown for reference only — this is NOT a match.',
          glClosingBalanceBase: glBalanceBase,
          glLineCount: gl.lines.length,
        },
        actorUserId,
      }, manager);
      await this.recordAudit(actorUserId, saved, { asOfDate, glBalanceBase, status: 'no_valuation_source' }, manager);
      return saved;
    }

    // --- Valuation source present (future F08) -------------------------------
    const rawValued = await this.valuation.getValuedOnHandTotal(asOfDate, manager);
    // Month-End dependency (independent review, Phase 1) — exclude every Manufacturing WIP
    // sub-warehouse from THIS reconciliation's own sum; `WipReconciliationService` covers that
    // slice against the `wip` GL account separately. See the constructor's `manufacturingWip`
    // doc comment for why this must be a split, never a combined/netted comparison.
    let valued = rawValued;
    if (this.manufacturingWip) {
      const wip = await this.manufacturingWip.getAllWipBalances(asOfDate, manager);
      const wipWarehouseIds = new Set(wip.balances.map((b) => b.wipWarehouseId));
      valued = rawValued.filter((w) => !wipWarehouseIds.has(w.warehouseId));
    }
    const subledgerTotalBase = valued.reduce((sum, w) => sum + Number(w.totalValueBase), 0).toFixed(4);
    const [d] = (await this.em(manager).query(`SELECT ($1::numeric(20,4) - $2::numeric(20,4))::numeric(20,4) AS drift`, [
      subledgerTotalBase,
      glBalanceBase,
    ])) as Array<{ drift: string }>;
    const driftBase = d.drift;
    const matched = Number(driftBase) === 0;

    const driftBreakdown: Record<string, unknown> | null = matched
      ? null
      : {
          note:
            'The valued on-hand position and the GL `inventory` account differ. Common causes: a dispatch FinancialEvent REJECTED (never posted); a manual journal on the inventory account (blocked — allowManualJournal=false); a movement type not yet mapped to GL.',
          warehouseBreakdown: valued,
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
    }, manager);
    await this.recordAudit(actorUserId, saved, { asOfDate, subledgerTotalBase, glBalanceBase, driftBase, status: saved.status }, manager);
    return saved;
  }

  async closeRun(id: string, actorUserId: string, manager?: EntityManager): Promise<InventoryReconciliationRun> {
    const run = await this.getRun(id, manager);
    if (run.status === 'closed') return run;
    run.status = 'closed';
    run.closedAt = new Date();
    const saved = await this.em(manager).getRepository(InventoryReconciliationRun).save(run);
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'accounting.inventory.reconciliation_closed',
      resource: 'inventory_reconciliation_run',
      resourceId: id,
      result: 'success',
      correlationId: null,
    }, manager);
    return saved;
  }

  // ---------------------------------------------------------------------------

  private async save(
    repo: ReturnType<DataSource['getRepository']>,
    r: {
      input: InventoryReconcileInput;
      asOfDate: string;
      subledgerTotalBase: string | null;
      glBalanceBase: string;
      driftBase: string | null;
      status: InventoryReconciliationRun['status'];
      driftBreakdown: Record<string, unknown> | null;
      actorUserId: string;
    }, _manager?: EntityManager): Promise<InventoryReconciliationRun> {
    try {
      return (await repo.save(
        repo.create({
          fiscalPeriodId: r.input.fiscalPeriodId ?? null,
          asOfDate: r.asOfDate,
          orgUnitId: r.input.orgUnitId ?? null,
          subledgerTotalBase: r.subledgerTotalBase,
          glBalanceBase: r.glBalanceBase,
          driftBase: r.driftBase,
          status: r.status,
          driftBreakdown: r.driftBreakdown,
          runByUserId: r.actorUserId,
          closedAt: null,
        }),
      )) as InventoryReconciliationRun;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/one_open/i.test(msg) || /duplicate key value/i.test(msg)) {
        throw new ConflictException('An open Inventory reconciliation run already exists for this period/org scope — close it first.');
      }
      throw err;
    }
  }

  private async recordAudit(actorUserId: string, saved: InventoryReconciliationRun, after: Record<string, unknown>, manager?: EntityManager): Promise<void> {
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'accounting.inventory.reconciliation_run',
      resource: 'inventory_reconciliation_run',
      resourceId: saved.id,
      result: 'success',
      correlationId: null,
      after,
    }, manager);
  }
}
