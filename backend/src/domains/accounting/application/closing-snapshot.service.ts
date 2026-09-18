import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Between, DataSource, EntityManager } from 'typeorm';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import { createHash } from 'crypto';
import { ClosingSnapshotRun } from '../infrastructure/closing-snapshot-run.entity';
import { ClosingException } from '../infrastructure/closing-exception.entity';
import { FiscalPeriod } from '../infrastructure/fiscal-period.entity';
import { FiscalYear } from '../infrastructure/fiscal-year.entity';
import { FinancialEvent } from '../infrastructure/financial-event.entity';
import { LedgerService } from './ledger.service';
import { ClosingSnapshotSigningKeyService } from './closing-snapshot-signing-key.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { AppConfigService } from '../../../foundation/configuration/app-config.service';
import { canonicalizeJson } from '../../../foundation/crypto/canonical-json';
import { readAppVersion } from '../../../foundation/release/app-version';
import { FINANCE_CUSTOMER_LEDGER_CONTRACT, FinanceCustomerLedgerContract, FINANCE_TREASURY_CONTRACT, FinanceTreasuryContract } from '../../../foundation/module-registry/contracts/finance.contract';
import { SUPPLIER_LEDGER_CONTRACT, SupplierLedgerContract } from '../../../foundation/module-registry/contracts/ap-events.contract';
import { INVENTORY_VALUATION_CONTRACT, InventoryValuationContract } from '../../../foundation/module-registry/contracts/inventory-events.contract';

const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000'; // matches this codebase's existing convention (FiscalPeriodService et al.)

export interface ClosingSnapshotManifest {
  manifestVersion: '1.0';
  fiscalPeriodId: string;
  periodCode: string;
  closeSequence: number;
  supersedesSnapshotId: string | null;
  previousManifestHash: string | null;
  generatedAt: string;
  generatedByUserId: string;
  approvalRequestId: string;
  appVersion: string;
  migrationHead: string | null;
  configVersion: string;
  contentHash: string;
  signingKeyId?: string;
  signature?: string;
}

export interface ClosingSnapshotVerifyResult {
  ok: boolean;
  contentHashMatches: boolean;
  signatureValid: boolean;
  chainValid: boolean | null; // null when this snapshot has no predecessor (nothing to chain-check)
  reason?: string;
}

/**
 * ADR-051 §4/§8/§12 (Month-End Closing / Black Box, Phase 5). Builds the
 * Immutable Monthly Accounting Snapshot from data every figure of which is
 * read from an ALREADY-existing, already-tested source (`LedgerService`,
 * the same operational-ledger contracts the reconciliation services
 * themselves read) — introduces no new accounting arithmetic.
 *
 * Two-step lifecycle mirrors the Transactional Outbox pattern
 * (`EventBusService`) already used throughout this codebase (ADR-051
 * §12): `beginPending` writes a `'pending'` row inside the SAME
 * transaction that applies the approved close/reclose transition (file I/O
 * cannot safely share that transaction); `assembleAndFinalize` does the
 * actual assembly/canonicalize/hash/sign/write immediately after, and is
 * safely re-callable by a recovery sweep if it fails partway (a `'pending'`
 * row is never treated as evidence of anything — only `'complete'` is).
 */
@Injectable()
export class ClosingSnapshotService {
  private readonly logger = new Logger(ClosingSnapshotService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly ledger: LedgerService,
    private readonly signingKeys: ClosingSnapshotSigningKeyService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
    @Inject(FINANCE_CUSTOMER_LEDGER_CONTRACT) private readonly customerLedger: FinanceCustomerLedgerContract,
    @Inject(FINANCE_TREASURY_CONTRACT) private readonly treasury: FinanceTreasuryContract,
    @Optional() @Inject(SUPPLIER_LEDGER_CONTRACT) private readonly supplierLedger?: SupplierLedgerContract,
    @Optional() @Inject(INVENTORY_VALUATION_CONTRACT) private readonly inventoryValuation?: InventoryValuationContract,
  ) {}

