import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ClosingSnapshotService } from './closing-snapshot.service';
import { ClosingSnapshotRun } from '../infrastructure/closing-snapshot-run.entity';
import { FiscalPeriod } from '../infrastructure/fiscal-period.entity';
import { FiscalYear } from '../infrastructure/fiscal-year.entity';
import { ClosingException } from '../infrastructure/closing-exception.entity';
import { FinancialEvent } from '../infrastructure/financial-event.entity';

/**
 * Multi-Company Area 9 (2026-09-22) — proves the `manager?` retrofit is
 * REAL, not cosmetic: when a Company-scoped `manager` is supplied, NOT ONE
 * DB touchpoint in `retryPending`/`detectOverdue`/`assembleAndFinalize`/
 * `assembleBody` falls back to the ambient `dataSource` — the ambient
 * `dataSource` mock below throws on every method, so any accidental
 * fallback fails the test loudly instead of silently reading/writing the
 * wrong Company's data.
 */
const AMBIENT_TOUCHED = 'AMBIENT DATASOURCE TOUCHED — must use the supplied Company manager';

function poisonedDataSource() {
  return {
    getRepository: jest.fn(() => {
      throw new Error(AMBIENT_TOUCHED);
    }),
    query: jest.fn(() => {
      throw new Error(AMBIENT_TOUCHED);
    }),
  };
}

function fakeRepo<T extends { id: string }>(rows: Map<string, T>) {
  return {
    find: jest.fn(async (opts?: { where?: Record<string, unknown> }) => {
      const where = opts?.where ?? {};
      return [...rows.values()].filter((r) => Object.entries(where).every(([k, v]) => (r as never)[k] === v || v === undefined));
    }),
    findOne: jest.fn(async (opts: { where: { id?: string } }) => rows.get(opts.where.id ?? '') ?? null),
    findOneOrFail: jest.fn(async (opts: { where: { id?: string } }) => {
      const found = rows.get(opts.where.id ?? '');
      if (!found) throw new Error('not found');
      return found;
    }),
    save: jest.fn(async (row: T) => {
      rows.set(row.id, row);
      return row;
    }),
    count: jest.fn(async () => 0),
    createQueryBuilder: jest.fn(() => {
      const qb: { where: jest.Mock; andWhere: jest.Mock; getMany: jest.Mock } = {
        where: jest.fn(() => qb),
        andWhere: jest.fn(() => qb),
        getMany: jest.fn(async () => [...rows.values()].filter((r) => (r as unknown as { status: string }).status !== 'complete')),
      };
      return qb;
    }),
  };
}

