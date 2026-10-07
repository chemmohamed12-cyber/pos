import { randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { MembershipOperation, MembershipOperationType } from './membership-operation.entity';

/**
 * Multi-Company Membership HTTP Management (2026-09-24, D5). Plain CRUD
 * over the durable operation ledger — the state-transition primitives
 * `CompanyMembershipProvisioningService` and
 * `MembershipReconciliationScheduler` both drive. Owns no business logic
 * about WHEN to retry or WHAT counts as an admin — only the ledger itself.
 */
@Injectable()
export class MembershipOperationService {
  constructor(@InjectRepository(MembershipOperation) private readonly operations: Repository<MembershipOperation>) {}

  async start(
    userId: string,
    companyId: string,
    operationType: MembershipOperationType,
    previousRoleKey: string | null,
    targetRoleKey: string | null,
    roleSets?: { previousRoleKeys?: string[] | null; targetRoleKeys?: string[] | null },
  ): Promise<MembershipOperation> {
    return this.operations.save(
      this.operations.create({
        userId,
        companyId,
        operationType,
        previousRoleKey,
        targetRoleKey,
        previousRoleKeys: roleSets?.previousRoleKeys ?? null,
        targetRoleKeys: roleSets?.targetRoleKeys ?? null,
        status: 'PENDING',
        attempts: 0,
        lastError: null,
        correlationId: randomUUID(),
      }),
    );
  }

  async markApplying(id: string): Promise<void> {
    await this.operations.update({ id }, { status: 'APPLYING' });
  }

  async markCompleted(id: string): Promise<void> {
    await this.operations.update({ id }, { status: 'COMPLETED' });
  }

  /** A Company-DB attempt failed. Records the error and increments `attempts` — the operation stays discoverable by `findRetryable`, never silently dropped. */
  async markFailed(id: string, error: string): Promise<void> {
    const op = await this.operations.findOneOrFail({ where: { id } });
    await this.operations.update({ id }, { status: 'FAILED', attempts: op.attempts + 1, lastError: error });
  }

  /** F2: the Company-side change was refused / rolled back before anything changed, so there is nothing for the reconciler to heal. Closed as COMPLETED with the reason kept in `lastError`. */
  async markAborted(id: string, reason: string): Promise<void> {
    await this.operations.update({ id }, { status: 'COMPLETED', lastError: `aborted: ${reason}`.slice(0, 500) });
  }

  async markRetrying(id: string): Promise<void> {
    await this.operations.update({ id }, { status: 'RETRYING' });
  }

  /** `MembershipReconciliationScheduler`'s sweep set — every `FAILED` operation not yet past the retry cap. Never picks up `RETRYING` rows (another sweep pass is already handling them) or `COMPLETED`/`PENDING` ones. */
  async findRetryable(maxAttempts: number): Promise<MembershipOperation[]> {
    return this.operations.find({ where: { status: 'FAILED', attempts: LessThan(maxAttempts) } });
  }
}
