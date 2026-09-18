import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { WarehouseTransactionsService } from './warehouse-transactions.service';
import { WarehouseTransaction } from '../infrastructure/warehouse-transaction.entity';
import { WarehouseTransactionLine } from '../infrastructure/warehouse-transaction-line.entity';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { AuthorizationService } from '../../../foundation/authorization/authorization.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { ProductsService } from '../../commerce/application/products.service';
import { InventoryService } from './inventory.service';

/**
 * Proves the Warehouse & Inventory Control UX/UI V1 directive's core
 * architectural claims: (1) every posting path goes through
 * InventoryService.recordMovement, never the ledger directly; (2)
 * receipt auto-posts on submit while issue/adjustment require a real
 * approve step; (3) negative-stock is blocked at posting time; (4)
 * reversal creates a new linked transaction rather than mutating the
 * posted one.
 */
describe('WarehouseTransactionsService', () => {
  let service: WarehouseTransactionsService;
  const transactions = new Map<string, WarehouseTransaction>();
  const lines = new Map<string, WarehouseTransactionLine>();
  const taskStates = new Map<string, string>();
  let idSeq = 0;

  function txnRepoMock() {
    return {
      create: jest.fn((d: Partial<WarehouseTransaction>) => ({ id: `txn-${++idSeq}`, ...d }) as WarehouseTransaction),
      save: jest.fn(async (t: WarehouseTransaction) => {
        transactions.set(t.id, t);
        return t;
      }),
      findOne: jest.fn(async ({ where }: { where: { id: string } }) => transactions.get(where.id) ?? null),
      update: jest.fn(async (id: string, patch: Partial<WarehouseTransaction>) => {
        const existing = transactions.get(id);
        if (existing) Object.assign(existing, patch);
      }),
      find: jest.fn(async () => [...transactions.values()]),
      findAndCount: jest.fn(async (opts?: { where?: { warehouseId?: string; type?: string }; take?: number; skip?: number }) => {
        let all = [...transactions.values()];
        if (opts?.where?.warehouseId) all = all.filter((t) => t.warehouseId === opts.where!.warehouseId);
        if (opts?.where?.type) all = all.filter((t) => t.type === opts.where!.type);
        const skip = opts?.skip ?? 0;
        const take = opts?.take ?? all.length;
        return [all.slice(skip, skip + take), all.length] as [WarehouseTransaction[], number];
      }),
    };
  }
  function lineRepoMock() {
    return {
      create: jest.fn((d: Partial<WarehouseTransactionLine>) => ({ id: `line-${++idSeq}`, ...d }) as WarehouseTransactionLine),
      save: jest.fn(async (input: WarehouseTransactionLine | WarehouseTransactionLine[]) => {
        const arr = Array.isArray(input) ? input : [input];
        for (const l of arr) lines.set(l.id, l);
        return input;
      }),
      find: jest.fn(async ({ where }: { where: { warehouseTransactionId: string } }) =>
        [...lines.values()].filter((l) => l.warehouseTransactionId === where.warehouseTransactionId),
      ),
      findOne: jest.fn(async ({ where }: { where: { id: string } }) => lines.get(where.id) ?? null),
    };
  }

  const getRepositoryMock = jest.fn((entity: unknown) => (entity === WarehouseTransaction ? txnRepoMock() : lineRepoMock()));
  const lockCalls: string[] = [];
  const managerQueryMock = jest.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes('pg_advisory_xact_lock')) lockCalls.push((params as [string])[0]);
    return [];
  });
  const dataSourceMock = {
    getRepository: getRepositoryMock,
    transaction: jest.fn(async (fn: (manager: unknown) => Promise<unknown>) =>
      fn({ getRepository: getRepositoryMock, query: managerQueryMock }),
    ),
  };

  const numberingMock = { getNextNumber: jest.fn(async (series: string) => `${series.toUpperCase()}-2026-000001`) };
  const processEngineMock = {
    start: jest.fn(async (_def: unknown, _type: string, id: string) => {
      taskStates.set(id, 'draft');
    }),
    transition: jest.fn(async (_def: unknown, _type: string, id: string, action: string) => {
      const map: Record<string, string> = { submit: 'submitted', recall: 'draft', auto_post: 'posted', approve: 'approved', post: 'posted', reverse: 'reversed' };
      const from = taskStates.get(id);
      const validFrom: Record<string, string[]> = {
        submit: ['draft'], recall: ['submitted'], auto_post: ['submitted'], approve: ['submitted'], post: ['approved'], reverse: ['posted'],
      };
      if (!validFrom[action]?.includes(from ?? '')) throw new ConflictException(`cannot ${action} from ${from}`);
      taskStates.set(id, map[action]);
    }),
    getState: jest.fn(async (_def: unknown, _type: string, id: string) => taskStates.get(id) ?? 'draft'),
  };
  const authorizationMock = {
    getRoleKeysForUser: jest.fn(async (userId: string) => {
      if (userId === 'admin-1') return ['admin'];
      if (userId === 'supervisor-1') return ['warehouse_supervisor'];
      return ['warehouse_worker'];
    }),
  };
  const auditMock = { record: jest.fn(async () => undefined) };
  const productsMock = {
    getProductSnapshot: jest.fn(async (id: string) => ({ id, sku: 'SKU', name: 'Product', unitPrice: '10.00', status: 'active' })),
    listAllProducts: jest.fn(async () => [
      { id: 'p-1', sku: 'P1', name: 'Product 1', unitPrice: '10.00', status: 'active' },
      { id: 'p-2', sku: 'P2', name: 'Product 2', unitPrice: '20.00', status: 'active' },
    ]),
  };
  const inventoryMock = {
    recordMovement: jest.fn(async () => ({ id: 'mv-1' })),
    getOnHand: jest.fn(async () => 50),
    getAvailable: jest.fn(async () => 50),
    getAvailableInTransaction: jest.fn(async (_manager: unknown, _warehouseId: string, _productId: string) => 50),
    listWarehouses: jest.fn(async () => [{ id: 'wh-1', code: 'WH-1' }, { id: 'wh-2', code: 'WH-2' }]),
    getWarehouse: jest.fn(async (id: string) => ({ id, code: id === 'wh-1' ? 'WH-1' : 'WH-2', status: 'active' })),
    getStockReport: jest.fn(async () => [
      { warehouseId: 'wh-1', productId: 'p-1', onHand: 100, reserved: 10, available: 90 },
      { warehouseId: 'wh-1', productId: 'p-2', onHand: -5, reserved: 0, available: -5 },
    ]),
    listMovements: jest.fn(async () => [{ id: 'mv-1' }, { id: 'mv-2' }]),
  };

  beforeEach(async () => {
    transactions.clear();
    lines.clear();
    taskStates.clear();
    lockCalls.length = 0;
    idSeq = 0;
    jest.clearAllMocks();
    // clearAllMocks() clears calls/results but NOT a persistent
    // mockImplementation() set by a previous test — restore the sane
    // default here so per-product custom implementations in one test
    // never leak into the next.
    inventoryMock.getAvailableInTransaction.mockImplementation(async () => 50);
    inventoryMock.getWarehouse.mockImplementation(async (id: string) => ({ id, code: id === 'wh-1' ? 'WH-1' : 'WH-2', status: 'active' }));
    const moduleRef = await Test.createTestingModule({
      providers: [
        WarehouseTransactionsService,
        { provide: DataSource, useValue: dataSourceMock },
        { provide: NumberingService, useValue: numberingMock },
        { provide: ProcessEngineService, useValue: processEngineMock },
        { provide: AuthorizationService, useValue: authorizationMock },
        { provide: AuditService, useValue: auditMock },
        { provide: ProductsService, useValue: productsMock },
        { provide: InventoryService, useValue: inventoryMock },
      ],
    }).compile();
    service = moduleRef.get(WarehouseTransactionsService);
  });

  it('rejects creating a transaction with no lines', async () => {
    await expect(service.createTransaction('receipt', 'wh-1', null, [], null, null, null, 'worker-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('a receipt auto-posts on submit — no separate approval step', async () => {
    const txn = await service.createTransaction('receipt', 'wh-1', null, [{ productId: 'p-1', quantity: 10 }], null, null, null, 'worker-1');
    const state = await service.transition(txn.id, 'submit', 'worker-1');
    expect(state).toBe('posted');
    expect(inventoryMock.recordMovement).toHaveBeenCalledWith('wh-1', 'p-1', 10, 'receipt', 'warehouse_transaction', txn.id, 'worker-1', expect.anything());
  });

  it('an issue requires a real approve step by a supervisor — submit alone does not post it', async () => {
    const txn = await service.createTransaction('issue', 'wh-1', null, [{ productId: 'p-1', quantity: 5 }], null, null, null, 'worker-1');
    const afterSubmit = await service.transition(txn.id, 'submit', 'worker-1');
    expect(afterSubmit).toBe('submitted');
    expect(inventoryMock.recordMovement).not.toHaveBeenCalled();

    const afterApprove = await service.transition(txn.id, 'approve', 'supervisor-1');
    expect(afterApprove).toBe('posted');
    expect(inventoryMock.recordMovement).toHaveBeenCalledWith('wh-1', 'p-1', -5, 'dispatch', 'warehouse_transaction', txn.id, 'supervisor-1', expect.anything());
  });

  it('a plain warehouse_worker cannot approve — that role requires warehouse_supervisor/inventory_controller/admin', async () => {
    const txn = await service.createTransaction('issue', 'wh-1', null, [{ productId: 'p-1', quantity: 5 }], null, null, null, 'worker-1');
    await service.transition(txn.id, 'submit', 'worker-1');
    await expect(service.transition(txn.id, 'approve', 'worker-1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('blocks posting an issue that would exceed available stock, and — this was a real bug — leaves the transaction at "approved", never falsely "posted"', async () => {
    inventoryMock.getAvailableInTransaction.mockResolvedValueOnce(3);
    const txn = await service.createTransaction('issue', 'wh-1', null, [{ productId: 'p-1', quantity: 5 }], null, null, null, 'worker-1');
    await service.transition(txn.id, 'submit', 'worker-1');
    await expect(service.transition(txn.id, 'approve', 'supervisor-1')).rejects.toBeInstanceOf(ConflictException);

    const stateAfterFailedApproval = await (await service.getTransaction(txn.id)).state;
    expect(stateAfterFailedApproval).toBe('approved'); // NOT 'posted' — no movement was actually recorded
    expect(inventoryMock.recordMovement).not.toHaveBeenCalled();
  });

  it('multi-line: a shortage on line 2 blocks the WHOLE document — line 1 (which alone would pass) is never posted either (Warehouse & Inventory Control V1 handover, §0)', async () => {
    inventoryMock.getAvailableInTransaction.mockImplementation(async (_manager: unknown, _warehouseId: string, productId: string) =>
      productId === 'p-2' ? 1 : 50, // p-1 has plenty (10 requested); p-2 is short (needs 5, only 1 available)
    );
    const txn = await service.createTransaction(
      'issue',
      'wh-1',
      null,
      [
        { productId: 'p-1', quantity: 10 },
        { productId: 'p-2', quantity: 5 },
      ],
      null,
      null,
      null,
      'worker-1',
    );
    await service.transition(txn.id, 'submit', 'worker-1');
    await expect(service.transition(txn.id, 'approve', 'supervisor-1')).rejects.toBeInstanceOf(ConflictException);

    // No first-line-only logic: line 1's shortfall-free movement was NOT
    // written just because line 2 failed — the whole document is atomic.
    expect(inventoryMock.recordMovement).not.toHaveBeenCalled();
    const state = await (await service.getTransaction(txn.id)).state;
    expect(state).toBe('approved'); // not falsely 'posted'
  });

  it('the shortage error names every failing line with requested/available/shortfall, not just the first one', async () => {
    inventoryMock.getAvailableInTransaction.mockImplementation(async (_manager: unknown, _warehouseId: string, productId: string) =>
      (productId === 'p-1' ? 2 : 1),
    );
    const txn = await service.createTransaction(
      'issue',
      'wh-1',
      null,
      [
        { productId: 'p-1', quantity: 10 }, // short by 8
        { productId: 'p-2', quantity: 5 }, // short by 4
      ],
      null,
      null,
      null,
      'worker-1',
    );
    await service.transition(txn.id, 'submit', 'worker-1');
    await expect(service.transition(txn.id, 'approve', 'supervisor-1')).rejects.toMatchObject({
      message: expect.stringMatching(/2 line\(s\).*requested 10, available 2, short by 8.*requested 5, available 1, short by 4/s),
    });
  });

  it('locks every distinct (warehouse, product) pair touched, sorted, before checking or writing anything', async () => {
    const txn = await service.createTransaction(
      'transfer',
      'wh-1',
      'wh-2',
      [
        { productId: 'p-2', quantity: 1 },
        { productId: 'p-1', quantity: 1 },
      ],
      null,
      null,
      null,
      'worker-1',
    );
    await service.transition(txn.id, 'submit', 'worker-1');
    await service.transition(txn.id, 'approve', 'supervisor-1');
    expect(lockCalls).toEqual(['wh-1:p-1', 'wh-1:p-2', 'wh-2:p-1', 'wh-2:p-2']); // lexicographically sorted, deadlock-safe
  });

  it('retrying via the standalone "post" action succeeds once stock is available again, without needing to re-approve', async () => {
    inventoryMock.getAvailableInTransaction.mockResolvedValueOnce(3); // first attempt fails
    const txn = await service.createTransaction('issue', 'wh-1', null, [{ productId: 'p-1', quantity: 5 }], null, null, null, 'worker-1');
    await service.transition(txn.id, 'submit', 'worker-1');
    await expect(service.transition(txn.id, 'approve', 'supervisor-1')).rejects.toBeInstanceOf(ConflictException);

    // stock situation resolved (default mock resolves 50 again) — retry with 'post', not 'approve'
    const state = await service.transition(txn.id, 'post', 'supervisor-1');
    expect(state).toBe('posted');
    expect(inventoryMock.recordMovement).toHaveBeenCalledWith('wh-1', 'p-1', -5, 'dispatch', 'warehouse_transaction', txn.id, 'supervisor-1', expect.anything());
  });

  it('a transfer posts both a transfer_out at the source and a transfer_in at the destination', async () => {
    const txn = await service.createTransaction('transfer', 'wh-1', 'wh-2', [{ productId: 'p-1', quantity: 7 }], null, null, null, 'worker-1');
    await service.transition(txn.id, 'submit', 'worker-1');
    await service.transition(txn.id, 'approve', 'supervisor-1');
    expect(inventoryMock.recordMovement).toHaveBeenCalledWith('wh-1', 'p-1', -7, 'transfer_out', 'warehouse_transaction', txn.id, 'supervisor-1', expect.anything());
    expect(inventoryMock.recordMovement).toHaveBeenCalledWith('wh-2', 'p-1', 7, 'transfer_in', 'warehouse_transaction', txn.id, 'supervisor-1', expect.anything());
  });

  it('rejects a transfer with no destination warehouse', async () => {
    await expect(
      service.createTransaction('transfer', 'wh-1', null, [{ productId: 'p-1', quantity: 1 }], null, null, null, 'worker-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  describe('warehouse active/inactive (Warehouse ERP V1 / Phase 1 Integration, §3)', () => {
    it('rejects creating a transaction against an inactive source warehouse', async () => {
      inventoryMock.getWarehouse.mockResolvedValueOnce({ id: 'wh-1', code: 'WH-1', status: 'inactive' });
      await expect(
        service.createTransaction('receipt', 'wh-1', null, [{ productId: 'p-1', quantity: 1 }], null, null, null, 'worker-1'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects a transfer whose DESTINATION warehouse is inactive, even though the source is active', async () => {
      inventoryMock.getWarehouse.mockImplementation(async (id: string) => ({
        id,
        code: id,
        status: id === 'wh-2' ? 'inactive' : 'active',
      }));
      await expect(
        service.createTransaction('transfer', 'wh-1', 'wh-2', [{ productId: 'p-1', quantity: 1 }], null, null, null, 'worker-1'),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  it('defaults movementDate to now, but honors an explicit backdated value (§13)', async () => {
    const backdated = new Date('2026-01-05T00:00:00.000Z');
    const txn = await service.createTransaction(
      'receipt',
      'wh-1',
      null,
      [{ productId: 'p-1', quantity: 1 }],
      null,
      null,
      null,
      'worker-1',
      backdated,
    );
    expect(txn.movementDate).toEqual(backdated);

    const undated = await service.createTransaction('receipt', 'wh-1', null, [{ productId: 'p-1', quantity: 1 }], null, null, null, 'worker-1');
    expect(undated.movementDate.getTime()).toBeGreaterThan(Date.now() - 5000);
  });

  describe('stock count', () => {
    it('snapshots system quantity at count start, computes variance from the recorded physical count, and posts only the non-zero lines as adjustments', async () => {
      const txn = await service.startCount('wh-1', ['p-1', 'p-2'], 'worker-1');
      const createdLines = await service.getLines(txn.id);
      expect(createdLines.every((l) => l.systemQuantity === 50)).toBe(true);

      await service.recordCountResults(txn.id, [
        { lineId: createdLines[0].id, physicalQuantity: 48 }, // shortage of 2
        { lineId: createdLines[1].id, physicalQuantity: 50 }, // exact match — no variance
      ]);

      await service.transition(txn.id, 'submit', 'worker-1');
      await service.transition(txn.id, 'approve', 'supervisor-1');

      expect(inventoryMock.recordMovement).toHaveBeenCalledWith('wh-1', 'p-1', -2, 'adjustment', 'warehouse_transaction', txn.id, 'supervisor-1', expect.anything());
      expect(inventoryMock.recordMovement).not.toHaveBeenCalledWith('wh-1', 'p-2', 0, 'adjustment', expect.anything(), expect.anything(), expect.anything());
    });

    it('refuses to submit a count until every line has a physical quantity recorded', async () => {
      const txn = await service.startCount('wh-1', ['p-1'], 'worker-1');
      await expect(service.transition(txn.id, 'submit', 'worker-1')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('getOverview', () => {
    it('computes every figure from real data — no fabricated low-stock/valuation numbers', async () => {
      const receipt = await service.createTransaction('receipt', 'wh-1', null, [{ productId: 'p-1', quantity: 5 }], null, null, null, 'worker-1');
      await service.transition(receipt.id, 'submit', 'worker-1'); // posted
      const issue = await service.createTransaction('issue', 'wh-1', null, [{ productId: 'p-1', quantity: 3 }], null, null, null, 'worker-1');
      await service.transition(issue.id, 'submit', 'worker-1'); // submitted, awaiting approval

      const overview = await service.getOverview();

      expect(overview.totalWarehouses).toBe(2);
      // stockReport: wh-1/p-1 onHand=100*10 + wh-1/p-2 onHand=-5*20 = 1000 - 100 = 900
      expect(overview.totalInventoryValueAtSellingPrice).toBe('900.00');
      expect(overview.todaysMovementsCount).toBe(2);
      expect(overview.reservedStockUnits).toBe(10);
      expect(overview.pendingApprovalsCount).toBe(1); // the issue, still submitted
      expect(overview.negativeStockItems).toEqual([{ warehouseId: 'wh-1', productId: 'p-2', onHand: -5 }]);
    });
  });

  describe('listTransactionsPage (pagination audit fix, MASTER_PROJECT_STATUS.md §6 — offset/limit math and total-under-filters, on top of the same warehouseId/type filters as listTransactions)', () => {
    it('paginates correctly: disjoint pages, and total reflects the full filtered set, not just the page', async () => {
      for (let i = 0; i < 5; i++) {
        await service.createTransaction('receipt', 'wh-1', null, [{ productId: 'p-1', quantity: 1 }], null, null, null, 'worker-1');
      }
      const page1 = await service.listTransactionsPage({ page: 1, pageSize: 2 });
      const page2 = await service.listTransactionsPage({ page: 2, pageSize: 2 });
      const page3 = await service.listTransactionsPage({ page: 3, pageSize: 2 });

      expect(page1.total).toBe(5);
      expect(page2.total).toBe(5);
      expect(page1.rows).toHaveLength(2);
      expect(page2.rows).toHaveLength(2);
      expect(page3.rows).toHaveLength(1);
      const page1Ids = page1.rows.map((t) => t.id);
      const page2Ids = page2.rows.map((t) => t.id);
      expect(page1Ids.some((id) => page2Ids.includes(id))).toBe(false);
      expect(page1.rows[0].state).toBeDefined(); // still enriched with process-engine state, same as listTransactions
    });

    it('total stays accurate under the warehouseId/type filters, not just the unfiltered count', async () => {
      await service.createTransaction('receipt', 'wh-1', null, [{ productId: 'p-1', quantity: 1 }], null, null, null, 'worker-1');
      await service.createTransaction('receipt', 'wh-1', null, [{ productId: 'p-1', quantity: 1 }], null, null, null, 'worker-1');
      await service.createTransaction('issue', 'wh-1', null, [{ productId: 'p-1', quantity: 1 }], null, null, null, 'worker-1');
      await service.createTransaction('receipt', 'wh-2', null, [{ productId: 'p-1', quantity: 1 }], null, null, null, 'worker-1');

      const receiptsOnly = await service.listTransactionsPage({ type: 'receipt', page: 1, pageSize: 50 });
      expect(receiptsOnly.total).toBe(3);
      expect(receiptsOnly.rows.every((t) => t.type === 'receipt')).toBe(true);

      const wh2Only = await service.listTransactionsPage({ warehouseId: 'wh-2', page: 1, pageSize: 50 });
      expect(wh2Only.total).toBe(1);
    });
  });

  describe('reversal', () => {
    it('reverses a posted receipt by creating a NEW linked transaction with negated quantities, leaving the original as reversed (not deleted)', async () => {
      const original = await service.createTransaction('receipt', 'wh-1', null, [{ productId: 'p-1', quantity: 20 }], null, null, null, 'worker-1');
      await service.transition(original.id, 'submit', 'worker-1');
      inventoryMock.recordMovement.mockClear();

      const state = await service.transition(original.id, 'reverse', 'supervisor-1');
      expect(state).toBe('reversed');
      expect(inventoryMock.recordMovement).toHaveBeenCalledWith('wh-1', 'p-1', -20, 'receipt', 'warehouse_transaction', expect.any(String), 'supervisor-1', expect.anything());

      const allTxns = [...transactions.values()];
      const reversalTxn = allTxns.find((t) => t.reversalOfTransactionId === original.id);
      expect(reversalTxn).toBeDefined();
      expect(reversalTxn!.id).not.toBe(original.id);
    });

    it('rejects reversing a transaction that was never posted', async () => {
      const txn = await service.createTransaction('receipt', 'wh-1', null, [{ productId: 'p-1', quantity: 1 }], null, null, null, 'worker-1');
      await expect(service.transition(txn.id, 'reverse', 'supervisor-1')).rejects.toBeInstanceOf(ConflictException);
    });
  });
});