describe('ClosingSnapshotService — Multi-Company Area 9 (manager? threading, no ambient fallback)', () => {
  let tmpDir: string;
  let service: ClosingSnapshotService;
  let runs: Map<string, ClosingSnapshotRun>;
  let manager: { getRepository: jest.Mock; query: jest.Mock };

  const customerLedgerMock = { getAllCustomerBalances: jest.fn(async () => ({ balances: [], total: '0' })) };
  const treasuryMock = { getAllTreasuryBalances: jest.fn(async () => ({ balances: [] })) };
  const supplierLedgerMock = { getAllSupplierBalances: jest.fn(async () => ({ balances: [], total: '0' })) };
  const inventoryValuationMock = { getValuedOnHandTotal: jest.fn(async () => []) };
  const manufacturingWipMock = { getAllWipBalances: jest.fn(async () => ({ balances: [], total: '0' })) };
  const ledgerMock = { getTrialBalance: jest.fn(async () => ({ rows: [], totalDebitBase: '0', totalCreditBase: '0', balanced: true })) };
  const signingKeysMock = { sign: jest.fn(() => ({ kid: 'key-1', signature: 'sig' })), verify: jest.fn() };
  const auditMock = { record: jest.fn(async () => undefined) };

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'closing-snapshot-area9-'));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    jest.clearAllMocks();

    const period: FiscalPeriod = { id: 'period-1', fiscalYearId: 'year-1', code: 'P1', startDate: '2026-01-01', endDate: '2026-01-31' } as FiscalPeriod;
    const year: FiscalYear = { id: 'year-1', code: 'Y1', startDate: '2026-01-01', endDate: '2026-12-31', orgUnitId: null } as FiscalYear;
    const run: ClosingSnapshotRun = {
      id: 'run-1',
      fiscalPeriodId: 'period-1',
      closeSequence: 1,
      supersedesSnapshotId: null,
      approvalRequestId: 'approval-1',
      status: 'pending',
      generatedByUserId: 'user-1',
      createdAt: new Date(),
    } as ClosingSnapshotRun;
    runs = new Map([['run-1', run]]);

    const periodRepo = fakeRepo<FiscalPeriod>(new Map([['period-1', period]]));
    const yearRepo = fakeRepo<FiscalYear>(new Map([['year-1', year]]));
    const runRepo = fakeRepo<ClosingSnapshotRun>(runs);
    const exceptionRepo = fakeRepo<ClosingException>(new Map());
    const eventRepo = fakeRepo<FinancialEvent>(new Map());

    manager = {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === ClosingSnapshotRun) return runRepo;
        if (entity === FiscalPeriod) return periodRepo;
        if (entity === FiscalYear) return yearRepo;
        if (entity === ClosingException) return exceptionRepo;
        if (entity === FinancialEvent) return eventRepo;
        throw new Error(`unexpected entity in test: ${String(entity)}`);
      }),
      query: jest.fn(async () => [{ name: 'migration-head' }]),
    };

    service = new ClosingSnapshotService(
      poisonedDataSource() as never,
      ledgerMock as never,
      signingKeysMock as never,
      auditMock as never,
      { mediaStoragePath: tmpDir } as never,
      customerLedgerMock as never,
      treasuryMock as never,
      supplierLedgerMock as never,
      inventoryValuationMock as never,
      manufacturingWipMock as never,
    );
  });

  it('assembleAndFinalize forwards the manager to every subledger contract, LedgerService, and AuditService — never the ambient dataSource', async () => {
    await service.assembleAndFinalize('run-1', manager as never);

    expect(ledgerMock.getTrialBalance).toHaveBeenCalledWith(expect.any(Object), manager);
    expect(customerLedgerMock.getAllCustomerBalances).toHaveBeenCalledWith(expect.any(String), manager);
    expect(treasuryMock.getAllTreasuryBalances).toHaveBeenCalledWith(expect.any(String), manager);
    expect(supplierLedgerMock.getAllSupplierBalances).toHaveBeenCalledWith(expect.any(String), manager);
    expect(inventoryValuationMock.getValuedOnHandTotal).toHaveBeenCalledWith(expect.any(String), manager);
    expect(manufacturingWipMock.getAllWipBalances).toHaveBeenCalledWith(expect.any(String), manager);
    expect(auditMock.record).toHaveBeenCalledWith(expect.any(Object), manager);
    expect(manager.getRepository).toHaveBeenCalledWith(ClosingSnapshotRun);
    expect(manager.getRepository).toHaveBeenCalledWith(FiscalPeriod);
    expect(manager.getRepository).toHaveBeenCalledWith(FiscalYear);

    const saved = runs.get('run-1')!;
    expect(saved.status).toBe('complete');
  });

  it('retryPending forwards the manager into assembleAndFinalize, never touching the ambient dataSource', async () => {
    await service.retryPending(manager as never);

    expect(runs.get('run-1')!.status).toBe('complete');
    expect(customerLedgerMock.getAllCustomerBalances).toHaveBeenCalledWith(expect.any(String), manager);
  });

  it('detectOverdue reads and records via the manager, never the ambient dataSource', async () => {
    const overdue = await service.detectOverdue(10, manager as never);

    expect(overdue).toHaveLength(1);
    expect(auditMock.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'accounting.closing_snapshot.generation_overdue' }), manager);
  });

  it('without a manager, the ambient dataSource IS used (unchanged default behavior for FiscalPeriodService\'s own caller)', async () => {
    // A fresh service instance whose "ambient" dataSource is a real, working fake instead of a poison pill,
    // to prove the DEFAULT (no-manager) path still works exactly as before this retrofit.
    const ambientRunRepo = fakeRepo<ClosingSnapshotRun>(runs);
    const ambientPeriodRepo = fakeRepo<FiscalPeriod>(new Map([['period-1', { id: 'period-1', fiscalYearId: 'year-1', code: 'P1', startDate: '2026-01-01', endDate: '2026-01-31' } as FiscalPeriod]]));
    const ambientYearRepo = fakeRepo<FiscalYear>(new Map([['year-1', { id: 'year-1', code: 'Y1', startDate: '2026-01-01', endDate: '2026-12-31', orgUnitId: null } as FiscalYear]]));
    const ambientExceptionRepo = fakeRepo<ClosingException>(new Map());
    const ambientEventRepo = fakeRepo<FinancialEvent>(new Map());
    const workingAmbientDataSource = {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === ClosingSnapshotRun) return ambientRunRepo;
        if (entity === FiscalPeriod) return ambientPeriodRepo;
        if (entity === FiscalYear) return ambientYearRepo;
        if (entity === ClosingException) return ambientExceptionRepo;
        if (entity === FinancialEvent) return ambientEventRepo;
        throw new Error(`unexpected entity: ${String(entity)}`);
      }),
      query: jest.fn(async () => [{ name: 'migration-head' }]),
    };

    const ambientService = new ClosingSnapshotService(
      workingAmbientDataSource as never,
      ledgerMock as never,
      signingKeysMock as never,
      auditMock as never,
      { mediaStoragePath: tmpDir } as never,
      customerLedgerMock as never,
      treasuryMock as never,
      supplierLedgerMock as never,
      inventoryValuationMock as never,
      manufacturingWipMock as never,
    );

    await ambientService.assembleAndFinalize('run-1');

    expect(customerLedgerMock.getAllCustomerBalances).toHaveBeenCalledWith(expect.any(String), undefined);
    expect(workingAmbientDataSource.getRepository).toHaveBeenCalled();
  });
});
