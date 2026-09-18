import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ProcessDefinition } from './process-definition';
import { ProcessInstance } from './process-instance.entity';
import { ProcessTransitionRecord } from './process-transition-record.entity';

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
 */
@Injectable()
export class ProcessEngineService {
  constructor(private readonly dataSource: DataSource) {}

  async start(definition: ProcessDefinition, entityType: string, entityId: string): Promise<ProcessInstance> {
    const repo = this.dataSource.getRepository(ProcessInstance);
    const existing = await repo.findOne({
      where: { definitionKey: definition.key, entityType, entityId },
    });
    if (existing) return existing; // idempotent — starting twice is a no-op, not an error

    return repo.save(
      repo.create({
        definitionKey: definition.key,
        entityType,
        entityId,
        currentState: definition.initialState,
      }),
    );
  }

  async getState(definition: ProcessDefinition, entityType: string, entityId: string): Promise<string> {
    const repo = this.dataSource.getRepository(ProcessInstance);
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
  ): Promise<ProcessInstance> {
    return this.dataSource.transaction(async (manager) => {
      const rows: Array<{ id: string; currentState: string }> = await manager.query(
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

      await manager.query('UPDATE process_instances SET "currentState" = $1, "updatedAt" = now() WHERE id = $2', [
        match.to,
        id,
      ]);

      const historyRepo = manager.getRepository(ProcessTransitionRecord);
      await historyRepo.save(
        historyRepo.create({
          processInstanceId: id,
          fromState: currentState,
          toState: match.to,
          action,
          actorUserId,
        }),
      );

      const instanceRepo = manager.getRepository(ProcessInstance);
      return instanceRepo.findOneOrFail({ where: { id } });
    });
  }

  async getHistory(processInstanceId: string): Promise<ProcessTransitionRecord[]> {
    return this.dataSource
      .getRepository(ProcessTransitionRecord)
      .find({ where: { processInstanceId }, order: { occurredAt: 'ASC' } });
  }
}
