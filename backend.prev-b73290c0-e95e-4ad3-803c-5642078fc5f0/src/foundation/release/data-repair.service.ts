import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DataRepairRun } from './data-repair-run.entity';
import { BackupArtifact } from './backup-artifact.entity';
import { DataRepairKind } from './data-repair-status';
import { AuditService } from '../audit/audit.service';
import {
  auditNonCompliantUuids,
  planUuidRepairMapping,
  runUuidRfc4122Repair,
  verifyUuidRepairIntegrity,
  RepairSqlExecutor,
} from '../../database/uuid-repair.core';

/**
 * Release Center — Controlled Data Repair. The CTO directive's exact
 * sequence, as separate deliberate API calls (never one destructive
 * button):
 *
 *   create + audit (read-only)
 *     -> plan mapping (read-only, reviewable old->new)
 *     -> link a VERIFIED pre-repair backup (the gate)
 *     -> execute (ONE transaction: FK-defer -> rewrite PKs + all refs -> FK-restore)
 *     -> verify integrity (FK-orphan sweep, auth/role, zero remaining non-compliant)
 *
 * Everything is frozen on the `DataRepairRun` row as evidence. The repair
 * algorithm itself is `src/database/uuid-repair.core.ts` — shared verbatim
 * with the deferred `RepairNonCompliantUuids` migration so the two paths
 * can never drift.
 *
 * WHY this exists as a first-class capability and not just a runbook: the
 * v1.0.3 deployment left `treasury_accounts` (and every other pre-fix
 * table) carrying non-RFC4122 primary keys, so `POST /deposits/:id/approve`
 * and `POST /treasury/cash-in` keep failing `@IsUUID()` validation on a
 * legacy id resubmitted from the UI. `1755852500000` fixed generation;
 * this repairs the existing rows, with backup + audit + mapping +
 * verification recorded every time.
 */
