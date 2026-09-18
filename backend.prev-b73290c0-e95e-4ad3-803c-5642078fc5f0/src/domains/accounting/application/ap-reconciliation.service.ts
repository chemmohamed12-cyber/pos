import { ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ApReconciliationRun } from '../infrastructure/ap-reconciliation-run.entity';
import { GLAccount } from '../infrastructure/gl-account.entity';
import { LedgerService } from './ledger.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { SUPPLIER_LEDGER_CONTRACT, SupplierLedgerContract } from '../../../foundation/module-registry/contracts/ap-events.contract';

export interface ApReconcileInput {
  fiscalPeriodId?: string | null;
  asOfDate?: string;
  orgUnitId?: string | null;
}

/**
 * F05 — Accounts Payable (ADR-037 D2, Blueprint §8). AP↔GL reconciliation.
 * The mirror of `ArReconciliationService`, **guarded/inactive** until a
 * `SUPPLIER_LEDGER_CONTRACT` implementation is provided by the future
 * OP-AP domain:
 *   - contract UNBOUND (today): every run records `no_subledger_source`
 *     and the GL side (the `ap` control account balance) only — NEVER
 *     `matched` (CTO decision, ADR-037 D4);
 *   - contract BOUND (future): identical to `ArReconciliationService` —
 *     Σ supplier balances (via the contract, never a raw table read) vs
 *     the `ap` GL balance, `matched | drift_found`.
 *
 * Read-only — it never posts a correcting entry. All arithmetic SQL
 * `NUMERIC` (ADR-035 D4).
 */
