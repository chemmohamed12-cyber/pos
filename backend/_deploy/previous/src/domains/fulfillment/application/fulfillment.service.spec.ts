import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { FulfillmentService } from './fulfillment.service';
import { FulfillmentOrder } from '../infrastructure/fulfillment-order.entity';
import { PickTask } from '../infrastructure/pick-task.entity';
import { PackTask } from '../infrastructure/pack-task.entity';
import { PickTaskLine } from '../infrastructure/pick-task-line.entity';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { AuthorizationService } from '../../../foundation/authorization/authorization.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { InventoryService } from '../../inventory-warehouse/application/inventory.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';

/**
 * Proves ADR-008's central claim on a second real workflow (pick/pack
 * tasks reuse the exact same Process Engine as Sales Order approval,
 * zero engine code changes) and the pick->pack->dispatch chain,
 * including the boundary-respecting call into Inventory's published
 * contract (never its raw tables) at the final dispatch step.
 */
describe('FulfillmentService', () => {
  let service: FulfillmentService;
  const fulfillmentOrders = new Map<string, FulfillmentOrder>();
  const pickTasks = new Map<string, PickTask>();
  const packTasks = new Map<string, PackTask>();
  const pickTaskLines = new Map<string, PickTaskLine>();
  const taskStates = new Map<string, string>();
  const publishedEvents: string[] = [];
  let idSeq = 0;

  function repoFor(entity: unknown) {
    if (entity === FulfillmentOrder) {
      return {
        create: jest.fn((d: Partial<FulfillmentOrder>) => ({ id: `fo-${++idSeq}`, ...d }) as FulfillmentOrder),
        save: jest.fn(async (o: FulfillmentOrder) => {
          fulfillmentOrders.set(o.id, o);
          return o;
        }),
        findOne: jest.fn(async ({ where }: { where: { id: string } }) => fulfillmentOrders.get(where.id) ?? null),
        find: jest.fn(async () => [...fulfillmentOrders.values()]),
      };
    }
    if (entity === PickTask) {
      return {
        create: jest.fn((d: Partial<PickTask>) => ({ id: `pick-${++idSeq}`, ...d }) as PickTask),
        save: jest.fn(async (t: PickTask) => {
          pickTasks.set(t.id, t);
          return t;
        }),
        findOne: jest.fn(async ({ where }: { where: { id: string } }) => pickTasks.get(where.id) ?? null),
      };
    }
    if (entity === PickTaskLine) {
      return {
        create: jest.fn(
          (d: Partial<PickTaskLine>) =>
            ({ id: `line-${++idSeq}`, preparedQuantity: 0, status: 'pending', preparedByUserId: null, preparedAt: null, ...d }) as PickTaskLine,
        ),
        save: jest.fn(async (t: PickTaskLine | PickTaskLine[]) => {
          for (const row of Array.isArray(t) ? t : [t]) pickTaskLines.set(row.id, row);
          return t;
        }),
        findOne: jest.fn(async ({ where }: { where: { id?: string; pickTaskId?: string } }) =>
          [...pickTaskLines.values()].find(
            (l) => (!where.id || l.id === where.id) && (!where.pickTaskId || l.pickTaskId === where.pickTaskId),
          ) ?? null,
        ),
        find: jest.fn(async ({ where }: { where?: { pickTaskId?: string } } = {}) =>
          [...pickTaskLines.values()].filter((l) => !where?.pickTaskId || l.pickTaskId === where.pickTaskId),
        ),
      };
    }
    return {
      create: jest.fn((d: Partial<PackTask>) => ({ id: `pack-${++idSeq}`, ...d }) as PackTask),
      save: jest.fn(async (t: PackTask) => {
        packTasks.set(t.id, t);
        return t;
      }),
      findOne: jest.fn(async ({ where }: { where: { id: string } }) => packTasks.get(where.id) ?? null),
    };
  }

  const getRepositoryMock = jest.fn(repoFor);

  const dataSourceMock = {
    getRepository: getRepositoryMock,
    transaction: jest.fn(async (fn: (manager: unknown) => Promise<unknown>) => fn({ getRepository: getRepositoryMock })),
  };

  const processEngineMock = {
    start: jest.fn(async (_def: unknown, _type: string, id: string) => {
      taskStates.set(id, 'assigned');
    }),
    transition: jest.fn(async (_def: unknown, _type: string, id: string, action: string) => {
      const map: Record<string, string> = {
        accept: 'accepted',
        start: 'in_progress',
        complete: 'pending_verification',
        verify: 'closed',
      };
      taskStates.set(id, map[action]);
    }),
    getState: jest.fn(async (_def: unknown, _type: string, id: string) => taskStates.get(id) ?? 'assigned'),
  };
  const authorizationMock = {
    getRoleKeysForUser: jest.fn(async (userId: string) => (userId === 'worker-1' ? ['warehouse_worker'] : [])),
  };
  const auditMock = { record: jest.fn(async () => undefined) };
  const eventsMock = {
    publish: jest.fn(async (_manager: unknown, topic: string) => {
      publishedEvents.push(topic);
    }),
    // RSH Shipping Orders (CTO directive §3) — transitionPackTask's closed
    // branch flushes the outbox in the same request as products.service.ts
    // already does elsewhere.
    dispatchPending: jest.fn(async () => ({ dispatched: 0, failed: 0 })),
  };
  const inventoryMock = {
    fulfillReservation: jest.fn(async () => ({ id: 'mv-1' })),
    getActiveReservationsForOrder: jest.fn(async () => [{ id: 'rsv-1', warehouseId: 'wh-1', productId: 'prod-1', quantity: 2 }]),
    relocateReservedStock: jest.fn(async () => undefined),
    findOperationalSubLocation: jest.fn(async () => null),
    createWarehouse: jest.fn(async (code: string) => ({ id: 'prep-wh-1', code, kind: 'operational' })),
  };
  const numberingMock = {
    registerDocumentType: jest.fn(async () => undefined),
    getNextNumber: jest.fn(async (documentType: string) => (documentType === 'fulfillment_order' ? 'FO-2026-000001' : 'PREP-000001')),
  };

  beforeEach(async () => {
    fulfillmentOrders.clear();
    pickTasks.clear();
    packTasks.clear();
    pickTaskLines.clear();
    taskStates.clear();
    publishedEvents.length = 0;
    idSeq = 0;
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        FulfillmentService,
        { provide: DataSource, useValue: dataSourceMock },
        { provide: ProcessEngineService, useValue: processEngineMock },
        { provide: AuthorizationService, useValue: authorizationMock },
        { provide: AuditService, useValue: auditMock },
        { provide: EventBusService, useValue: eventsMock },
        { provide: InventoryService, useValue: inventoryMock },
        { provide: NumberingService, useValue: numberingMock },
      ],
    }).compile();
    service = moduleRef.get(FulfillmentService);
  });

  it('creates a fulfillment order with its pick task started at "assigned"', async () => {
    const { pickTask } = await service.createFulfillmentOrder('so-1', 'admin-1');
    expect(processEngineMock.start).toHaveBeenCalledWith(expect.anything(), 'pick_task', pickTask.id);
    expect(publishedEvents).toContain('fulfillment.created');
  });

  it('issues the fulfillment order its own document number, same format as the Sales Order\'s but with an "FO" prefix', async () => {
    const { fulfillmentOrder } = await service.createFulfillmentOrder('so-1', 'admin-1');
    expect(fulfillmentOrder.orderNumber).toBe('FO-2026-000001');
  });

  it('rejects a non-worker attempting to transition a pick task', async () => {
    const { pickTask } = await service.createFulfillmentOrder('so-1', 'admin-1');
    await expect(service.transitionPickTask(pickTask.id, 'accept', 'rep-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('walks a pick task through accept/start/complete/verify and auto-creates the pack task on close', async () => {
    const { pickTask } = await service.createFulfillmentOrder('so-1', 'admin-1');
    await service.transitionPickTask(pickTask.id, 'accept', 'worker-1');
    await service.transitionPickTask(pickTask.id, 'start', 'worker-1');
    await service.transitionPickTask(pickTask.id, 'complete', 'worker-1');
    const result = await service.transitionPickTask(pickTask.id, 'verify', 'worker-1');

    expect(result.state).toBe('closed');
    expect(result.packTaskId).not.toBeNull();
    expect(publishedEvents).toContain('fulfillment.pick.completed');
    expect(packTasks.size).toBe(1); // auto-created
  });

  it('closing the pack task emits fulfillment.ready-for-dispatch WITHOUT touching the inventory ledger (CTO directive — reconcile the Preparation -> Shipping handoff, "no premature inventory deduction")', async () => {
    const { pickTask } = await service.createFulfillmentOrder('so-1', 'admin-1');
    await service.transitionPickTask(pickTask.id, 'accept', 'worker-1');
    await service.transitionPickTask(pickTask.id, 'start', 'worker-1');
    await service.transitionPickTask(pickTask.id, 'complete', 'worker-1');
    await service.transitionPickTask(pickTask.id, 'verify', 'worker-1');

    const [packTaskId] = packTasks.keys();
    await service.transitionPackTask(packTaskId, 'accept', 'worker-1');
    await service.transitionPackTask(packTaskId, 'start', 'worker-1');
    await service.transitionPackTask(packTaskId, 'complete', 'worker-1');
    const finalState = await service.transitionPackTask(packTaskId, 'verify', 'worker-1');

    expect(finalState).toBe('closed');
    // REAL BUG FOUND AND FIXED (this directive): pack-close used to call
    // `InventoryService.fulfillReservation` here — zeroing the ledger
    // before Shipment/pickup/custody-transfer even existed. The final
    // ledger exit now happens exactly once, at actual Customer Delivery
    // (`DeliveryService.recordOutcome` -> `fulfillReservationsForOrder`,
    // see delivery.service.spec.ts) — pack-close only announces readiness.
    expect(inventoryMock.fulfillReservation).not.toHaveBeenCalled();
    expect(publishedEvents).toContain('fulfillment.ready-for-dispatch');
  });

  describe('multi-line fix', () => {
    it('rejects creating a fulfillment order when no active reservation exists yet', async () => {
      inventoryMock.getActiveReservationsForOrder.mockResolvedValueOnce([] as never);
      await expect(service.createFulfillmentOrder('so-none', 'admin-1')).rejects.toThrow(
        /No active stock reservations/,
      );
    });

    it('rejects creating a fulfillment order whose reservations span multiple warehouses', async () => {
      inventoryMock.getActiveReservationsForOrder.mockResolvedValueOnce([
        { id: 'rsv-1', warehouseId: 'wh-1' },
        { id: 'rsv-2', warehouseId: 'wh-2' },
      ] as never);
      await expect(service.createFulfillmentOrder('so-split', 'admin-1')).rejects.toThrow(
        /span multiple warehouses/,
      );
    });
  });

  describe('listFulfillmentOrders (CTO directive — Fulfillment dashboard)', () => {
    it('returns every fulfillment order, not just one sales order\'s', async () => {
      await service.createFulfillmentOrder('so-1', 'admin-1');
      await service.createFulfillmentOrder('so-2', 'admin-1');
      const all = await service.listFulfillmentOrders();
      expect(all.map((o) => o.salesOrderId).sort()).toEqual(['so-1', 'so-2']);
    });
  });

  describe('receiveAndStartPickTask (CTO directive — "استلام وبدء التجهيز" as one action)', () => {
    it('runs accept then start back-to-back, landing directly on in_progress', async () => {
      const { pickTask } = await service.createFulfillmentOrder('so-1', 'admin-1');
      const result = await service.receiveAndStartPickTask(pickTask.id, 'worker-1');
      expect(result.state).toBe('in_progress');
      expect(processEngineMock.transition).toHaveBeenNthCalledWith(1, expect.anything(), 'pick_task', pickTask.id, 'accept', 'worker-1');
      expect(processEngineMock.transition).toHaveBeenNthCalledWith(2, expect.anything(), 'pick_task', pickTask.id, 'start', 'worker-1');
    });

    it('rejects for a non-worker, same as the individual transitions', async () => {
      const { pickTask } = await service.createFulfillmentOrder('so-1', 'admin-1');
      await expect(service.receiveAndStartPickTask(pickTask.id, 'rep-1')).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('Item Preparation (CTO directive — "PRIORITY: ITEM PREPARATION")', () => {
    it('creates one Pick Task Line per reservation, snapshotting product/quantity from the reservation', async () => {
      const { pickTask } = await service.createFulfillmentOrder('so-1', 'admin-1');
      const lines = await service.listPickTaskLines(pickTask.id);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ productId: 'prod-1', requestedQuantity: 2, preparedQuantity: 0, status: 'pending' });
    });

    it('rejects preparing an item before the pick task has been started', async () => {
      const { pickTask } = await service.createFulfillmentOrder('so-1', 'admin-1');
      const [line] = await service.listPickTaskLines(pickTask.id);
      await expect(service.markPickTaskLineDone(pickTask.id, line.id, 1, 'worker-1')).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects a non-worker attempting to prepare an item', async () => {
      const { pickTask } = await service.createFulfillmentOrder('so-1', 'admin-1');
      await service.receiveAndStartPickTask(pickTask.id, 'worker-1');
      const [line] = await service.listPickTaskLines(pickTask.id);
      await expect(service.markPickTaskLineDone(pickTask.id, line.id, 1, 'rep-1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('records a partial "تم", relocates exactly that quantity via Inventory, and leaves the line pending', async () => {
      const { fulfillmentOrder, pickTask } = await service.createFulfillmentOrder('so-1', 'admin-1');
      await service.receiveAndStartPickTask(pickTask.id, 'worker-1');
      const [line] = await service.listPickTaskLines(pickTask.id);

      const updated = await service.markPickTaskLineDone(pickTask.id, line.id, 1, 'worker-1');

      expect(updated.preparedQuantity).toBe(1);
      expect(updated.status).toBe('pending');
      expect(inventoryMock.relocateReservedStock).toHaveBeenCalledWith(
        'so-1',
        'prod-1',
        fulfillmentOrder.warehouseId,
        'prep-wh-1',
        1,
        'pick_task_line',
        line.id,
        'worker-1',
      );
      // Still mid-preparation — the pick task must not auto-advance yet.
      expect(await service.getPickTask(pickTask.id)).toMatchObject({ state: 'in_progress' });
    });

    it('rejects preparing more than remains on the line', async () => {
      const { pickTask } = await service.createFulfillmentOrder('so-1', 'admin-1');
      await service.receiveAndStartPickTask(pickTask.id, 'worker-1');
      const [line] = await service.listPickTaskLines(pickTask.id);
      await expect(service.markPickTaskLineDone(pickTask.id, line.id, 3, 'worker-1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('completing the last remaining quantity marks the line prepared and auto-advances a single-line pick task to preparation review', async () => {
      const { pickTask } = await service.createFulfillmentOrder('so-1', 'admin-1');
      await service.receiveAndStartPickTask(pickTask.id, 'worker-1');
      const [line] = await service.listPickTaskLines(pickTask.id);

      await service.markPickTaskLineDone(pickTask.id, line.id, 1, 'worker-1');
      const finished = await service.markPickTaskLineDone(pickTask.id, line.id, 1, 'worker-1');

      expect(finished.status).toBe('prepared');
      expect(finished.preparedQuantity).toBe(2);
      expect(await service.getPickTask(pickTask.id)).toMatchObject({ state: 'pending_verification' });
    });

    it('rejects preparing an item that is already fully prepared', async () => {
      const { pickTask } = await service.createFulfillmentOrder('so-1', 'admin-1');
      await service.receiveAndStartPickTask(pickTask.id, 'worker-1');
      const [line] = await service.listPickTaskLines(pickTask.id);
      await service.markPickTaskLineDone(pickTask.id, line.id, 2, 'worker-1');
      await expect(service.markPickTaskLineDone(pickTask.id, line.id, 1, 'worker-1')).rejects.toBeInstanceOf(ConflictException);
    });

    it('records a full audit trail entry: previous/new status and quantity, per prepare action', async () => {
      const { pickTask } = await service.createFulfillmentOrder('so-1', 'admin-1');
      await service.receiveAndStartPickTask(pickTask.id, 'worker-1');
      const [line] = await service.listPickTaskLines(pickTask.id);

      await service.markPickTaskLineDone(pickTask.id, line.id, 1, 'worker-1');

      expect(auditMock.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actorUserId: 'worker-1',
          action: 'fulfillment.pick_task_line.prepared',
          resource: 'pick_task_line',
          resourceId: line.id,
          before: { preparedQuantity: 0, status: 'pending' },
          after: expect.objectContaining({
            preparedQuantity: 1,
            status: 'pending',
            quantityJustPrepared: 1,
            salesOrderId: 'so-1',
            productId: 'prod-1',
          }),
        }),
      );
    });

    it('does not auto-advance a multi-line order until every line is fully prepared', async () => {
      inventoryMock.getActiveReservationsForOrder.mockResolvedValueOnce([
        { id: 'rsv-1', warehouseId: 'wh-1', productId: 'prod-1', quantity: 2 },
        { id: 'rsv-2', warehouseId: 'wh-1', productId: 'prod-2', quantity: 3 },
      ] as never);
      const { pickTask } = await service.createFulfillmentOrder('so-multi', 'admin-1');
      await service.receiveAndStartPickTask(pickTask.id, 'worker-1');
      const [lineA, lineB] = await service.listPickTaskLines(pickTask.id);

      await service.markPickTaskLineDone(pickTask.id, lineA.id, 2, 'worker-1');
      expect(await service.getPickTask(pickTask.id)).toMatchObject({ state: 'in_progress' });

      await service.markPickTaskLineDone(pickTask.id, lineB.id, 3, 'worker-1');
      expect(await service.getPickTask(pickTask.id)).toMatchObject({ state: 'pending_verification' });
    });

    it('"تم للجميع" marks every remaining line fully prepared in one call and auto-advances', async () => {
      inventoryMock.getActiveReservationsForOrder.mockResolvedValueOnce([
        { id: 'rsv-1', warehouseId: 'wh-1', productId: 'prod-1', quantity: 2 },
        { id: 'rsv-2', warehouseId: 'wh-1', productId: 'prod-2', quantity: 3 },
      ] as never);
      const { pickTask } = await service.createFulfillmentOrder('so-multi', 'admin-1');
      await service.receiveAndStartPickTask(pickTask.id, 'worker-1');

      const results = await service.markAllPickTaskLinesDone(pickTask.id, 'worker-1');

      expect(results.every((l) => l.status === 'prepared')).toBe(true);
      expect(inventoryMock.relocateReservedStock).toHaveBeenCalledWith('so-multi', 'prod-1', 'wh-1', 'prep-wh-1', 2, 'pick_task_line', expect.any(String), 'worker-1');
      expect(inventoryMock.relocateReservedStock).toHaveBeenCalledWith('so-multi', 'prod-2', 'wh-1', 'prep-wh-1', 3, 'pick_task_line', expect.any(String), 'worker-1');
      expect(await service.getPickTask(pickTask.id)).toMatchObject({ state: 'pending_verification' });
    });

    it('rejects a non-worker attempting "تم للجميع"', async () => {
      const { pickTask } = await service.createFulfillmentOrder('so-1', 'admin-1');
      await service.receiveAndStartPickTask(pickTask.id, 'worker-1');
      await expect(service.markAllPickTaskLinesDone(pickTask.id, 'rep-1')).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('finishPreparationAndReadyForShipping ("تم التغليف وجاهز للشحن" one-click action)', () => {
    it('runs Preparation Review + the full Pack Task cycle back-to-back once every item is prepared', async () => {
      const { pickTask } = await service.createFulfillmentOrder('so-1', 'admin-1');
      await service.receiveAndStartPickTask(pickTask.id, 'worker-1');
      await service.markAllPickTaskLinesDone(pickTask.id, 'worker-1'); // auto-advances to pending_verification

      const result = await service.finishPreparationAndReadyForShipping(pickTask.id, 'worker-1');

      expect(result.state).toBe('closed'); // the Pack Task, ready for shipping
      expect(result.packTaskId).toBeTruthy();
      expect(packTasks.size).toBe(1);
    });

    it('rejects when not every item has been prepared yet', async () => {
      const { pickTask } = await service.createFulfillmentOrder('so-1', 'admin-1');
      await service.receiveAndStartPickTask(pickTask.id, 'worker-1');
      await expect(service.finishPreparationAndReadyForShipping(pickTask.id, 'worker-1')).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects for a non-worker', async () => {
      const { pickTask } = await service.createFulfillmentOrder('so-1', 'admin-1');
      await service.receiveAndStartPickTask(pickTask.id, 'worker-1');
      await service.markAllPickTaskLinesDone(pickTask.id, 'worker-1');
      await expect(service.finishPreparationAndReadyForShipping(pickTask.id, 'rep-1')).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