@Injectable()
export class DataRepairService {
  private readonly logger = new Logger(DataRepairService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  /** A `RepairSqlExecutor` bound to the shared connection — for the read-only steps (audit/plan/verify). `execute()` uses a transaction-scoped executor instead. */
  private get reader(): RepairSqlExecutor {
    return { query: (sql, params) => this.dataSource.query(sql, params as unknown[]) };
  }

  private repo() {
    return this.dataSource.getRepository(DataRepairRun);
  }

  private async getOrThrow(id: string): Promise<DataRepairRun> {
    const run = await this.repo().findOne({ where: { id } });
    if (!run) throw new NotFoundException(`Data repair run "${id}" not found.`);
    return run;
  }

  async get(id: string): Promise<DataRepairRun> {
    return this.getOrThrow(id);
  }

  async list(): Promise<DataRepairRun[]> {
    return this.repo().find({ order: { startedAt: 'DESC' }, take: 100 });
  }

  /**
   * Step 1 — create the run and capture the read-only audit. Writes
   * nothing to any business table; only inserts the `data_repair_run` row.
   */
  async createAndAudit(kind: DataRepairKind, initiatedByUserId: string | null): Promise<DataRepairRun> {
    if (kind !== 'uuid_rfc4122') {
      throw new ConflictException(`Unsupported data repair kind "${kind}".`);
    }
    const auditResult = await auditNonCompliantUuids(this.reader);

    const run = await this.repo().save(
      this.repo().create({
        kind,
        status: 'audited',
        backupRunId: null,
        auditResult,
        mapping: null,
        rowsRepaired: null,
        integrityResult: null,
        initiatedByUserId,
        completedAt: null,
        errorMessage: null,
      }),
    );

    await this.audit.record({
      actorUserId: initiatedByUserId,
      organizationId: null,
      action: 'release.data_repair.created',
      resource: 'data_repair_run',
      resourceId: run.id,
      result: 'success',
      correlationId: null,
      after: { kind, totalNonCompliant: auditResult.totalNonCompliant, zeroBaselineCleanupAdvised: auditResult.zeroBaselineCleanupAdvised },
    });

    return run;
  }

  /**
   * Step 2 — generate the reviewable `old -> new` id mapping. Read-only;
   * allocates the replacement UUIDs (via the now-fixed `gen_random_uuid()`)
   * but applies nothing. `execute()` later replays this exact map so the
   * evidence and the applied change are provably identical.
   */
  async plan(repairRunId: string): Promise<DataRepairRun> {
    const run = await this.getOrThrow(repairRunId);
    if (run.status !== 'audited' && run.status !== 'planned' && run.status !== 'backup_linked') {
      throw new ConflictException(`Cannot plan a repair in status "${run.status}".`);
    }
    const mapping = await planUuidRepairMapping(this.reader);
    run.mapping = mapping;
    if (run.status === 'audited') run.status = 'planned';
    const saved = await this.repo().save(run);

    await this.audit.record({
      actorUserId: run.initiatedByUserId,
      organizationId: null,
      action: 'release.data_repair.planned',
      resource: 'data_repair_run',
      resourceId: run.id,
      result: 'success',
      correlationId: null,
      after: { mappedRows: mapping.length },
    });
    return saved;
  }

  /**
   * Step 3 — tie a specific VERIFIED backup to this repair. Same rule the
   * deploy gate enforces: only a backup whose database artifact is actually
   * `verified` (re-checked here, not trusted) is accepted. No verified
   * backup → the repair cannot run.
   */
  async linkVerifiedBackup(repairRunId: string, backupRunId: string, actorUserId: string): Promise<DataRepairRun> {
    const run = await this.getOrThrow(repairRunId);
    if (run.status !== 'planned' && run.status !== 'audited' && run.status !== 'backup_linked') {
      throw new ConflictException(`Cannot link a backup to a repair in status "${run.status}".`);
    }
    await this.assertBackupVerified(backupRunId);

    run.backupRunId = backupRunId;
    run.status = 'backup_linked';
    const saved = await this.repo().save(run);

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'release.data_repair.backup_linked',
      resource: 'data_repair_run',
      resourceId: run.id,
      result: 'success',
      correlationId: null,
      after: { backupRunId },
    });
    return saved;
  }

  private async assertBackupVerified(backupRunId: string): Promise<void> {
    const dbArtifact = await this.dataSource.getRepository(BackupArtifact).findOne({ where: { backupRunId, type: 'database' } });
    if (!dbArtifact || dbArtifact.status !== 'verified') {
      throw new ConflictException('The selected backup does not have a VERIFIED database artifact — it cannot be linked to this repair. No Verified Backup → No Repair.');
    }
  }

  /**
   * Step 4 — run the repair in ONE transaction, then verify integrity.
   * Preconditions (all re-checked live): status `backup_linked`, a mapping
   * exists, and the linked backup is STILL verified. On any failure the
   * transaction rolls back (nothing partially applied) and the run is
   * marked `failed` with the mapping still recorded for evidence.
   */
  async execute(repairRunId: string, actorUserId: string): Promise<DataRepairRun> {
    const run = await this.getOrThrow(repairRunId);
    if (run.status !== 'backup_linked') {
      throw new ConflictException(`Repair is "${run.status}" — only a "backup_linked" repair (planned + linked to a verified backup) can be executed.`);
    }
    if (!run.mapping) {
      throw new ConflictException('No mapping has been generated for this repair — call plan() first.');
    }
    if (!run.backupRunId) {
      throw new ConflictException('No backup is linked to this repair. No Verified Backup → No Repair.');
    }
    await this.assertBackupVerified(run.backupRunId);

    run.status = 'running';
    await this.repo().save(run);
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'release.data_repair.started',
      resource: 'data_repair_run',
      resourceId: run.id,
      result: 'success',
      correlationId: null,
      after: { backupRunId: run.backupRunId, plannedRows: run.mapping.length },
    });

    try {
      const applied = await this.dataSource.transaction(async (manager) => {
        const tx: RepairSqlExecutor = { query: (sql, params) => manager.query(sql, params as unknown[]) };
        return runUuidRfc4122Repair(tx, run.mapping ?? undefined);
      });

      run.mapping = applied.mapping;
      run.rowsRepaired = applied.totalRepaired;
      run.status = 'verifying';
      await this.repo().save(run);

      const integrityResult = await verifyUuidRepairIntegrity(this.reader);
      run.integrityResult = integrityResult;

      if (!integrityResult.passed) {
        run.status = 'failed';
        run.errorMessage = `Repair transaction committed ${applied.totalRepaired} row(s) but integrity verification FAILED: ${integrityResult.checks
          .filter((c) => !c.ok)
          .map((c) => `${c.name}=${c.count}`)
          .join(', ')}. Restore the linked pre-repair backup.`;
        run.completedAt = new Date();
        await this.repo().save(run);
        await this.audit.record({
          actorUserId,
          organizationId: null,
          action: 'release.data_repair.failed',
          resource: 'data_repair_run',
          resourceId: run.id,
          result: 'failure',
          correlationId: null,
          after: { rowsRepaired: applied.totalRepaired, error: run.errorMessage },
        });
        return run;
      }

      run.status = 'completed';
      run.completedAt = new Date();
      await this.repo().save(run);
      await this.audit.record({
        actorUserId,
        organizationId: null,
        action: 'release.data_repair.completed',
        resource: 'data_repair_run',
        resourceId: run.id,
        result: 'success',
        correlationId: null,
        after: { rowsRepaired: applied.totalRepaired },
      });
      return run;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Data repair "${run.id}" failed`, err instanceof Error ? err.stack : message);
      run.status = 'failed';
      run.errorMessage = message;
      run.completedAt = new Date();
      await this.repo().save(run);
      await this.audit.record({
        actorUserId,
        organizationId: null,
        action: 'release.data_repair.failed',
        resource: 'data_repair_run',
        resourceId: run.id,
        result: 'failure',
        correlationId: null,
        after: { error: message },
      });
      return run;
    }
  }

  /** Re-run the read-only integrity verification against the current DB state (e.g. after a restore) without changing the run's stored result. */
  async verifyNow(): Promise<Awaited<ReturnType<typeof verifyUuidRepairIntegrity>>> {
    return verifyUuidRepairIntegrity(this.reader);
  }
}
