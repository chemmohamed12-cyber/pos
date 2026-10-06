import { randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { BackupOperation } from './backup-operation.entity';

/** Independent of `MembershipOperation`'s own cap — same durable/retryable/observable PRINCIPLE, a deliberately separate mechanism and tunable constant (Track D §Step 4 freeze). */
const DEFAULT_BACKOFF_BASE_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_BACKOFF_CAP_MS = 60 * 60 * 1000; // 1 hour

/**
 * Backup/DR Architecture V1 (2026-09-24, Track D §Step 4 freeze). Plain
 * CRUD over the durable backup-retry ledger — the state-transition
 * primitives `CompanyBackupService` and `BackupReconciliationScheduler`
 * both drive. Owns no business logic about WHAT to retry, only the
 * ledger's own state machine (see `backup-operation-status.ts`).
 */
@Injectable()
export class BackupOperationService {
  constructor(@InjectRepository(BackupOperation) private readonly operations: Repository<BackupOperation>) {}

  async start(companyId: string | null, backupRunId: string): Promise<BackupOperation> {
    return this.operations.save(
      this.operations.create({
        companyId,
        backupRunId,
        status: 'PENDING',
        attempts: 0,
        lastError: null,
        nextRetryAt: null,
        correlationId: randomUUID(),
      }),
    );
  }

  async markRunning(id: string): Promise<void> {
    await this.operations.update({ id }, { status: 'RUNNING' });
  }

  async markCompleted(id: string): Promise<void> {
    await this.operations.update({ id }, { status: 'COMPLETED', nextRetryAt: null });
  }

  /**
   * One execution attempt failed. Increments `attempts` (a count of actual
   * execution attempts, never of scheduler sweeps that found nothing to
   * do). Terminal once `attempts >= maxAttempts` — `nextRetryAt` is
   * cleared and the row stays `FAILED` for manual/ops follow-up, never
   * retried again; otherwise it schedules the next attempt with an
   * exponential backoff, discoverable by `findRetryable`.
   */
  async markFailed(id: string, error: string, maxAttempts: number): Promise<void> {
    const op = await this.operations.findOneOrFail({ where: { id } });
    const attempts = op.attempts + 1;
    const terminal = attempts >= maxAttempts;
    await this.operations.update(
      { id },
      {
        status: 'FAILED',
        attempts,
        lastError: error,
        nextRetryAt: terminal ? null : new Date(Date.now() + Math.min(DEFAULT_BACKOFF_BASE_MS * 2 ** (attempts - 1), DEFAULT_BACKOFF_CAP_MS)),
      },
    );
  }

  async markRetrying(id: string): Promise<void> {
    await this.operations.update({ id }, { status: 'RETRYING' });
  }

  /** `BackupReconciliationScheduler`'s sweep set — every `FAILED` row whose `nextRetryAt` has arrived. A `FAILED` row past the retry cap has `nextRetryAt = null` and is therefore never picked up again — terminal, by construction, not by a separate flag. */
  async findRetryable(): Promise<BackupOperation[]> {
    return this.operations.find({ where: { status: 'FAILED', nextRetryAt: LessThan(new Date()) } });
  }
}
