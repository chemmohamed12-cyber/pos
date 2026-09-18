import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { NumberingService } from './numbering.service';

/**
 * The invariants that matter per CTO Execution Policy §5 and ADR-007's
 * TD-29 fix: sequential issuance, year rollover, and the reconciliation
 * method never moving the counter backward.
 */
describe('NumberingService', () => {
  let service: NumberingService;
  let sequenceRow: { documentType: string; prefix: string; includeYear: boolean; lastNumber: number; lastYear: number | null };

  const managerMock = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      if (sql.startsWith('SELECT')) {
        return [sequenceRow];
      }
      if (sql.includes('SET "lastNumber" = $1, "lastYear" = $2')) {
        const [lastNumber, lastYear] = params as [number, number];
        sequenceRow.lastNumber = lastNumber;
        sequenceRow.lastYear = lastYear;
        return [];
      }
      if (sql.includes('GREATEST')) {
        const [observedMax] = params as [number];
        sequenceRow.lastNumber = Math.max(sequenceRow.lastNumber, observedMax);
        return [];
      }
      return [];
    }),
  };

  const dataSourceMock = {
    transaction: jest.fn(async (fn: (manager: typeof managerMock) => Promise<unknown>) => fn(managerMock)),
    getRepository: jest.fn(),
  };

  beforeEach(async () => {
    const currentYear = new Date().getFullYear();
    sequenceRow = { documentType: 'sales_order', prefix: 'SO', includeYear: true, lastNumber: 0, lastYear: currentYear };
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [NumberingService, { provide: DataSource, useValue: dataSourceMock }],
    }).compile();
    service = moduleRef.get(NumberingService);
  });

  it('issues sequential numbers with the correct prefix and year', async () => {
    const currentYear = new Date().getFullYear();
    const first = await service.getNextNumber('sales_order');
    const second = await service.getNextNumber('sales_order');
    expect(first).toBe(`SO-${currentYear}-000001`);
    expect(second).toBe(`SO-${currentYear}-000002`);
  });

  it('resets the running count on year rollover', async () => {
    sequenceRow.lastNumber = 42;
    sequenceRow.lastYear = new Date().getFullYear() - 1; // a stale prior year
    const result = await service.getNextNumber('sales_order');
    expect(result).toBe(`SO-${new Date().getFullYear()}-000001`);
  });

  it('throws for an unregistered document type', async () => {
    dataSourceMock.transaction.mockImplementationOnce(async (fn: (manager: typeof managerMock) => Promise<unknown>) =>
      fn({ query: jest.fn(async () => []) } as unknown as typeof managerMock),
    );
    await expect(service.getNextNumber('unknown_type')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('reconciliation bumps the counter forward when the registry undercounts (TD-29 fix)', async () => {
    sequenceRow.lastNumber = 5;
    await service.reconcileAgainstObservedMax('sales_order', 100);
    expect(sequenceRow.lastNumber).toBe(100);
  });

  it('reconciliation never moves the counter backward', async () => {
    sequenceRow.lastNumber = 200;
    await service.reconcileAgainstObservedMax('sales_order', 50);
    expect(sequenceRow.lastNumber).toBe(200);
  });
});
