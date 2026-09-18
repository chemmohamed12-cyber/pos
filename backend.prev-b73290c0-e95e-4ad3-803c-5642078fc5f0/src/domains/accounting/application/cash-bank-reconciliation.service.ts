import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CashBankReconciliationRun } from '../infrastructure/cash-bank-reconciliation-run.entity';
import { GLAccount } from '../infrastructure/gl-account.entity';
import { LedgerService } from './ledger.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { FINANCE_TREASURY_CONTRACT, FinanceTreasuryContract } from '../../../foundation/module-registry/contracts/finance.contract';

export interface CashBankReconcileInput {
  treasuryAccountId?: string;
  fiscalPeriodId?: string | null;
  asOfDate?: string;
  orgUnitId?: string | null;
}

/**
 * F06 — Cash & Bank (ADR-038 D1/D9, Blueprint §8). Cash/Bank↔GL
 * reconciliation, per Treasury account. Reads the Treasury operational
 * ledger via `FINANCE_TREASURY_CONTRACT` (never a raw `treasury_*` table),
 * the GL `bank` balance via `LedgerService`. Drift in SQL `NUMERIC`
 * (ADR-035 D4).
 *
 * **Read-only — it never posts a correcting entry.** `driftBase ≠ 0` is a
 * diagnostic; the correction is an approved FA-01 `bank_adjustment` /
 * `unreconciled_write_off` (see `CashBankAdjustmentService`).
 *
 * Unlike F05, F06's reconciliation is **active from day one** — the
 * Treasury ledger (its subledger source) always exists, so there is no
 * `no_subledger_source` state.
 */
