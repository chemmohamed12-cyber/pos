import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { utcBusinessDate } from '../../../foundation/localization/business-date';
import { DataSource, EntityManager } from 'typeorm';
import { ArReconciliationRun } from '../infrastructure/ar-reconciliation-run.entity';
import { GLAccount } from '../infrastructure/gl-account.entity';
import { LedgerService } from './ledger.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import {
  FINANCE_CUSTOMER_LEDGER_CONTRACT,
  FinanceCustomerLedgerContract,
} from '../../../foundation/module-registry/contracts/finance.contract';

export interface ReconcileInput {
  fiscalPeriodId?: string | null;
  asOfDate?: string;
  orgUnitId?: string | null;
}

/**
 * F04 — Accounts Receivable (ADR-036 D2, Blueprint §11). AR↔GL
 * reconciliation: Σ `customer-finance` subledger (read via
 * `FINANCE_CUSTOMER_LEDGER_CONTRACT.getAllCustomerBalances` — never a raw
 * table read) vs the `ar` control account's GL balance
 * (`LedgerService.getAccountLedger`). **Read-only** — it never posts a
 * correcting entry (Decision D-08); it flags, and an accountant posts an
 * approved adjustment via `ArAdjustmentService`. All arithmetic is SQL
 * `NUMERIC` (ADR-035 D4).
 */
@Injectable()
export class ArReconciliationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    @Inject(FINANCE_CUSTOMER_LEDGER_CONTRACT) private readonly customerLedger: FinanceCustomerLedgerContract,
  ) {}

  private em(manager?: EntityManager): EntityManager {
    return manager ?? this.dataSource.manager;
  }

  async listRuns(filter?: { status?: string; from?: string; to?: string }, manager?: EntityManager): Promise<ArReconciliationRun[]> {
    const qb = this.em(manager).getRepository(ArReconciliationRun).createQueryBuilder('r');
    if (filter?.status) qb.andWhere('r.status = :s', { s: filter.status });
    if (filter?.from) qb.andWhere('r."asOfDate" >= :f', { f: filter.from });
    if (filter?.to) qb.andWhere('r."asOfDate" <= :t', { t: filter.to });
    return qb.orderBy('r."createdAt"', 'DESC').getMany();
  }

  async getRun(id: string, manager?: EntityManager): Promise<ArReconciliationRun> {
    const run = await this.em(manager).getRepository(ArReconciliationRun).findOne({ where: { id } });
    if (!run) throw new NotFoundException(`AR reconciliation run "${id}" not found.`);
    return run;
  }

  private async arAccount(manager?: EntityManager): Promise<GLAccount> {
    const acc = await this.em(manager).getRepository(GLAccount).findOne({ where: { controlFunction: 'ar', isActive: true } });
    if (!acc) throw new ConflictException('No active `ar` control account in the chart of accounts — assign controlFunction "ar" to an account first.');
    return acc;
  }

  async reconcile(input: ReconcileInput, actorUserId: string, manager?: EntityManager): Promise<ArReconciliationRun> {
    const asOfDate = input.asOfDate ?? utcBusinessDate();
    const ar = await this.arAccount(manager);

    // subledger side (read contract, no raw table access — ADR-036 D11)
    const sub = await this.customerLedger.getAllCustomerBalances(asOfDate, manager);
    const subledgerTotalBase = sub.total;

    // GL side — the `ar` control account's closing balance as of the date
    const gl = await this.ledger.getAccountLedger(ar.id, { to: asOfDate, orgUnitId: input.orgUnitId ?? undefined }, manager);
    const glBalanceBase = gl.closingBalanceBase;

    // drift in SQL NUMERIC (never JS float)
    const [d] = (await this.em(manager).query(`SELECT ($1::numeric(20,4) - $2::numeric(20,4))::numeric(20,4) AS drift`, [
      subledgerTotalBase,
      glBalanceBase,
    ])) as Array<{ drift: string }>;
    const driftBase = d.drift;
    const matched = Number(driftBase) === 0;

    let driftBreakdown: Record<string, unknown> | null = null;
    if (!matched) {
      // per-customer subledger balances that likely have no matching journal (diagnostic only)
      driftBreakdown = {
        note: 'Subledger and GL differ. Common causes: an AR FinancialEvent REJECTED by the handler (never posted); the finance publishers not yet wired (F04-H1); a currency mismatch; a manual journal on the ar account (blocked — allowManualJournal=false).',
        subledgerCustomerCount: sub.balances.length,
        subledgerBalances: sub.balances.slice(0, 200),
        glClosingBalanceBase: glBalanceBase,
        glLineCount: gl.lines.length,
      };
    }

    const repo = this.em(manager).getRepository(ArReconciliationRun);
    let saved: ArReconciliationRun;
    try {
      saved = await repo.save(
        repo.create({
          fiscalPeriodId: input.fiscalPeriodId ?? null,
          asOfDate,
          orgUnitId: input.orgUnitId ?? null,
          subledgerTotalBase,
          glBalanceBase,
          driftBase,
          status: matched ? 'matched' : 'drift_found',
          driftBreakdown,
          runByUserId: actorUserId,
          closedAt: null,
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/one_open/i.test(msg) || /duplicate key value/i.test(msg)) {
        throw new ConflictException('An open AR reconciliation run already exists for this period/org scope — close it first.');
      }
      throw err;
    }

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'accounting.ar.reconciliation_run',
      resource: 'ar_reconciliation_run',
      resourceId: saved.id,
      result: 'success',
      correlationId: null,
      after: { asOfDate, subledgerTotalBase, glBalanceBase, driftBase, status: saved.status },
    }, manager);
    return saved;
  }

  async closeRun(id: string, actorUserId: string, manager?: EntityManager): Promise<ArReconciliationRun> {
    const run = await this.getRun(id, manager);
    if (run.status === 'closed') return run;
    run.status = 'closed';
    run.closedAt = new Date();
    const saved = await this.em(manager).getRepository(ArReconciliationRun).save(run);
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'accounting.ar.reconciliation_closed',
      resource: 'ar_reconciliation_run',
      resourceId: id,
      result: 'success',
      correlationId: null,
    }, manager);
    return saved;
  }

  /** F04's accounting/reconciliation customer statement (Decision D-12): the subledger ledger + the GL ar-account movement side-by-side. */
  async customerStatement(customerId: string, filter?: { from?: string; to?: string }, manager?: EntityManager): Promise<{
    customerId: string;
    subledger: unknown[];
    creditSummary: { balance: string; creditLimit: string | null; availableCredit: string | null; overdueAmount: string };
  }> {
    const subledger = await this.customerLedger.listLedger(customerId, { from: filter?.from, to: filter?.to }, manager);
    const creditSummary = await this.customerLedger.getCreditSummary(customerId, manager);
    return { customerId, subledger, creditSummary };
  }
}
