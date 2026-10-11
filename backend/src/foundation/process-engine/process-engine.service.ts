import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { ProcessDefinition } from './process-definition';
import { ProcessInstance } from './process-instance.entity';
import { ProcessTransitionRecord } from './process-transition-record.entity';
import { runInTransaction } from '../transaction/run-in-transaction';

/**
 * Process Engine — Stage 2 build-order item 18.
 * Daii/architecture/decisions/ADR-008-process-engine.md.
 *
 * Remains domain-neutral: every method takes a ProcessDefinition as
 * data and an (entityType, entityId) pair — it has no idea what a
 * "sales order" is. Transitions are transactional with a row lock on
 * the instance, so two concurrent transition attempts on the same
 * entity cannot both succeed (closes a race class the stateless source
 * engine itself never had to worry about, since it had no persistence
 * of its own — Daii adds that persistence, and the concurrency
 * guarantee that comes with it, per ADR-008/ADR-003).
 *
 * **Optional caller-supplied `EntityManager` (Foundation change, owner:
 * Foundation / F02 Team, 2026-09-10).** Every method now accepts an
 * OPTIONAL trailing `manager?: EntityManager`. This is the exact additive
 * pattern already established by three other Platform-Core services —
 * `AuditService.record(payload, manager?)`,
 * `LimitService.consume(key, delta, manager?)` and
 * `EventBusService.publish(manager, …)` — so a caller that has already
 * opened its own transaction can make the process-instance write part of
 * THAT atomic unit, instead of `transition()` opening a second, nested
 * transaction (the pattern that once caused the connection-pool deadlock
 * documented in `AuditService`).
 *
 * Why it was needed: any workflow where a single state transition must
 * commit or roll back together with sibling writes in the same request —
 *   - `foundation/approval-engine` (FA-01): when the Nth approval arrives,
 *     the `ApprovalDecision` row, the `pending → approved` transition, and
 *     the `approval.request.approved` outbox event must all land atomically;
 *   - `accounting` F03's journal posting gate (owned by F03 Team): the
 *     validate → number → `→ POSTED` transition → audit → publish sequence
 *     must be one transaction.
 * The engine itself stays domain-neutral — it knows nothing about
 * approvals or journals; it just no longer forces a nested transaction on
 * a caller that already has one.
 *
 * Backward compatibility: a caller that passes NO `manager` gets the
 * previous behaviour byte-for-byte — `start`/`getState` run on the
 * default connection, `transition` opens its own `dataSource.transaction`.
 * Every existing call site (Sales Order approval, F01 fiscal
 * year/period, …) is unchanged and untouched. Proven by the pre-existing
 * `process-engine.service.spec.ts` still passing unmodified, plus the new
 * `manager?`-contract cases added to it.
 */
@Injectable()
export class ProcessEngineService {
  constructor(private readonly dataSource: DataSource) {}

  async start(
    definition: ProcessDefinition,
    entityType: string,
    entityId: string,
    manager?: EntityManager,
  ): Promise<ProcessInstance> {
    const repo = manager ? manager.getRepository(ProcessInstance) : this.dataSource.getRepository(ProcessInstance);
    const existing = await repo.findOne({
      where: { definitionKey: definition.key, entityType, entityId },
    });
    if (existing) return existing; // idempotent — starting twice is a no-op, not an error

    // N-02/H4: check-then-insert raced (concurrent starts of one entity raised a unique-violation error). The unique index IDX_process_instances_unique makes the insert itself
    // the arbiter: exactly one caller inserts, every other caller's INSERT is a no-op, and all of them read back the single instance.
    await (manager ?? this.dataSource.manager).query(
      `INSERT INTO "process_instances" ("definitionKey","entityType","entityId","currentState") VALUES ($1,$2,$3,$4)
       ON CONFLICT ("definitionKey","entityType","entityId") DO NOTHING`,
      [definition.key, entityType, entityId, definition.initialState],
    );
    return repo.findOneOrFail({ where: { definitionKey: definition.key, entityType, entityId } });
  }

  async getState(
    definition: ProcessDefinition,
    entityType: string,
    entityId: string,
    manager?: EntityManager,
  ): Promise<string> {
    const repo = manager ? manager.getRepository(ProcessInstance) : this.dataSource.getRepository(ProcessInstance);
    const instance = await repo.findOne({ where: { definitionKey: definition.key, entityType, entityId } });
    if (!instance) {
      throw new NotFoundException(
        `No process instance for ${definition.key}/${entityType}/${entityId} — call start() first.`,
      );
    }
    return instance.currentState;
  }

  async transition(
    definition: ProcessDefinition,
    entityType: string,
    entityId: string,
    action: string,
    actorUserId: string | null,
    manager?: EntityManager,
  ): Promise<ProcessInstance> {
    const run = async (m: EntityManager): Promise<ProcessInstance> => {
      const rows: Array<{ id: string; currentState: string }> = await m.query(
        'SELECT id, "currentState" FROM process_instances WHERE "definitionKey" = $1 AND "entityType" = $2 AND "entityId" = $3 FOR UPDATE',
        [definition.key, entityType, entityId],
      );
      if (rows.length === 0) {
        throw new NotFoundException(
          `No process instance for ${definition.key}/${entityType}/${entityId} — call start() first.`,
        );
      }
      const { id, currentState } = rows[0];

      const match = definition.transitions.find((t) => t.from === currentState && t.action === action);
      if (!match) {
        throw new ConflictException(
          `Action "${action}" is not valid from state "${currentState}" for process "${definition.key}".`,
        );
      }

      await m.query('UPDATE process_instances SET "currentState" = $1, "updatedAt" = now() WHERE id = $2', [
        match.to,
        id,
      ]);

      const historyRepo = m.getRepository(ProcessTransitionRecord);
      await historyRepo.save(
        historyRepo.create({
          processInstanceId: id,
          fromState: currentState,
          toState: match.to,
          action,
          actorUserId,
        }),
      );

      const instanceRepo = m.getRepository(ProcessInstance);
      return instanceRepo.findOneOrFail({ where: { id } });
    };

    // N-01: the FOR UPDATE lock on the process instance must be held until the state change and its history row are written (a plain manager would release it at once)
    return runInTransaction(this.dataSource, manager, run);
  }

  async getHistory(processInstanceId: string): Promise<ProcessTransitionRecord[]> {
    return this.dataSource
      .getRepository(ProcessTransitionRecord)
      .find({ where: { processInstanceId }, order: { occurredAt: 'ASC' } });
  }
}