@Injectable()
export class CashBankReconciliationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    @Inject(FINANCE_TREASURY_CONTRACT) private readonly treasury: FinanceTreasuryContract,
  ) {}

  async listRuns(filter?: { treasuryAccountId?: string; status?: string; from?: string; to?: string }): Promise<CashBankReconciliationRun[]> {
    const qb = this.dataSource.getRepository(CashBankReconciliationRun).createQueryBuilder('r');
    if (filter?.treasuryAccountId) qb.andWhere('r."treasuryAccountId" = :tid', { tid: filter.treasuryAccountId });
    if (filter?.status) qb.andWhere('r.status = :s', { s: filter.status });
    if (filter?.from) qb.andWhere('r."asOfDate" >= :f', { f: filter.from });
    if (filter?.to) qb.andWhere('r."asOfDate" <= :t', { t: filter.to });
    return qb.orderBy('r."createdAt"', 'DESC').getMany();
  }

  async getRun(id: string): Promise<CashBankReconciliationRun> {
    const run = await this.dataSource.getRepository(CashBankReconciliationRun).findOne({ where: { id } });
    if (!run) throw new NotFoundException(`Cash/Bank reconciliation run "${id}" not found.`);
    return run;
  }

  private async glAccountByCode(code: string): Promise<GLAccount> {
    const acc = await this.dataSource.getRepository(GLAccount).findOne({ where: { code, isActive: true } });
    if (!acc) {
      throw new ConflictException(`GL account "${code}" (mapped from a Treasury account) is missing or inactive in the chart.`);
    }
    return acc;
  }

  /**
   * Reconcile one Treasury account (or every GL-mapped one when
   * `treasuryAccountId` is omitted). Returns the run(s) it created.
   */
  async reconcile(input: CashBankReconcileInput, actorUserId: string): Promise<CashBankReconciliationRun[]> {
    const asOfDate = input.asOfDate ?? new Date().toISOString().slice(0, 10);
    const { balances } = await this.treasury.getAllTreasuryBalances(asOfDate);

    let targets = balances.filter((b) => b.glAccountCode && b.glAccountCode.trim() !== '');
    if (input.treasuryAccountId) {
      targets = targets.filter((b) => b.treasuryAccountId === input.treasuryAccountId);
      if (targets.length === 0) {
        const known = balances.find((b) => b.treasuryAccountId === input.treasuryAccountId);
        if (!known) throw new NotFoundException(`Treasury account "${input.treasuryAccountId}" not found.`);
        throw new ConflictException(`Treasury account "${known.code}" is not GL-mapped — set its glAccountCode before reconciling.`);
      }
    }
    if (targets.length === 0) {
      throw new ConflictException('No GL-mapped Treasury account to reconcile — set glAccountCode on at least one account.');
    }

    const repo = this.dataSource.getRepository(CashBankReconciliationRun);
    const runs: CashBankReconciliationRun[] = [];

    for (const b of targets) {
      const glCode = b.glAccountCode!;
      const gl = await this.glAccountByCode(glCode);
      const glLedger = await this.ledger.getAccountLedger(gl.id, { to: asOfDate, orgUnitId: input.orgUnitId ?? undefined });
      const glBalanceBase = glLedger.closingBalanceBase;
      const subledgerTotalBase = b.balance;

      const [d] = (await this.dataSource.query(`SELECT ($1::numeric(20,4) - $2::numeric(20,4))::numeric(20,4) AS drift`, [
        subledgerTotalBase,
        glBalanceBase,
      ])) as Array<{ drift: string }>;
      const driftBase = d.drift;
      const matched = Number(driftBase) === 0;

      const driftBreakdown: Record<string, unknown> | null = matched
        ? null
        : {
            note:
              'The Treasury operational ledger and the GL `bank` account differ. Common causes: an un-GL-mapped movement on a sibling account; a Treasury movement whose GL event was REJECTED (see Financial Events); a deposit/COD cash leg not yet posted to GL (owned by F09); a bank charge/fee not yet recorded; a manual journal on the `bank` account (blocked — allowManualJournal=false).',
            treasuryAccountId: b.treasuryAccountId,
            treasuryAccountCode: b.code,
            glAccountCode: glCode,
            treasuryLedgerTotalBase: subledgerTotalBase,
            glClosingBalanceBase: glBalanceBase,
            glLineCount: glLedger.lines.length,
          };

      const saved = await this.save(repo, {
        input,
        treasuryAccountId: b.treasuryAccountId,
        glAccountCode: glCode,
        asOfDate,
        subledgerTotalBase,
        glBalanceBase,
        driftBase,
        status: matched ? 'matched' : 'drift_found',
        driftBreakdown,
        actorUserId,
      });
      await this.audit.record({
        actorUserId,
        organizationId: null,
        action: 'accounting.cash.reconciliation_run',
        resource: 'cash_bank_reconciliation_run',
        resourceId: saved.id,
        result: 'success',
        correlationId: null,
        after: { treasuryAccountId: b.treasuryAccountId, glAccountCode: glCode, asOfDate, subledgerTotalBase, glBalanceBase, driftBase, status: saved.status },
      });
      runs.push(saved);
    }
    return runs;
  }

  async closeRun(id: string, actorUserId: string): Promise<CashBankReconciliationRun> {
    const run = await this.getRun(id);
    if (run.status === 'closed') return run;
    run.status = 'closed';
    run.closedAt = new Date();
    const saved = await this.dataSource.getRepository(CashBankReconciliationRun).save(run);
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'accounting.cash.reconciliation_closed',
      resource: 'cash_bank_reconciliation_run',
      resourceId: id,
      result: 'success',
      correlationId: null,
    });
    return saved;
  }

  /**
   * A per-GL-account roll-up of the latest run per Treasury account
   * (ADR-038 D9) — several Treasury accounts may map to one GL account.
   */
  async rollup(): Promise<Array<{ glAccountCode: string; treasuryLedgerTotalBase: string; glBalanceBase: string; driftBase: string; accountCount: number }>> {
    const rows = (await this.dataSource.query(
      `WITH latest AS (
         SELECT DISTINCT ON ("treasuryAccountId") "treasuryAccountId", "glAccountCode", "subledgerTotalBase", "glBalanceBase"
           FROM "accounting_cash_bank_reconciliation_runs"
          ORDER BY "treasuryAccountId", "createdAt" DESC
       )
       SELECT "glAccountCode",
              SUM("subledgerTotalBase")::numeric(20,4) AS "treasuryLedgerTotalBase",
              MAX("glBalanceBase")::numeric(20,4)      AS "glBalanceBase",
              (SUM("subledgerTotalBase") - MAX("glBalanceBase"))::numeric(20,4) AS "driftBase",
              COUNT(*)::int AS "accountCount"
         FROM latest
        GROUP BY "glAccountCode"
        ORDER BY "glAccountCode"`,
    )) as Array<{ glAccountCode: string; treasuryLedgerTotalBase: string; glBalanceBase: string; driftBase: string; accountCount: number }>;
    return rows;
  }

  /**
   * F06's Cash/Bank position statement for one Treasury account: the GL
   * `bank` account movement + the Treasury operational ledger, side by side.
   */
  async cashBankPositionStatement(input: { treasuryAccountId: string; from?: string; to?: string }): Promise<{
    treasuryAccountId: string;
    glAccountCode: string | null;
    glLedger: unknown | null;
    treasuryLedger: unknown[];
  }> {
    const { balances } = await this.treasury.getAllTreasuryBalances(input.to);
    const acc = balances.find((b) => b.treasuryAccountId === input.treasuryAccountId);
    if (!acc) throw new NotFoundException(`Treasury account "${input.treasuryAccountId}" not found.`);
    const treasuryLedger = await this.treasury.listTreasuryLedger(input.treasuryAccountId, { from: input.from, to: input.to });
    let glLedger: unknown | null = null;
    if (acc.glAccountCode) {
      const gl = await this.glAccountByCode(acc.glAccountCode);
      glLedger = await this.ledger.getAccountLedger(gl.id, { from: input.from, to: input.to });
    }
    return { treasuryAccountId: input.treasuryAccountId, glAccountCode: acc.glAccountCode, glLedger, treasuryLedger };
  }

  // ---------------------------------------------------------------------------

  private async save(
    repo: ReturnType<DataSource['getRepository']>,
    r: {
      input: CashBankReconcileInput;
      treasuryAccountId: string;
      glAccountCode: string;
      asOfDate: string;
      subledgerTotalBase: string;
      glBalanceBase: string;
      driftBase: string;
      status: CashBankReconciliationRun['status'];
      driftBreakdown: Record<string, unknown> | null;
      actorUserId: string;
    },
  ): Promise<CashBankReconciliationRun> {
    try {
      return (await repo.save(
        repo.create({
          treasuryAccountId: r.treasuryAccountId,
          glAccountCode: r.glAccountCode,
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
      )) as CashBankReconciliationRun;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/one_open/i.test(msg) || /duplicate key value/i.test(msg)) {
        throw new ConflictException('An open Cash/Bank reconciliation run already exists for this account/period/org scope — close it first.');
      }
      throw err;
    }
  }
}
