import { ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { utcBusinessDate } from '../../../foundation/localization/business-date';
import { DataSource, EntityManager } from 'typeorm';
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

  private em(manager?: EntityManager): EntityManager {
    return manager ?? this.dataSource.manager;
  }

  async listRuns(filter?: { status?: string; from?: string; to?: string }, manager?: EntityManager): Promise<ApReconciliationRun[]> {
    const qb = this.em(manager).getRepository(ApReconciliationRun).createQueryBuilder('r');
    if (filter?.status) qb.andWhere('r.status = :s', { s: filter.status });
    if (filter?.from) qb.andWhere('r."asOfDate" >= :f', { f: filter.from });
    if (filter?.to) qb.andWhere('r."asOfDate" <= :t', { t: filter.to });
    return qb.orderBy('r."createdAt"', 'DESC').getMany();
  }

  async getRun(id: string, manager?: EntityManager): Promise<ApReconciliationRun> {
    const run = await this.em(manager).getRepository(ApReconciliationRun).findOne({ where: { id } });
    if (!run) throw new NotFoundException(`AP reconciliation run "${id}" not found.`);
    return run;
  }

  private async apAccount(manager?: EntityManager): Promise<GLAccount> {
    const acc = await this.em(manager).getRepository(GLAccount).findOne({ where: { controlFunction: 'ap', isActive: true } });
    if (!acc) throw new ConflictException('No active `ap` control account in the chart of accounts — assign controlFunction "ap" to an account first.');
    return acc;
  }

  async reconcile(input: ApReconcileInput, actorUserId: string, manager?: EntityManager): Promise<ApReconciliationRun> {
    const asOfDate = input.asOfDate ?? utcBusinessDate();
    const ap = await this.apAccount(manager);

    // GL side — always computed
    const gl = await this.ledger.getAccountLedger(ap.id, { to: asOfDate, orgUnitId: input.orgUnitId ?? undefined }, manager);
    const glBalanceBase = gl.closingBalanceBase;

    const repo = this.em(manager).getRepository(ApReconciliationRun);

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
      }, manager);
      await this.recordAudit(actorUserId, saved, { asOfDate, glBalanceBase, status: 'no_subledger_source' }, manager);
      return saved;
    }

    // --- Supplier-ledger source present (future OP-AP) --------------------
    const sub = await this.supplierLedger.getAllSupplierBalances(asOfDate, manager);
    const subledgerTotalBase = sub.total;
    // BUG FIX (surfaced while building GRNI reconciliation, ADR-057): `getAllSupplierBalances`
    // reports a positive balance when AP is credit-increased (correct — a payable is a credit-normal
    // liability), but `LedgerService.getAccountLedger.closingBalanceBase` is UNCONDITIONALLY
    // `Σdebit − Σcredit`, which is NEGATIVE for a normal, matched credit-normal balance. Comparing
    // the two directly without normalizing by the account's own `normalBalance` manufactured a
    // permanent, ~2x-magnitude phantom drift for any non-zero AP balance — masked until now only
    // because earlier checks this session happened to run while AP's net balance was near zero.
    // AR/Cash-Bank/Inventory are unaffected (debit-normal, their subledger conventions already
    // align with `closingBalanceBase`'s sign) — this fix is scoped to credit-normal accounts only.
    const sign = gl.account.normalBalance === 'credit' ? '-1' : '1';
    const [d] = (await this.em(manager).query(
      `SELECT ($1::numeric(20,4) - ($2::numeric(20,4) * $3::numeric(20,4)))::numeric(20,4) AS drift`,
      [subledgerTotalBase, glBalanceBase, sign],
    )) as Array<{ drift: string }>;
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
    }, manager);
    await this.recordAudit(actorUserId, saved, { asOfDate, subledgerTotalBase, glBalanceBase, driftBase, status: saved.status }, manager);
    return saved;
  }

  async closeRun(id: string, actorUserId: string, manager?: EntityManager): Promise<ApReconciliationRun> {
    const run = await this.getRun(id, manager);
    if (run.status === 'closed') return run;
    run.status = 'closed';
    run.closedAt = new Date();
    const saved = await this.em(manager).getRepository(ApReconciliationRun).save(run);
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'accounting.ap.reconciliation_closed',
      resource: 'ap_reconciliation_run',
      resourceId: id,
      result: 'success',
      correlationId: null,
    }, manager);
    return saved;
  }

  /**
   * F05's accounting AP-position statement. V1: the `ap` control-account
   * GL movement (the AP position). The supplier-level subledger statement
   * activates with the OP-AP phase.
   */
  async apStatement(filter?: { from?: string; to?: string; orgUnitId?: string | null }, manager?: EntityManager): Promise<{
    apAccountCode: string;
    ledger: unknown;
    supplierSubledger: unknown[] | null;
  }> {
    const ap = await this.apAccount(manager);
    const ledger = await this.ledger.getAccountLedger(ap.id, {
      from: filter?.from,
      to: filter?.to,
      orgUnitId: filter?.orgUnitId ?? undefined,
    }, manager);
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
    }, manager?: EntityManager): Promise<ApReconciliationRun> {
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

  private async recordAudit(actorUserId: string, saved: ApReconciliationRun, after: Record<string, unknown>, manager?: EntityManager): Promise<void> {
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'accounting.ap.reconciliation_run',
      resource: 'ap_reconciliation_run',
      resourceId: saved.id,
      result: 'success',
      correlationId: null,
      after,
    }, manager);
  }
}
