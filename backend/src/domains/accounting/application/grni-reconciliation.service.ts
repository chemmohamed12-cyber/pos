import { ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { GrniReconciliationRun } from '../infrastructure/grni-reconciliation-run.entity';
import { GLAccount } from '../infrastructure/gl-account.entity';
import { LedgerService } from './ledger.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { GRNI_LEDGER_CONTRACT, GrniLedgerContract } from '../../../foundation/module-registry/contracts/grni-events.contract';

export interface GrniReconcileInput {
  fiscalPeriodId?: string | null;
  asOfDate?: string;
  orgUnitId?: string | null;
}

/**
 * ADR-054/ADR-056 (Month-End Closing, Phase 8). GRNI↔GL reconciliation —
 * the sixth type Month-End Closing must verify (ADR-056 Decision). Mirrors
 * `ApReconciliationService` exactly, including its dormant/`@Optional()`
 * shape, because the underlying situation is identical: no operational
 * source exists yet.
 *
 *   - contract UNBOUND (today, confirmed by direct search — no GRNI
 *     posting logic exists anywhere in this codebase): every run records
 *     `no_subledger_source` and shows the GL side (the `grni` control
 *     account balance) for reference only — **NEVER `matched`**;
 *   - contract BOUND (future, once Procurement implements ADR-054's
 *     posting logic): identical to `ApReconciliationService`'s bound
 *     branch — Σ outstanding goods-receipt balances (via the contract,
 *     never a raw table read) vs the `grni` GL balance, `matched |
 *     drift_found`, with per-receipt traceability preserved in
 *     `driftBreakdown` for ADR-054 item 4's provenance requirement.
 *
 * Read-only — it never posts a correcting entry. All arithmetic SQL
 * `NUMERIC` (ADR-035 D4), same discipline as the other five reconciliation
 * services.
 */
@Injectable()
export class GrniReconciliationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    @Optional() @Inject(GRNI_LEDGER_CONTRACT) private readonly grniLedger?: GrniLedgerContract,
  ) {}

  async listRuns(filter?: { status?: string; from?: string; to?: string }): Promise<GrniReconciliationRun[]> {
    const qb = this.dataSource.getRepository(GrniReconciliationRun).createQueryBuilder('r');
    if (filter?.status) qb.andWhere('r.status = :s', { s: filter.status });
    if (filter?.from) qb.andWhere('r."asOfDate" >= :f', { f: filter.from });
    if (filter?.to) qb.andWhere('r."asOfDate" <= :t', { t: filter.to });
    return qb.orderBy('r."createdAt"', 'DESC').getMany();
  }

  async getRun(id: string): Promise<GrniReconciliationRun> {
    const run = await this.dataSource.getRepository(GrniReconciliationRun).findOne({ where: { id } });
    if (!run) throw new NotFoundException(`GRNI reconciliation run "${id}" not found.`);
    return run;
  }

  private async grniAccount(): Promise<GLAccount | null> {
    return this.dataSource.getRepository(GLAccount).findOne({ where: { controlFunction: 'grni', isActive: true } });
  }

  /**
   * ADR-056 — "without silently altering the behavior... of the five
   * already frozen": a chart of accounts with no `grni` control account
   * configured yet is the EXPECTED state for every installation today
   * (GRNI is brand new) and must never throw and abort the whole Closing
   * Audit — it is reported exactly like the missing-contract case below
   * (`no_subledger_source`), not surfaced as a `ConflictException` the way
   * a genuinely misconfigured existing control account (AR/AP/etc.) is.
   * Confirmed live: before this fix, a fresh chart with no `grni` account
   * made `ClosingAuditService.run()` throw entirely, breaking the other
   * five reconciliation types' already-verified results.
   */
  async reconcile(input: GrniReconcileInput, actorUserId: string): Promise<GrniReconciliationRun> {
    const asOfDate = input.asOfDate ?? new Date().toISOString().slice(0, 10);
    const grni = await this.grniAccount();
    const repo = this.dataSource.getRepository(GrniReconciliationRun);

    if (!grni) {
      const saved = await this.save(repo, {
        input,
        asOfDate,
        subledgerTotalBase: null,
        glBalanceBase: '0.0000',
        driftBase: null,
        status: 'no_subledger_source',
        driftBreakdown: {
          note:
            'No active `grni` control account exists in the chart of accounts yet — assign controlFunction "grni" to an account to activate this check. ' +
            'Expected for every installation until GRNI accounts are configured (ADR-054/ADR-056).',
        },
        actorUserId,
      });
      await this.recordAudit(actorUserId, saved, { asOfDate, status: 'no_subledger_source', reason: 'no_grni_account_configured' });
      return saved;
    }

    const gl = await this.ledger.getAccountLedger(grni.id, { to: asOfDate, orgUnitId: input.orgUnitId ?? undefined });
    const glBalanceBase = gl.closingBalanceBase;

    if (!this.grniLedger) {
      const saved = await this.save(repo, {
        input,
        asOfDate,
        subledgerTotalBase: null,
        glBalanceBase,
        driftBase: null,
        status: 'no_subledger_source',
        driftBreakdown: {
          note:
            'No operational GRNI ledger source is registered (GRNI_LEDGER_CONTRACT unbound). ' +
            'GRNI reconciliation activates when the Procurement-side GRNI posting phase (ADR-054) provides it. ' +
            'The GL side (the `grni` control account balance) is shown for reference only — this is NOT a match.',
          glClosingBalanceBase: glBalanceBase,
          glLineCount: gl.lines.length,
        },
        actorUserId,
      });
      await this.recordAudit(actorUserId, saved, { asOfDate, glBalanceBase, status: 'no_subledger_source' });
      return saved;
    }

    const sub = await this.grniLedger.getAllGrniBalances(asOfDate);
    const subledgerTotalBase = sub.total;
    // GRNI is a credit-normal control account (ADR-054) — `getAllGrniBalances` reports a positive
    // outstanding balance, but `closingBalanceBase` is unconditionally `Σdebit − Σcredit` (negative
    // for a normal credit balance). Normalize by the account's own `normalBalance` before diffing —
    // see the identical, previously-latent bug fixed in `ApReconciliationService` (ADR-057).
    const sign = gl.account.normalBalance === 'credit' ? '-1' : '1';
    const [d] = (await this.dataSource.query(
      `SELECT ($1::numeric(20,4) - ($2::numeric(20,4) * $3::numeric(20,4)))::numeric(20,4) AS drift`,
      [subledgerTotalBase, glBalanceBase, sign],
    )) as Array<{ drift: string }>;
    const driftBase = d.drift;
    const matched = Number(driftBase) === 0;

    let driftBreakdown: Record<string, unknown> | null = null;
    if (!matched) {
      driftBreakdown = {
        note: 'Outstanding GRNI balances and GL differ. Common causes: a GRNI FinancialEvent REJECTED by the handler (never posted); a receipt whose invoice matching is incomplete; a manual journal on the grni account (blocked — allowManualJournal=false).',
        subledgerReceiptCount: sub.balances.length,
        // ADR-054 item 4 — traceability back to the originating receipt(s) preserved directly in the exception evidence.
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

  async closeRun(id: string, actorUserId: string): Promise<GrniReconciliationRun> {
    const run = await this.getRun(id);
    if (run.status === 'closed') return run;
    run.status = 'closed';
    run.closedAt = new Date();
    const saved = await this.dataSource.getRepository(GrniReconciliationRun).save(run);
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'accounting.grni_reconciliation.closed',
      resource: 'grni_reconciliation_run',
      resourceId: id,
      result: 'success',
      correlationId: null,
    });
    return saved;
  }

  private async save(
    repo: ReturnType<DataSource['getRepository']>,
    data: {
      input: GrniReconcileInput;
      asOfDate: string;
      subledgerTotalBase: string | null;
      glBalanceBase: string;
      driftBase: string | null;
      status: GrniReconciliationRun['status'];
      driftBreakdown: Record<string, unknown> | null;
      actorUserId: string;
    },
  ): Promise<GrniReconciliationRun> {
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
      )) as GrniReconciliationRun;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/one_open/i.test(msg) || /duplicate key value/i.test(msg)) {
        throw new ConflictException('An open GRNI reconciliation run already exists for this period/org scope — close it first.');
      }
      throw err;
    }
  }

  private async recordAudit(actorUserId: string, saved: GrniReconciliationRun, after: Record<string, unknown>): Promise<void> {
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'accounting.grni_reconciliation.run',
      resource: 'grni_reconciliation_run',
      resourceId: saved.id,
      result: 'success',
      correlationId: null,
      after,
    });
  }
}
