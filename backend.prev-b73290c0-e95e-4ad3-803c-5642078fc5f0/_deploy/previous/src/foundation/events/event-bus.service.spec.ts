import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventBusService } from './event-bus.service';
import { EventOutbox } from './event-outbox.entity';

/**
 * Main paths + the invariants that matter per CTO Execution Policy §5:
 * dispatch ordering, a failing handler doesn't block other events, and
 * retry/dead-letter-by-status after exhausting attempts.
 */
describe('EventBusService', () => {
  let service: EventBusService;
  let rows: EventOutbox[];
  let seq = 0;

  const repoMock = {
    find: jest.fn(async ({ where }: { where: { status: string } }) =>
      rows.filter((r) => r.status === where.status).sort((a, b) => a.id - b.id),
    ),
    save: jest.fn(async (row: EventOutbox) => {
      const idx = rows.findIndex((r) => r.id === row.id);
      if (idx >= 0) rows[idx] = row;
      return row;
    }),
    create: jest.fn((data: Partial<EventOutbox>) => ({ id: ++seq, dispatchedAt: null, ...data }) as EventOutbox),
  };

  beforeEach(async () => {
    rows = [];
    seq = 0;
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [EventBusService, { provide: getRepositoryToken(EventOutbox), useValue: repoMock }],
    }).compile();
    service = moduleRef.get(EventBusService);
    // seed two pending rows directly (bypassing publish(), which needs a real EntityManager)
    rows.push(
      repoMock.create({ topic: 'test.topic', payload: { n: 1 }, schemaVersion: 1, status: 'pending', attempts: 0 }),
      repoMock.create({ topic: 'test.topic', payload: { n: 2 }, schemaVersion: 1, status: 'pending', attempts: 0 }),
    );
  });

  it('dispatches pending events in order to subscribed handlers', async () => {
    const received: number[] = [];
    service.subscribe('test.topic', async (payload) => {
      received.push(payload.n as number);
    });
    const result = await service.dispatchPending();
    expect(received).toEqual([1, 2]);
    expect(result).toEqual({ dispatched: 2, failed: 0 });
    expect(rows.every((r) => r.status === 'dispatched')).toBe(true);
  });

  it('does not let a failing handler block other pending events', async () => {
    let callCount = 0;
    service.subscribe('test.topic', async () => {
      callCount++;
      if (callCount === 1) throw new Error('boom');
    });
    const result = await service.dispatchPending();
    expect(result).toEqual({ dispatched: 1, failed: 1 });
    expect(rows[0].status).toBe('pending'); // left for retry
    expect(rows[0].attempts).toBe(1);
    expect(rows[1].status).toBe('dispatched');
  });

  it('marks an event failed (dead-letter) after exhausting retry attempts', async () => {
    service.subscribe('test.topic', async () => {
      throw new Error('always fails');
    });
    for (let i = 0; i < 5; i++) {
      await service.dispatchPending();
    }
    expect(rows[0].status).toBe('failed');
    expect(rows[0].attempts).toBe(5);
  });

  it('is a no-op when no handler is subscribed for a topic', async () => {
    const result = await service.dispatchPending();
    expect(result).toEqual({ dispatched: 2, failed: 0 });
  });
});
