import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { ProcessEngineService } from './process-engine.service';
import { SALES_ORDER_APPROVAL_PROCESS } from './process-definition';
import { ProcessTransitionRecord } from './process-transition-record.entity';

/**
 * Runs the actual Sales Order Approval Workflow (blueprint §14) through
 * the generic engine end-to-end — proves ADR-008's central claim: the
 * engine needs zero code changes to support a real business workflow,
 * only a data definition. Plus the two invariants that matter per CTO
 * Execution Policy §5: invalid transitions rejected, start() idempotent.
 */
describe('ProcessEngineService', () => {
  let service: ProcessEngineService;
  let instances: Map<string, { id: string; definitionKey: string; entityType: string; entityId: string; currentState: string }>;
  let history: ProcessTransitionRecord[];
  let idSeq = 0;

  function instanceRepoMock() {
    return {
      findOne: jest.fn(async ({ where }: { where: { definitionKey: string; entityType: string; entityId: string } }) => {
        for (const inst of instances.values()) {
          if (inst.definitionKey === where.definitionKey && inst.entityType === where.entityType && inst.entityId === where.entityId) {
            return inst;
          }
        }
        return null;
      }),
      findOneOrFail: jest.fn(async ({ where }: { where: { id: string } }) => instances.get(where.id)),
      create: jest.fn((data: Record<string, unknown>) => ({ id: `pi-${++idSeq}`, ...data })),
      save: jest.fn(async (inst: { id: string }) => {
        instances.set(inst.id, inst as never);
        return inst;
      }),
    };
  }

  function historyRepoMock() {
    return {
      create: jest.fn((data: Partial<ProcessTransitionRecord>) => ({ id: `h-${history.length + 1}`, occurredAt: new Date(), ...data }) as ProcessTransitionRecord),
      save: jest.fn(async (record: ProcessTransitionRecord) => {
        history.push(record);
        return record;
      }),
      find: jest.fn(async ({ where }: { where: { processInstanceId: string } }) =>
        history.filter((h) => h.processInstanceId === where.processInstanceId).sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime()),
      ),
    };
  }

  const getRepositoryMock = jest.fn((entity: unknown) => {
    if (entity === ProcessTransitionRecord) return historyRepoMock();
    return instanceRepoMock();
  });

  const dataSourceMock = {
    getRepository: getRepositoryMock,
    transaction: jest.fn(async (fn: (manager: unknown) => Promise<unknown>) => {
      const manager = {
        query: jest.fn(async (sql: string, params?: unknown[]) => {
          if (sql.startsWith('SELECT')) {
            const [, , entityId] = params as [string, string, string];
            const found = [...instances.values()].find((i) => i.entityId === entityId);
            return found ? [{ id: found.id, currentState: found.currentState }] : [];
          }
          if (sql.startsWith('UPDATE')) {
            const [newState, id] = params as [string, string];
            const inst = instances.get(id);
            if (inst) inst.currentState = newState;
            return [];
          }
          return [];
        }),
        getRepository: getRepositoryMock,
      };
      return fn(manager);
    }),
  };

  beforeEach(async () => {
    instances = new Map();
    history = [];
    idSeq = 0;
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [ProcessEngineService, { provide: DataSource, useValue: dataSourceMock }],
    }).compile();
    service = moduleRef.get(ProcessEngineService);
  });

  it('starts a new instance at the definition\'s initial state', async () => {
    const instance = await service.start(SALES_ORDER_APPROVAL_PROCESS, 'sales_order', 'so-1');
    expect(instance.currentState).toBe('draft');
  });

  it('is idempotent — starting twice returns the same instance without resetting state', async () => {
    await service.start(SALES_ORDER_APPROVAL_PROCESS, 'sales_order', 'so-1');
    await service.transition(SALES_ORDER_APPROVAL_PROCESS, 'sales_order', 'so-1', 'submit', 'user-1');
    const second = await service.start(SALES_ORDER_APPROVAL_PROCESS, 'sales_order', 'so-1');
    expect(second.currentState).toBe('submitted'); // not reset back to draft
  });

  it('walks the full Sales Order Approval Workflow end-to-end (blueprint §14)', async () => {
    await service.start(SALES_ORDER_APPROVAL_PROCESS, 'sales_order', 'so-2');
    await service.transition(SALES_ORDER_APPROVAL_PROCESS, 'sales_order', 'so-2', 'submit', 'rep-1');
    await service.transition(SALES_ORDER_APPROVAL_PROCESS, 'sales_order', 'so-2', 'start_review', 'system');
    await service.transition(SALES_ORDER_APPROVAL_PROCESS, 'sales_order', 'so-2', 'supervisor_approve', 'supervisor-1');
    await service.transition(SALES_ORDER_APPROVAL_PROCESS, 'sales_order', 'so-2', 'manager_approve', 'manager-1');
    const final = await service.transition(
      SALES_ORDER_APPROVAL_PROCESS,
      'sales_order',
      'so-2',
      'verify_deposit',
      'finance-1',
    );
    expect(final.currentState).toBe('released');

    const record = [...instances.values()].find((i) => i.entityId === 'so-2')!;
    const trail = await service.getHistory(record.id);
    expect(trail.map((t) => t.action)).toEqual([
      'submit',
      'start_review',
      'supervisor_approve',
      'manager_approve',
      'verify_deposit',
    ]);
  });

  it('supports the reject-and-resubmit branch', async () => {
    await service.start(SALES_ORDER_APPROVAL_PROCESS, 'sales_order', 'so-3');
    await service.transition(SALES_ORDER_APPROVAL_PROCESS, 'sales_order', 'so-3', 'submit', 'rep-1');
    await service.transition(SALES_ORDER_APPROVAL_PROCESS, 'sales_order', 'so-3', 'start_review', 'system');
    const rejected = await service.transition(
      SALES_ORDER_APPROVAL_PROCESS,
      'sales_order',
      'so-3',
      'supervisor_reject',
      'supervisor-1',
    );
    expect(rejected.currentState).toBe('pending_resubmission');
    const resubmitted = await service.transition(
      SALES_ORDER_APPROVAL_PROCESS,
      'sales_order',
      'so-3',
      'resubmit',
      'rep-1',
    );
    expect(resubmitted.currentState).toBe('submitted');
  });

  it('rejects an action that is not valid from the current state', async () => {
    await service.start(SALES_ORDER_APPROVAL_PROCESS, 'sales_order', 'so-4');
    await expect(
      service.transition(SALES_ORDER_APPROVAL_PROCESS, 'sales_order', 'so-4', 'manager_approve', 'someone'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('throws when transitioning an instance that was never started', async () => {
    await expect(
      service.transition(SALES_ORDER_APPROVAL_PROCESS, 'sales_order', 'never-started', 'submit', 'user-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