  /** ADR-051 §12 — called INSIDE the same transaction that applies the approved close/reclose. Idempotent under a duplicate approval-event delivery (unique index on `approvalRequestId`). */
  async beginPending(manager: EntityManager, fiscalPeriodId: string, approvalRequestId: string, actorUserId: string): Promise<ClosingSnapshotRun> {
    const repo = manager.getRepository(ClosingSnapshotRun);
    const existing = await repo.findOne({ where: { approvalRequestId } });
    if (existing) return existing;

    const priorComplete = await repo.find({ where: { fiscalPeriodId, status: 'complete' }, order: { closeSequence: 'DESC' }, take: 1 });
    const closeSequence = (priorComplete[0]?.closeSequence ?? 0) + 1;
    const supersedesSnapshotId = priorComplete[0]?.id ?? null;

    return repo.save(
      repo.create({
        fiscalPeriodId,
        closeSequence,
        supersedesSnapshotId,
        approvalRequestId,
        status: 'pending',
        generatedByUserId: actorUserId,
      }),
    );
  }

  /** ADR-051 §12 — finds every snapshot run still `'pending'`, retries assembly. Safe to call repeatedly (e.g. by a periodic recovery sweep, ADR-051 §14). */
  async retryPending(): Promise<void> {
    const pending = await this.dataSource.getRepository(ClosingSnapshotRun).find({ where: { status: 'pending' } });
    for (const run of pending) {
      try {
        await this.assembleAndFinalize(run.id);
      } catch (err) {
        this.logger.error(`Closing Snapshot ${run.id} retry failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * ADR-051 §14 — a `ClosingSnapshotRun` still `'pending'`/`'failed'` past a grace period is a
   * DETECTABLE, NAMED condition, never a silent gap: recorded as its own audit entry every sweep
   * pass that still finds it overdue (so the condition is visible in the audit trail even if no
   * human is watching logs in real time), distinct from `retryPending`'s own retry attempts —
   * "still not done" and "we tried again" are different facts, both worth keeping.
   */
  async detectOverdue(graceMinutes = 10): Promise<ClosingSnapshotRun[]> {
    const cutoff = new Date(Date.now() - graceMinutes * 60_000);
    const overdue = await this.dataSource
      .getRepository(ClosingSnapshotRun)
      .createQueryBuilder('r')
      .where('r.status IN (:...statuses)', { statuses: ['pending', 'failed'] })
      .andWhere('r."createdAt" < :cutoff', { cutoff })
      .getMany();

    for (const run of overdue) {
      await this.audit.record({
        actorUserId: SYSTEM_ACTOR_ID,
        organizationId: null,
        action: 'accounting.closing_snapshot.generation_overdue',
        resource: 'closing_snapshot_run',
        resourceId: run.id,
        result: 'failure',
        correlationId: run.approvalRequestId,
        after: { fiscalPeriodId: run.fiscalPeriodId, status: run.status, ageMinutes: Math.round((Date.now() - run.createdAt.getTime()) / 60_000) },
      });
    }
    return overdue;
  }

  async assembleAndFinalize(snapshotRunId: string): Promise<ClosingSnapshotRun> {
    const repo = this.dataSource.getRepository(ClosingSnapshotRun);
    const run = await repo.findOneOrFail({ where: { id: snapshotRunId } });
    if (run.status === 'complete') return run; // already done — never re-written (ADR-051 §13)

    try {
      const period = await this.dataSource.getRepository(FiscalPeriod).findOneOrFail({ where: { id: run.fiscalPeriodId } });
      const year = await this.dataSource.getRepository(FiscalYear).findOne({ where: { id: period.fiscalYearId } });
      const orgUnitId = year?.orgUnitId ?? undefined;
      const asOfDate = period.endDate;

      const body = await this.assembleBody(run, period, asOfDate, orgUnitId);
      const contentHash = 'sha256:' + createHash('sha256').update(canonicalizeJson(body)).digest('hex');

      const predecessor = run.supersedesSnapshotId ? await repo.findOne({ where: { id: run.supersedesSnapshotId } }) : null;

      const manifest: ClosingSnapshotManifest = {
        manifestVersion: '1.0',
        fiscalPeriodId: run.fiscalPeriodId,
        periodCode: period.code,
        closeSequence: run.closeSequence,
        supersedesSnapshotId: run.supersedesSnapshotId,
        previousManifestHash: predecessor?.manifestHash ?? null,
        generatedAt: new Date().toISOString(),
        generatedByUserId: run.generatedByUserId,
        approvalRequestId: run.approvalRequestId,
        appVersion: readAppVersion(),
        migrationHead: await this.getMigrationHead(),
        configVersion: await this.getConfigVersion(),
        contentHash,
      };

      const { kid, signature } = this.signingKeys.sign(canonicalizeJson(manifest));
      const fullManifest: ClosingSnapshotManifest = { ...manifest, signingKeyId: kid, signature };
      const manifestHash = createHash('sha256').update(canonicalizeJson(fullManifest)).digest('hex');

      // Stored under the EXISTING media storage path (ADR-051 §3.7) — not a separate directory —
      // so it is automatically covered by BackupManagerService's already-configured backup scope,
      // with zero change to that subsystem.
      const dir = join(resolve(this.config.mediaStoragePath), 'closing-snapshots', run.fiscalPeriodId);
      await mkdir(dir, { recursive: true });
      const filePath = join(dir, `${manifestHash}.json`);
      await writeFile(filePath, JSON.stringify({ manifest: fullManifest, body }, null, 2), { flag: 'wx' });

      run.status = 'complete';
      run.contentHash = contentHash;
      run.manifestHash = manifestHash;
      run.signingKeyId = kid;
      run.signature = signature;
      run.manifestPath = filePath;
      run.generatedAt = new Date();
      run.appVersion = manifest.appVersion;
      run.migrationHead = manifest.migrationHead;
      const saved = await repo.save(run);

      await this.audit.record({
        actorUserId: run.generatedByUserId,
        organizationId: null,
        action: 'accounting.closing_snapshot.generated',
        resource: 'closing_snapshot_run',
        resourceId: run.id,
        result: 'success',
        correlationId: run.approvalRequestId,
        after: { fiscalPeriodId: run.fiscalPeriodId, closeSequence: run.closeSequence, manifestHash },
      });

      return saved;
    } catch (err) {
      run.status = 'failed';
      await repo.save(run);
      await this.audit.record({
        actorUserId: run.generatedByUserId,
        organizationId: null,
        action: 'accounting.closing_snapshot.generation_failed',
        resource: 'closing_snapshot_run',
        resourceId: run.id,
        result: 'failure',
        correlationId: run.approvalRequestId,
        after: { error: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    }
  }

  private async assembleBody(run: ClosingSnapshotRun, period: FiscalPeriod, asOfDate: string, orgUnitId: string | undefined) {
    const trialBalance = await this.ledger.getTrialBalance({ orgUnitId, to: asOfDate });
    const ar = await this.customerLedger.getAllCustomerBalances(asOfDate);
    const ap = this.supplierLedger ? await this.supplierLedger.getAllSupplierBalances(asOfDate) : null;
    const cashBank = await this.treasury.getAllTreasuryBalances(asOfDate);
    const inventory = this.inventoryValuation ? await this.inventoryValuation.getValuedOnHandTotal(asOfDate) : null;

    const exceptions = await this.dataSource.getRepository(ClosingException).find({ where: { fiscalPeriodId: run.fiscalPeriodId } });
    const rejectedEventsInPeriod = await this.dataSource
      .getRepository(FinancialEvent)
      .find({ where: { status: 'REJECTED', businessDate: Between(period.startDate, period.endDate) } });
    const postedEventsInPeriod = await this.dataSource
      .getRepository(FinancialEvent)
      .count({ where: { status: 'POSTED', businessDate: Between(period.startDate, period.endDate) } });

    return {
      fiscalPeriodId: run.fiscalPeriodId,
      periodCode: period.code,
      periodStartDate: period.startDate,
      periodEndDate: period.endDate,
      asOfDate,
      financialPosition: { trialBalance },
      subledgers: { ar, ap, cashBank },
      inventory,
      closingEvidence: {
        approvalRequestId: run.approvalRequestId,
        closeSequence: run.closeSequence,
        exceptions: exceptions.map((e) => ({
          id: e.id,
          module: e.module,
          category: e.category,
          severity: e.severity,
          status: e.status,
          problem: e.problem,
        })),
      },
      financialEvents: {
        postedInPeriodCount: postedEventsInPeriod,
        rejectedInPeriod: rejectedEventsInPeriod.map((e) => ({ id: e.id, eventType: e.eventType, rejectionReason: e.rejectionReason })),
      },
    };
  }

  private async getMigrationHead(): Promise<string | null> {
    const rows = await this.dataSource.query(`SELECT name FROM migrations ORDER BY id DESC LIMIT 1`);
    return rows[0]?.name ?? null;
  }

  /** V1 simplification, disclosed: no single global "config version" concept exists yet — uses the most recent config-value write as an "as-of" marker. Revisit if/when the Configuration Engine grows a real version concept. */
  private async getConfigVersion(): Promise<string> {
    const rows = await this.dataSource.query(`SELECT MAX("updatedAt") AS latest FROM config_values`).catch(() => [{ latest: null }]);
    return rows[0]?.latest ? new Date(rows[0].latest).toISOString() : 'none';
  }

  async getRun(id: string): Promise<ClosingSnapshotRun> {
    return this.dataSource.getRepository(ClosingSnapshotRun).findOneOrFail({ where: { id } });
  }

  async listRuns(fiscalPeriodId: string): Promise<ClosingSnapshotRun[]> {
    return this.dataSource.getRepository(ClosingSnapshotRun).find({ where: { fiscalPeriodId }, order: { closeSequence: 'ASC' } });
  }

  /** ADR-051 §3.3/§13 — three independent, separately-reported checks. Re-reads the stored file; never trusts the DB row's own cached fields as substitutes for recomputation. */
  async verify(id: string): Promise<ClosingSnapshotVerifyResult> {
    const run = await this.getRun(id);
    if (run.status !== 'complete' || !run.manifestPath) {
      return { ok: false, contentHashMatches: false, signatureValid: false, chainValid: null, reason: 'snapshot is not complete' };
    }

    let stored: { manifest: ClosingSnapshotManifest; body: unknown };
    try {
      stored = JSON.parse(await readFile(run.manifestPath, 'utf8'));
    } catch (err) {
      return { ok: false, contentHashMatches: false, signatureValid: false, chainValid: null, reason: `could not read snapshot file: ${err instanceof Error ? err.message : String(err)}` };
    }

    const recomputedContentHash = 'sha256:' + createHash('sha256').update(canonicalizeJson(stored.body)).digest('hex');
    const contentHashMatches = recomputedContentHash === stored.manifest.contentHash;

    // The signature covers the manifest EXACTLY as it was signed in assembleAndFinalize — before
    // `signingKeyId`/`signature` were added (they are the OUTPUT of signing, never part of the
    // signed payload itself). Both must be stripped here, not just `signature`, or verification
    // recomputes over different bytes than were actually signed and always fails.
    const { signature, signingKeyId, ...signedManifest } = stored.manifest;
    let signatureValid = false;
    if (signature && signingKeyId) {
      const verifyResult = await this.signingKeys.verify(canonicalizeJson(signedManifest), signature, signingKeyId);
      signatureValid = verifyResult.ok;
    }

    let chainValid: boolean | null = null;
    if (stored.manifest.supersedesSnapshotId) {
      const predecessor = await this.dataSource.getRepository(ClosingSnapshotRun).findOne({ where: { id: stored.manifest.supersedesSnapshotId } });
      chainValid = predecessor?.manifestHash != null && predecessor.manifestHash === stored.manifest.previousManifestHash;
    }

    const ok = contentHashMatches && signatureValid && chainValid !== false;
    return { ok, contentHashMatches, signatureValid, chainValid };
  }
}