@Injectable()
export class ApReconciliationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    @Optional() @Inject(SUPPLIER_LEDGER_CONTRACT) private readonly supplierLedger?: SupplierLedgerContract,
  ) {}

  async listRuns(filter?: { status?: string; from?: string; to?: string }): Promise<ApReconciliationRun[]> {
    const qb = this.dataSource.getRepository(ApReconciliationRun).createQueryBuilder('r');
    if (filter?.status) qb.andWhere('r.status = :s', { s: filter.status });
    if (filter?.from) qb.andWhere('r."asOfDate" >= :f', { f: filter.from });
    if (filter?.to) qb.andWhere('r."asOfDate" <= :t', { t: filter.to });
    return qb.orderBy('r."createdAt"', 'DESC').getMany();
  }

  async getRun(id: string): Promise<ApReconciliationRun> {
    const run = await this.dataSource.getRepository(ApReconciliationRun).findOne({ where: { id } });
    if (!run) throw new NotFoundException(`AP reconciliation run "${id}" not found.`);
    return run;
  }

  private async apAccount(): Promise<GLAccount> {
    const acc = await this.dataSource.getRepository(GLAccount).findOne({ where: { controlFunction: 'ap', isActive: true } });
    if (!acc) throw new ConflictException('No active `ap` control account in the chart of accounts — assign controlFunction "ap" to an account first.');
    return acc;
  }

  async reconcile(input: ApReconcileInput, actorUserId: string): Promise<ApReconciliationRun> {
    const asOfDate = input.asOfDate ?? new Date().toISOString().slice(0, 10);
    const ap = await this.apAccount();

    // GL side — always computed
    const gl = await this.ledger.getAccountLedger(ap.id, { to: asOfDate, orgUnitId: input.orgUnitId ?? undefined });
    const glBalanceBase = gl.closingBalanceBase;

    const repo = this.dataSource.getRepository(ApReconciliationRun);

    // --- No supplier-ledger source (ADR-037 D2/D4) --------------------------
    if (!this.supplierLedger) {
      const saved = await this.save(repo, {
        input,
        asOfDate,
        subledgerTotalBase: null,
        glBalanceBase,
        driftBase: null,
        status: 'no_subledger_source',
        driftBreakdown: {
          note:
            'No operational supplier-ledger source is registered (SUPPLIER_LEDGER_CONTRACT unbound). ' +
            'AP reconciliation activates when the operational supplier-finance (OP-AP) phase provides it. ' +
            'The GL side (the `ap` control account balance) is shown for reference only — this is NOT a match.',
          glClosingBalanceBase: glBalanceBase,
          glLineCount: gl.lines.length,
        },
        actorUserId,
      });
      await this.recordAudit(actorUserId, saved, { asOfDate, glBalanceBase, status: 'no_subledger_source' });
      return saved;
    }

    // --- Supplier-ledger source present (future OP-AP) --------------------
    const sub = await this.supplierLedger.getAllSupplierBalances(asOfDate);
    const subledgerTotalBase = sub.total;
    const [d] = (await this.dataSource.query(`SELECT ($1::numeric(20,4) - $2::numeric(20,4))::numeric(20,4) AS drift`, [
      subledgerTotalBase,
      glBalanceBase,
    ])) as Array<{ drift: string }>;
    const driftBase = d.drift;
    const matched = Number(driftBase) === 0;

    let driftBreakdown: Record<string, unknown> | null = null;
    if (!matched) {
      driftBreakdown = {
        note: 'Supplier subledger and GL differ. Common causes: an AP FinancialEvent REJECTED by the handler (never posted); a currency mismatch; a manual journal on the ap account (blocked — allowManualJournal=false).',
        subledgerSupplierCount: sub.balances.length,
        subledgerBalances: sub.balances.slice(0, 200),
        glClosingBalanceBase: glBalanceBase,
        glLineCount: gl.lines.length,
      };
    }

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
    await this.recordAudit(actorUserId, saved, { asOfDate, subledgerTotalBase, glBalanceBase, driftBase, status: saved.status });
    return saved;
  }

  async closeRun(id: string, actorUserId: string): Promise<ApReconciliationRun> {
    const run = await this.getRun(id);
    if (run.status === 'closed') return run;
    run.status = 'closed';
    run.closedAt = new Date();
    const saved = await this.dataSource.getRepository(ApReconciliationRun).save(run);
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'accounting.ap.reconciliation_closed',
      resource: 'ap_reconciliation_run',
      resourceId: id,
      result: 'success',
      correlationId: null,
    });
    return saved;
  }

  /**
   * F05's accounting AP-position statement. V1: the `ap` control-account
   * GL movement (the AP position). The supplier-level subledger statement
   * activates with the OP-AP phase.
   */
  async apStatement(filter?: { from?: string; to?: string; orgUnitId?: string | null }): Promise<{
    apAccountCode: string;
    ledger: unknown;
    supplierSubledger: unknown[] | null;
  }> {
    const ap = await this.apAccount();
    const ledger = await this.ledger.getAccountLedger(ap.id, {
      from: filter?.from,
      to: filter?.to,
      orgUnitId: filter?.orgUnitId ?? undefined,
    });
    return { apAccountCode: ap.code, ledger, supplierSubledger: null };
  }

  // ---------------------------------------------------------------------------

  private async save(
    repo: ReturnType<DataSource['getRepository']>,
    r: {
      input: ApReconcileInput;
      asOfDate: string;
      subledgerTotalBase: string | null;
      glBalanceBase: string;
      driftBase: string | null;
      status: ApReconciliationRun['status'];
      driftBreakdown: Record<string, unknown> | null;
      actorUserId: string;
    },
  ): Promise<ApReconciliationRun> {
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
      )) as ApReconciliationRun;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/one_open/i.test(msg) || /duplicate key value/i.test(msg)) {
        throw new ConflictException('An open AP reconciliation run already exists for this period/org scope — close it first.');
      }
      throw err;
    }
  }

  private async recordAudit(actorUserId: string, saved: ApReconciliationRun, after: Record<string, unknown>): Promise<void> {
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'accounting.ap.reconciliation_run',
      resource: 'ap_reconciliation_run',
      resourceId: saved.id,
      result: 'success',
      correlationId: null,
      after,
    });
  }
}
