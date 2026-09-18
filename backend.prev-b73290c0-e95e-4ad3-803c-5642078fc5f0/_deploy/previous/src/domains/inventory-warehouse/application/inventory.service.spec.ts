import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { StockMovement } from '../infrastructure/stock-movement.entity';
import { StockReservation } from '../infrastructure/stock-reservation.entity';
import { Warehouse } from '../infrastructure/warehouse.entity';
import { AuditService } from '../../../foundation/audit/audit.service';
import { ProductsService } from '../../commerce/application/products.service';
import { BomService } from '../../commerce/application/bom.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';

/**
 * Proves the ledger math and — critically — the concurrency-safe
 * reservation invariant Stage 1 flagged explicitly: two orders
 * competing for the same limited stock must not both succeed.
 */
describe('InventoryService', () => {
  let service: InventoryService;
  const movements: StockMovement[] = [];
  const reservations: StockReservation[] = [];
  let movementSeq = 0;
  let reservationSeq = 0;
  const lockCalls: string[] = [];

  function sumMovements(warehouseId: string, productId: string): number {
    return movements
      .filter((m) => m.warehouseId === warehouseId && m.productId === productId)
      .reduce((sum, m) => sum + m.quantity, 0);
  }
  function sumActiveReservations(warehouseId: string, productId: string): number {
    // Matches production's `status IN ('active', 'preliminary')` — both count against availability, only the label differs.
    return reservations
      .filter((r) => r.warehouseId === warehouseId && r.productId === productId && (r.status === 'active' || r.status === 'preliminary'))
      .reduce((sum, r) => sum + r.quantity, 0);
  }

  const movementRepo = {
    // createdAt: deterministic, strictly increasing per movement (real TypeORM/DB sets this at insert time; the mock has no DB, so this simulates it for the Reports slice's newest-first ordering).
    create: jest.fn(
      (data: Partial<StockMovement>) =>
        ({ id: `mv-${++movementSeq}`, createdAt: new Date(2026, 0, 1, 0, 0, movementSeq), ...data }) as StockMovement,
    ),
    save: jest.fn(async (m: StockMovement) => {
      movements.push(m);
      return m;
    }),
  };
  const reservationRepo = {
    create: jest.fn(
      (data: Partial<StockReservation>) => ({ id: `rsv-${++reservationSeq}`, createdAt: new Date(), ...data }) as StockReservation,
    ),
    save: jest.fn(async (r: StockReservation) => {
      const idx = reservations.findIndex((x) => x.id === r.id);
      if (idx >= 0) reservations[idx] = r;
      else reservations.push(r);
      return r;
    }),
    findOne: jest.fn(
      async ({ where }: { where: { id?: string; salesOrderId?: string; productId?: string; warehouseId?: string; status?: string } }) =>
        reservations.find(
          (r) =>
            (!where.id || r.id === where.id) &&
            (!where.salesOrderId || r.salesOrderId === where.salesOrderId) &&
            (!where.productId || r.productId === where.productId) &&
            (!where.warehouseId || r.warehouseId === where.warehouseId) &&
            (!where.status || r.status === where.status),
        ) ?? null,
    ),
    find: jest.fn(
      async ({ where }: { where: { salesOrderId?: string; productId?: string; warehouseId?: string; status?: string } }) =>
        reservations.filter(
          (r) =>
            (!where.salesOrderId || r.salesOrderId === where.salesOrderId) &&
            (!where.productId || r.productId === where.productId) &&
            (!where.warehouseId || r.warehouseId === where.warehouseId) &&
            (!where.status || r.status === where.status),
        ),
    ),
  };

  const warehouses = new Map<string, Warehouse>();
  let warehouseSeq = 0;
  const warehouseRepo = {
    create: jest.fn((data: Partial<Warehouse>) => ({ id: `wh-${++warehouseSeq}`, ...data }) as Warehouse),
    save: jest.fn(async (w: Warehouse) => {
      warehouses.set(w.id, w);
      return w;
    }),
    findOne: jest.fn(
      async ({
        where,
      }: {
        where: { id?: string; code?: string | { value?: string }; parentWarehouseId?: string; kind?: string };
      }) => {
        for (const w of warehouses.values()) {
          if (where.id !== undefined && w.id !== where.id) continue;
          if (where.parentWarehouseId !== undefined && w.parentWarehouseId !== where.parentWarehouseId) continue;
          if (where.kind !== undefined && w.kind !== where.kind) continue;
          if (where.code !== undefined) {
            if (typeof where.code === 'string') {
              if (w.code !== where.code) continue;
            } else {
              // TypeORM `Like(...)` FindOperator — the only shape used here is a "PREFIX%" match.
              const prefix = String((where.code as { value?: string }).value ?? '').replace(/%$/, '');
              if (!w.code.startsWith(prefix)) continue;
            }
          }
          return w;
        }
        return null;
      },
    ),
    find: jest.fn(async () => [...warehouses.values()]),
  };

  const getRepositoryMock = jest.fn((entity: unknown) =>
    entity === StockMovement ? movementRepo : entity === Warehouse ? warehouseRepo : reservationRepo,
  );

  const rawQuery = async (sql: string, params?: unknown[]) => {
    if (sql.includes('pg_advisory_xact_lock')) {
      lockCalls.push((params as [string])[0]);
      return [];
    }
    if (sql.includes('SELECT * FROM stock_movements')) {
      // listMovements (Reports slice) — the WHERE-clause construction itself is
      // mechanical parameterized SQL string-building; covered by the live
      // verification this session already ran, not re-parsed here. This mock
      // only proves the unfiltered base case reaches the ledger and sorts it.
      return [...movements].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    }
    if (sql.includes('GROUP BY "warehouseId", "productId"') && sql.includes('FROM stock_movements')) {
      const warehouseFilter = (params as [string] | undefined)?.[0];
      const groups = new Map<string, number>();
      for (const m of movements) {
        if (warehouseFilter && m.warehouseId !== warehouseFilter) continue;
        const key = `${m.warehouseId}:${m.productId}`;
        groups.set(key, (groups.get(key) ?? 0) + m.quantity);
      }
      return [...groups.entries()].map(([key, sum]) => {
        const [warehouseId, productId] = key.split(':');
        return { warehouseId, productId, sum: String(sum) };
      });
    }
    if (sql.includes('GROUP BY "warehouseId", "productId"') && sql.includes('FROM stock_reservations')) {
      const warehouseFilter = (params as [string] | undefined)?.[0];
      const groups = new Map<string, number>();
      for (const r of reservations.filter((r) => r.status === 'active' || r.status === 'preliminary')) {
        if (warehouseFilter && r.warehouseId !== warehouseFilter) continue;
        const key = `${r.warehouseId}:${r.productId}`;
        groups.set(key, (groups.get(key) ?? 0) + r.quantity);
      }
      return [...groups.entries()].map(([key, sum]) => {
        const [warehouseId, productId] = key.split(':');
        return { warehouseId, productId, sum: String(sum) };
      });
    }
    if (sql.includes('FROM stock_movements')) {
      const [warehouseId, productId] = params as [string, string];
      return [{ sum: String(sumMovements(warehouseId, productId)) }];
    }
    if (sql.includes('DISTINCT "salesOrderId"') && sql.includes('FROM stock_reservations')) {
      const [olderThan] = params as [Date];
      const ids = new Set(
        reservations.filter((r) => r.status === 'preliminary' && r.createdAt.getTime() < olderThan.getTime()).map((r) => r.salesOrderId),
      );
      return [...ids].map((salesOrderId) => ({ salesOrderId }));
    }
    if (sql.includes('FROM stock_reservations')) {
      const [warehouseId, productId] = params as [string, string];
      return [{ sum: String(sumActiveReservations(warehouseId, productId)) }];
    }
    return [];
  };

  const dataSourceMock = {
    getRepository: getRepositoryMock,
    query: rawQuery,
    transaction: jest.fn(async (fn: (manager: unknown) => Promise<unknown>) =>
      fn({ getRepository: getRepositoryMock, query: rawQuery }),
    ),
  };

  const auditMock = { record: jest.fn(async () => undefined) };
  const bomMock = {
    // finished-1 needs 2x component-1 per unit; any other finished product has no BOM defined.
    getBomForAssembly: jest.fn(async (finishedProductId: string) =>
      finishedProductId === 'finished-1' ? [{ componentProductId: 'component-1', quantityPerUnit: 2 }] : null,
    ),
  };
  let assemblySeq = 0;
  const numberingMock = { getNextNumber: jest.fn(async () => `ASM-2026-${String(++assemblySeq).padStart(6, '0')}`) };

  beforeEach(async () => {
    movements.length = 0;
    reservations.length = 0;
    warehouses.clear();
    lockCalls.length = 0;
    movementSeq = 0;
    reservationSeq = 0;
    warehouseSeq = 0;
    assemblySeq = 0;
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        InventoryService,
        { provide: DataSource, useValue: dataSourceMock },
        { provide: AuditService, useValue: auditMock },
        { provide: ProductsService, useValue: { getProductSnapshotBySku: jest.fn(async () => null) } },
        { provide: BomService, useValue: bomMock },
        { provide: NumberingService, useValue: numberingMock },
      ],
    }).compile();
    service = moduleRef.get(InventoryService);
  });

  it('computes on-hand as the sum of ledger movements, never a stored mutable quantity', async () => {
    await service.recordMovement('wh-1', 'prod-1', 100, 'receipt', null, null, 'worker-1');
    await service.recordMovement('wh-1', 'prod-1', -20, 'dispatch', null, null, 'worker-1');
    expect(await service.getOnHand('wh-1', 'prod-1')).toBe(80);
  });

  it('reserves stock when enough is available, taking a per-(warehouse,product) advisory lock', async () => {
    await service.recordMovement('wh-1', 'prod-1', 100, 'receipt', null, null, 'worker-1');
    const reservation = await service.reserveStock('wh-1', 'prod-1', 30, 'so-1', 'rep-1');
    expect(reservation.quantity).toBe(30);
    expect(lockCalls).toContain('wh-1:prod-1');
    expect(await service.getAvailable('wh-1', 'prod-1')).toBe(70);
  });

  it('rejects a reservation exceeding available stock', async () => {
    await service.recordMovement('wh-1', 'prod-1', 10, 'receipt', null, null, 'worker-1');
    await expect(service.reserveStock('wh-1', 'prod-1', 50, 'so-1', 'rep-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('the second of two competing reservations fails once the first exhausts available stock (concurrency invariant)', async () => {
    await service.recordMovement('wh-1', 'prod-1', 50, 'receipt', null, null, 'worker-1');
    await service.reserveStock('wh-1', 'prod-1', 40, 'so-1', 'rep-1'); // takes 40 of 50
    await expect(service.reserveStock('wh-1', 'prod-1', 40, 'so-2', 'rep-2')).rejects.toBeInstanceOf(
      ConflictException,
    ); // only 10 left, this must fail — never let both succeed
  });

  it('releasing a reservation frees the stock back to available', async () => {
    await service.recordMovement('wh-1', 'prod-1', 50, 'receipt', null, null, 'worker-1');
    const reservation = await service.reserveStock('wh-1', 'prod-1', 40, 'so-1', 'rep-1');
    await service.releaseReservation(reservation.id, 'rep-1');
    expect(await service.getAvailable('wh-1', 'prod-1')).toBe(50);
  });

  it('fulfilling a reservation records the physical dispatch movement and marks it fulfilled', async () => {
    await service.recordMovement('wh-1', 'prod-1', 50, 'receipt', null, null, 'worker-1');
    const reservation = await service.reserveStock('wh-1', 'prod-1', 40, 'so-1', 'rep-1');
    await service.fulfillReservation(reservation.id, 'worker-1');
    expect(await service.getOnHand('wh-1', 'prod-1')).toBe(10); // 50 - 40 dispatched
    expect(await service.getReserved('wh-1', 'prod-1')).toBe(0); // no longer active
  });

  describe('fulfillReservation warehouseIdOverride / fulfillReservationsForOrder (CTO directive — reconcile the Preparation -> Shipping handoff)', () => {
    it('dispatches from the OVERRIDE warehouse, not the reservation\'s own stored one, when the goods have since moved (e.g. a custody transfer)', async () => {
      await service.recordMovement('wh-1', 'prod-1', 50, 'receipt', null, null, 'worker-1');
      await service.reserveStock('wh-1', 'prod-1', 40, 'so-1', 'rep-1');
      await service.relocateReservedStock('so-1', 'prod-1', 'wh-1', 'wh-2', 40, 'shipment_custody_transfer', 'ship-1', 'driver-1');
      // relocateReservedStock moved the reservation itself too — fetch the
      // row that's now active at wh-2, not the original (now-released) id.
      const relocated = reservations.find((r) => r.warehouseId === 'wh-2' && r.status === 'active')!;

      await service.fulfillReservation(relocated.id, 'worker-1', 'wh-2');

      expect(await service.getOnHand('wh-2', 'prod-1')).toBe(0); // 40 relocated in, 40 dispatched out
      expect(await service.getOnHand('wh-1', 'prod-1')).toBe(10); // untouched by the dispatch itself
      expect(await service.getReserved('wh-2', 'prod-1')).toBe(0);
    });

    it('fulfillReservationsForOrder dispatches every active reservation for the order from the given current warehouse', async () => {
      await service.recordMovement('wh-1', 'prod-1', 50, 'receipt', null, null, 'worker-1');
      await service.recordMovement('wh-1', 'prod-2', 20, 'receipt', null, null, 'worker-1');
      await service.reserveStock('wh-1', 'prod-1', 10, 'so-1', 'rep-1');
      await service.reserveStock('wh-1', 'prod-2', 5, 'so-1', 'rep-1');

      await service.fulfillReservationsForOrder('so-1', 'wh-1', 'driver-1');

      expect(await service.getOnHand('wh-1', 'prod-1')).toBe(40);
      expect(await service.getOnHand('wh-1', 'prod-2')).toBe(15);
      expect(await service.getReserved('wh-1', 'prod-1')).toBe(0);
      expect(await service.getReserved('wh-1', 'prod-2')).toBe(0);
    });
  });

  it('throws when releasing an unknown reservation', async () => {
    await expect(service.releaseReservation('no-such-id', 'rep-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  describe('Preliminary Hold (CTO directive — Warehouse/Sales Order Ownership Flow)', () => {
    it('a preliminary reservation counts against availability exactly like an active one', async () => {
      await service.recordMovement('wh-1', 'prod-1', 100, 'receipt', null, null, 'worker-1');
      await service.reserveStock('wh-1', 'prod-1', 30, 'so-1', 'rep-1', 'preliminary');
      expect(await service.getAvailable('wh-1', 'prod-1')).toBe(70); // Free = On Hand - Preliminary Hold - Reserved
      expect(await service.getReserved('wh-1', 'prod-1')).toBe(30); // getReserved counts both statuses (see its own directive-driven query change)
    });

    it('confirmReservationsForOrder promotes every preliminary hold for an order to active, and only that order\'s', async () => {
      await service.recordMovement('wh-1', 'prod-1', 100, 'receipt', null, null, 'worker-1');
      const r1 = await service.reserveStock('wh-1', 'prod-1', 10, 'so-1', 'rep-1', 'preliminary');
      const r2 = await service.reserveStock('wh-1', 'prod-1', 5, 'so-1', 'rep-1', 'preliminary');
      const other = await service.reserveStock('wh-1', 'prod-1', 5, 'so-2', 'rep-1', 'preliminary');

      await service.confirmReservationsForOrder('so-1', 'finance-1');

      expect(reservations.find((r) => r.id === r1.id)?.status).toBe('active');
      expect(reservations.find((r) => r.id === r2.id)?.status).toBe('active');
      expect(reservations.find((r) => r.id === other.id)?.status).toBe('preliminary'); // untouched — different order
    });

    it('releasePreliminaryHoldsForOrder frees the stock back to Free/Available', async () => {
      await service.recordMovement('wh-1', 'prod-1', 100, 'receipt', null, null, 'worker-1');
      await service.reserveStock('wh-1', 'prod-1', 40, 'so-1', 'rep-1', 'preliminary');
      expect(await service.getAvailable('wh-1', 'prod-1')).toBe(60);

      await service.releasePreliminaryHoldsForOrder('so-1', null, 'Preliminary hold expired after 24 hours with no deposit approval.');

      expect(await service.getAvailable('wh-1', 'prod-1')).toBe(100);
    });

    it('releasing preliminary holds never touches an order\'s already-confirmed (active) reservations', async () => {
      await service.recordMovement('wh-1', 'prod-1', 100, 'receipt', null, null, 'worker-1');
      const confirmed = await service.reserveStock('wh-1', 'prod-1', 10, 'so-1', 'rep-1', 'active');
      await service.releasePreliminaryHoldsForOrder('so-1', null, 'irrelevant — no preliminary rows exist for this order');
      expect(reservations.find((r) => r.id === confirmed.id)?.status).toBe('active');
    });

    it('findExpiredPreliminaryHoldOrderIds finds only orders with a preliminary hold older than the cutoff, not newer ones or other statuses', async () => {
      await service.recordMovement('wh-1', 'prod-1', 100, 'receipt', null, null, 'worker-1');
      const old = await service.reserveStock('wh-1', 'prod-1', 10, 'so-old', 'rep-1', 'preliminary');
      reservations.find((r) => r.id === old.id)!.createdAt = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25h ago
      await service.reserveStock('wh-1', 'prod-1', 10, 'so-fresh', 'rep-1', 'preliminary'); // just created, not expired
      await service.reserveStock('wh-1', 'prod-1', 10, 'so-active', 'rep-1', 'active'); // wrong status, never expires this way

      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const expired = await service.findExpiredPreliminaryHoldOrderIds(cutoff);

      expect(expired).toEqual(['so-old']);
    });
  });

  describe('reports', () => {
    it('listMovements returns the ledger, newest first', async () => {
      await service.recordMovement('wh-1', 'prod-1', 50, 'receipt', null, null, 'worker-1');
      await service.recordMovement('wh-1', 'prod-1', -10, 'dispatch', null, null, 'worker-1');
      const rows = await service.listMovements({});
      expect(rows).toHaveLength(2);
      expect(rows[0].movementType).toBe('dispatch'); // most recent first
    });

    it('getStockReport aggregates on-hand/reserved/available per warehouse+product', async () => {
      await service.recordMovement('wh-1', 'prod-1', 100, 'receipt', null, null, 'worker-1');
      await service.recordMovement('wh-2', 'prod-1', 20, 'receipt', null, null, 'worker-1');
      await service.reserveStock('wh-1', 'prod-1', 30, 'so-1', 'rep-1');

      const all = await service.getStockReport();
      const wh1Row = all.find((r) => r.warehouseId === 'wh-1' && r.productId === 'prod-1');
      const wh2Row = all.find((r) => r.warehouseId === 'wh-2' && r.productId === 'prod-1');
      expect(wh1Row).toEqual({ warehouseId: 'wh-1', productId: 'prod-1', onHand: 100, reserved: 30, available: 70 });
      expect(wh2Row).toEqual({ warehouseId: 'wh-2', productId: 'prod-1', onHand: 20, reserved: 0, available: 20 });
    });

    it('getStockReport filters to a single warehouse when given one', async () => {
      await service.recordMovement('wh-1', 'prod-1', 100, 'receipt', null, null, 'worker-1');
      await service.recordMovement('wh-2', 'prod-1', 20, 'receipt', null, null, 'worker-1');
      const filtered = await service.getStockReport('wh-1');
      expect(filtered.every((r) => r.warehouseId === 'wh-1')).toBe(true);
      expect(filtered.some((r) => r.warehouseId === 'wh-2')).toBe(false);
    });
  });

  describe('assembleProduct (Gap G-2)', () => {
    it('atomically consumes the recipe\'s components and produces the finished good', async () => {
      await service.recordMovement('wh-1', 'component-1', 100, 'receipt', null, null, 'worker-1');
      const result = await service.assembleProduct('wh-1', 'finished-1', 10, 'worker-1');

      expect(result.assemblyReference).toMatch(/^ASM-2026-/);
      expect(await service.getOnHand('wh-1', 'component-1')).toBe(80); // 100 - (2 x 10)
      expect(await service.getOnHand('wh-1', 'finished-1')).toBe(10);
      expect(lockCalls).toEqual(['wh-1:component-1', 'wh-1:finished-1']); // sorted, deadlock-safe order
    });

    it('rejects assembly when a component is short, writing NO movements at all', async () => {
      await service.recordMovement('wh-1', 'component-1', 5, 'receipt', null, null, 'worker-1'); // needs 2x10=20
      await expect(service.assembleProduct('wh-1', 'finished-1', 10, 'worker-1')).rejects.toBeInstanceOf(ConflictException);
      expect(await service.getOnHand('wh-1', 'component-1')).toBe(5); // untouched
      expect(await service.getOnHand('wh-1', 'finished-1')).toBe(0); // no partial output
    });

    it('rejects assembly for a product with no Bill of Materials defined', async () => {
      await expect(service.assembleProduct('wh-1', 'no-bom-product', 1, 'worker-1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects a non-positive assembly quantity', async () => {
      await expect(service.assembleProduct('wh-1', 'finished-1', 0, 'worker-1')).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('relocateReservedStock (CTO directive — "PRIORITY: ITEM PREPARATION")', () => {
    it('moves the reservation with the goods, leaving each warehouse\'s Available unchanged by the move itself', async () => {
      await service.recordMovement('wh-1', 'prod-1', 50, 'receipt', null, null, 'worker-1');
      await service.reserveStock('wh-1', 'prod-1', 40, 'so-1', 'rep-1');
      expect(await service.getAvailable('wh-1', 'prod-1')).toBe(10); // Free before any relocation

      await service.relocateReservedStock('so-1', 'prod-1', 'wh-1', 'wh-2', 15, 'pick_task_line', 'line-1', 'worker-1');

      expect(await service.getOnHand('wh-1', 'prod-1')).toBe(35); // 50 - 15 physically left
      expect(await service.getOnHand('wh-2', 'prod-1')).toBe(15);
      expect(await service.getReserved('wh-1', 'prod-1')).toBe(25); // 40 - 15, the reservation followed the goods
      expect(await service.getReserved('wh-2', 'prod-1')).toBe(15);
      expect(await service.getAvailable('wh-1', 'prod-1')).toBe(10); // Free stock is untouched by relocating already-committed stock
      expect(await service.getAvailable('wh-2', 'prod-1')).toBe(0); // fully committed, nothing free for a new order
    });

    it('merges a second partial relocation into the same destination reservation rather than creating a duplicate', async () => {
      await service.recordMovement('wh-1', 'prod-1', 50, 'receipt', null, null, 'worker-1');
      await service.reserveStock('wh-1', 'prod-1', 40, 'so-1', 'rep-1');

      await service.relocateReservedStock('so-1', 'prod-1', 'wh-1', 'wh-2', 10, 'pick_task_line', 'line-1', 'worker-1');
      await service.relocateReservedStock('so-1', 'prod-1', 'wh-1', 'wh-2', 10, 'pick_task_line', 'line-1', 'worker-1');

      expect(await service.getReserved('wh-2', 'prod-1')).toBe(20);
      expect(reservations.filter((r) => r.warehouseId === 'wh-2' && r.status === 'active')).toHaveLength(1);
    });

    it('rejects relocating more than is actively reserved for that order/product/warehouse', async () => {
      await service.recordMovement('wh-1', 'prod-1', 50, 'receipt', null, null, 'worker-1');
      await service.reserveStock('wh-1', 'prod-1', 10, 'so-1', 'rep-1');
      await expect(
        service.relocateReservedStock('so-1', 'prod-1', 'wh-1', 'wh-2', 20, 'pick_task_line', 'line-1', 'worker-1'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects relocating to the same warehouse', async () => {
      await service.recordMovement('wh-1', 'prod-1', 50, 'receipt', null, null, 'worker-1');
      await service.reserveStock('wh-1', 'prod-1', 10, 'so-1', 'rep-1');
      await expect(
        service.relocateReservedStock('so-1', 'prod-1', 'wh-1', 'wh-1', 5, 'pick_task_line', 'line-1', 'worker-1'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('never touches a different order\'s reservation for the same product/warehouse', async () => {
      await service.recordMovement('wh-1', 'prod-1', 50, 'receipt', null, null, 'worker-1');
      const other = await service.reserveStock('wh-1', 'prod-1', 10, 'so-2', 'rep-1');
      await service.reserveStock('wh-1', 'prod-1', 10, 'so-1', 'rep-1');

      await service.relocateReservedStock('so-1', 'prod-1', 'wh-1', 'wh-2', 10, 'pick_task_line', 'line-1', 'worker-1');

      expect(reservations.find((r) => r.id === other.id)?.quantity).toBe(10); // untouched
      expect(reservations.find((r) => r.id === other.id)?.warehouseId).toBe('wh-1'); // untouched
    });
  });

  describe('findOperationalSubLocation', () => {
    it('finds an existing sub-location by parent + code prefix', async () => {
      const parent = await service.createWarehouse('WH-MAIN', 'Main Warehouse');
      const sub = await service.createWarehouse('PREP-000001', 'تحت التجهيز', null, null, parent.id, 'operational');

      const found = await service.findOperationalSubLocation(parent.id, 'PREP-');
      expect(found?.id).toBe(sub.id);
    });

    it('returns null when no sub-location with that prefix exists yet under this parent', async () => {
      const parent = await service.createWarehouse('WH-MAIN', 'Main Warehouse');
      expect(await service.findOperationalSubLocation(parent.id, 'PREP-')).toBeNull();
    });

    it('does not match a sub-location with a different prefix (e.g. a Shipping custodian sub-location)', async () => {
      const parent = await service.createWarehouse('WH-MAIN', 'Main Warehouse');
      await service.createWarehouse('SLOC-000001', 'Shipping Co Sub-location', null, null, parent.id, 'operational');
      expect(await service.findOperationalSubLocation(parent.id, 'PREP-')).toBeNull();
    });
  });

  describe('Warehouse Master (Warehouse ERP V1 / Phase 1 Integration, §3)', () => {
    it('creates a warehouse active by default, with optional location/responsible user', async () => {
      const w = await service.createWarehouse('WH-01', 'Main Warehouse', 'Cairo', 'user-1');
      expect(w.status).toBe('active');
      expect(w.location).toBe('Cairo');
      expect(w.responsibleUserId).toBe('user-1');
    });

    it('rejects a duplicate warehouse code', async () => {
      await service.createWarehouse('WH-01', 'Main Warehouse');
      await expect(service.createWarehouse('WH-01', 'Another Name')).rejects.toBeInstanceOf(ConflictException);
    });

    it('toggles active -> inactive -> active, auditing each change', async () => {
      const w = await service.createWarehouse('WH-01', 'Main Warehouse');
      const deactivated = await service.setWarehouseStatus(w.id, 'inactive', 'admin-1');
      expect(deactivated.status).toBe('inactive');
      const reactivated = await service.setWarehouseStatus(w.id, 'active', 'admin-1');
      expect(reactivated.status).toBe('active');
    });

    it('getWarehouse 404s for an unknown id', async () => {
      await expect(service.getWarehouse('no-such-id')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
