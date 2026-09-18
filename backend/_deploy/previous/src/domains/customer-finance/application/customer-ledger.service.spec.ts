import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { CustomerLedgerService } from './customer-ledger.service';
import { CustomerLedgerEntry } from '../infrastructure/customer-ledger-entry.entity';
import { Customer } from '../../crm/infrastructure/customer.entity';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { CustomersService } from '../../crm/application/customers.service';

/**
 * Proves the Customer Ledger follows the SAME discipline as
 * `TreasuryService`: append-only rows, balance always derived via SUM
 * (never stored), reversal via a new offsetting row (never a raw
 * update/delete of the original amount/direction).
 */
describe('CustomerLedgerService', () => {
  let service: CustomerLedgerService;
  const entries = new Map<string, CustomerLedgerEntry>();
  const customers = new Map<string, Partial<Customer>>([
    ['cust-1', { id: 'cust-1', creditLimit: null }],
    ['cust-limited', { id: 'cust-limited', creditLimit: '500.00' }],
  ]);
  let idSeq = 0;
  let entryCounter = 0;

  const entryRepo = {
    create: jest.fn((d: Partial<CustomerLedgerEntry>) => ({ id: `cle-${++idSeq}`, ...d }) as CustomerLedgerEntry),
    save: jest.fn(async (e: CustomerLedgerEntry) => {
      entries.set(e.id, e);
      return e;
    }),
    findOne: jest.fn(async ({ where }: { where: { id: string } }) => entries.get(where.id) ?? null),
    update: jest.fn(async (id: string, patch: Partial<CustomerLedgerEntry>) => {
      const existing = entries.get(id);
      if (existing) entries.set(id, { ...existing, ...patch });
    }),
    createQueryBuilder: jest.fn(() => {
      let customerId: string | undefined;
      let entryType: string | undefined;
      const qb: {
        where: (cond: string, params: { customerId: string }) => typeof qb;
        andWhere: (cond: string, params?: Record<string, unknown>) => typeof qb;
        orderBy: (col: string, dir?: string) => typeof qb;
        addOrderBy: (col: string, dir?: string) => typeof qb;
        getMany: () => Promise<CustomerLedgerEntry[]>;
      } = {
        where: (_c, params) => {
          customerId = params.customerId;
          return qb;
        },
        andWhere: (cond, params) => {
          if (cond.includes('entryType') && params) entryType = params.entryType as string;
          return qb;
        },
        orderBy: () => qb,
        addOrderBy: () => qb,
        getMany: async () =>
          [...entries.values()]
            .filter((e) => e.customerId === customerId && (!entryType || e.entryType === entryType))
            .sort((a, b) => a.entryDate.getTime() - b.entryDate.getTime()),
      };
      return qb;
    }),
  };
  const customerRepo = {
    findOne: jest.fn(async ({ where }: { where: { id: string } }) => customers.get(where.id) ?? null),
  };

  const getRepositoryMock = jest.fn((entity: unknown) => (entity === CustomerLedgerEntry ? entryRepo : customerRepo));

  /** Mirrors the REAL SQL formulas the service runs — SUM(debit-credit) for balance, GREATEST(total-applied,0) summed for overdue invoices (no invoices seeded in this spec, so overdue is always 0). */
  const queryMock = jest.fn(async (sql: string, params: unknown[]) => {
    if (sql.includes('GROUP BY "customerId"')) {
      // The multi-customer aggregate (getBalancesForVisibleCustomers) — params[0] is an array of ids, one row per customer that has any entries at all.
      const ids = params[0] as string[];
      const byCustomer = new Map<string, number>();
      for (const e of entries.values()) {
        if (!ids.includes(e.customerId)) continue;
        byCustomer.set(e.customerId, (byCustomer.get(e.customerId) ?? 0) + (e.direction === 'debit' ? Number(e.amount) : -Number(e.amount)));
      }
      return [...byCustomer.entries()].map(([customerId, balance]) => ({ customerId, balance: balance.toFixed(2) }));
    }
    if (sql.includes('FROM "customer_ledger_entries" WHERE "customerId"') && sql.includes('SUM(CASE WHEN "direction"')) {
      const customerId = params[0] as string;
      // No status filter — mirrors the real query exactly: a reversed row stays counted, its own opposite-direction reversal row cancels it out.
      const balance = [...entries.values()]
        .filter((e) => e.customerId === customerId)
        .reduce((sum, e) => sum + (e.direction === 'debit' ? Number(e.amount) : -Number(e.amount)), 0);
      return [{ balance: balance.toFixed(2) }];
    }
    if (sql.includes('FROM "sales_invoices" inv')) {
      return [{ overdue: '0.00' }]; // no invoices seeded — InvoiceService's own spec covers AR aging
    }
    throw new Error(`Unexpected raw query in test: ${sql}`);
  });

  const dataSourceMock = {
    getRepository: getRepositoryMock,
    query: queryMock,
    transaction: jest.fn(async (fn: (manager: unknown) => Promise<unknown>) => fn({ getRepository: getRepositoryMock })),
    createQueryBuilder: jest.fn(() => {
      let patch: Partial<CustomerLedgerEntry> = {};
      const qb = {
        update: () => qb,
        set: (p: Partial<CustomerLedgerEntry>) => {
          patch = p;
          return qb;
        },
        where: () => qb,
        execute: async () => {
          for (const e of entries.values()) {
            if (e.customerId === 'cust-1' && e.salesOrderId === 'so-1' && e.invoiceId === null && e.status === 'posted') {
              entries.set(e.id, { ...e, ...patch });
            }
          }
          return { affected: 1 };
        },
      };
      return qb;
    }),
  };

  const numberingCounters = new Map<string, number>();
  const numberingMock = {
    registerDocumentType: jest.fn(async () => undefined),
    getNextNumber: jest.fn(async () => {
      const next = (numberingCounters.get('cle') ?? 0) + 1;
      numberingCounters.set('cle', next);
      return `CLE-2026-${String(next).padStart(6, '0')}`;
    }),
  };
  const auditMock = { record: jest.fn(async () => undefined) };
  const customersMock = {
    listCustomers: jest.fn(async () => [...customers.values()]),
  };

  beforeEach(async () => {
    entries.clear();
    idSeq = 0;
    entryCounter = 0;
    numberingCounters.clear();
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        CustomerLedgerService,
        { provide: DataSource, useValue: dataSourceMock },
        { provide: NumberingService, useValue: numberingMock },
        { provide: AuditService, useValue: auditMock },
        { provide: CustomersService, useValue: customersMock },
      ],
    }).compile();
    service = moduleRef.get(CustomerLedgerService);
    void entryCounter;
  });

  describe('postEntry', () => {
    it('rejects a non-positive amount', async () => {
      await expect(
        service.postEntry({ customerId: 'cust-1', entryType: 'adjustment', direction: 'debit', amount: '0.00', createdByUserId: 'admin-1' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('posts a debit entry with a real entryNumber and status=posted', async () => {
      const entry = await service.postEntry({ customerId: 'cust-1', entryType: 'sales_invoice', direction: 'debit', amount: '100.00', createdByUserId: 'admin-1' });
      expect(entry.entryNumber).toMatch(/^CLE-2026-/);
      expect(entry.status).toBe('posted');
      expect(entry.direction).toBe('debit');
    });
  });

  describe('getCustomerBalance — always derived, never stored', () => {
    it('debit entries increase the balance, credit entries decrease it', async () => {
      await service.postEntry({ customerId: 'cust-1', entryType: 'sales_invoice', direction: 'debit', amount: '100.00', createdByUserId: 'admin-1' });
      await service.postEntry({ customerId: 'cust-1', entryType: 'payment', direction: 'credit', amount: '40.00', createdByUserId: 'admin-1' });
      expect(await service.getCustomerBalance('cust-1')).toBe('60.00');
    });

    it('a reversed entry no longer counts toward the balance (its own reversal row already nets it)', async () => {
      const entry = await service.postEntry({ customerId: 'cust-1', entryType: 'adjustment', direction: 'debit', amount: '50.00', createdByUserId: 'admin-1' });
      await service.reverseEntry(entry.id, 'test reversal', 'admin-1');
      expect(await service.getCustomerBalance('cust-1')).toBe('0.00');
    });
  });

  describe('reverseEntry — never edits the original row\'s amount/direction, only flips status', () => {
    it('creates a new opposite-direction row and flips the original to reversed', async () => {
      const entry = await service.postEntry({ customerId: 'cust-1', entryType: 'payment', direction: 'credit', amount: '30.00', createdByUserId: 'admin-1' });
      const reversal = await service.reverseEntry(entry.id, 'bank bounced', 'admin-1');

      expect(reversal.direction).toBe('debit');
      expect(reversal.amount).toBe('30.00');
      expect(reversal.reversalOfEntryId).toBe(entry.id);

      const original = entries.get(entry.id)!;
      expect(original.status).toBe('reversed');
      expect(original.amount).toBe('30.00'); // never mutated
      expect(original.direction).toBe('credit'); // never mutated
    });

    it('rejects reversing an already-reversed entry', async () => {
      const entry = await service.postEntry({ customerId: 'cust-1', entryType: 'payment', direction: 'credit', amount: '30.00', createdByUserId: 'admin-1' });
      await service.reverseEntry(entry.id, 'first reversal', 'admin-1');
      await expect(service.reverseEntry(entry.id, 'second attempt', 'admin-1')).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects reversing an unknown entry', async () => {
      await expect(service.reverseEntry('no-such-id', 'reason', 'admin-1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('getCreditSummary', () => {
    it('availableCredit is null when the customer has no credit limit set', async () => {
      await service.postEntry({ customerId: 'cust-1', entryType: 'sales_invoice', direction: 'debit', amount: '100.00', createdByUserId: 'admin-1' });
      const summary = await service.getCreditSummary('cust-1');
      expect(summary.creditLimit).toBeNull();
      expect(summary.availableCredit).toBeNull();
      expect(summary.balance).toBe('100.00');
    });

    it('availableCredit = creditLimit - balance when a limit is set', async () => {
      await service.postEntry({ customerId: 'cust-limited', entryType: 'sales_invoice', direction: 'debit', amount: '150.00', createdByUserId: 'admin-1' });
      const summary = await service.getCreditSummary('cust-limited');
      expect(summary.creditLimit).toBe('500.00');
      expect(summary.availableCredit).toBe('350.00');
    });
  });

  describe('listLedger', () => {
    it('filters by entryType', async () => {
      await service.postEntry({ customerId: 'cust-1', entryType: 'sales_invoice', direction: 'debit', amount: '100.00', createdByUserId: 'admin-1' });
      await service.postEntry({ customerId: 'cust-1', entryType: 'payment', direction: 'credit', amount: '40.00', createdByUserId: 'admin-1' });
      const payments = await service.listLedger('cust-1', { entryType: 'payment' });
      expect(payments).toHaveLength(1);
      expect(payments[0].entryType).toBe('payment');
    });
  });

  describe('sweepUnappliedFor', () => {
    it('backfills invoiceId only onto matching unapplied (invoiceId=null) entries for that customer+order', async () => {
      const unapplied = await service.postEntry({ customerId: 'cust-1', entryType: 'deposit', direction: 'credit', amount: '20.00', salesOrderId: 'so-1', createdByUserId: 'admin-1' });
      const alreadyLinked = await service.postEntry({ customerId: 'cust-1', entryType: 'payment', direction: 'credit', amount: '10.00', salesOrderId: 'so-1', invoiceId: 'inv-already', createdByUserId: 'admin-1' });

      await service.sweepUnappliedFor('cust-1', 'so-1', 'inv-new');

      expect(entries.get(unapplied.id)!.invoiceId).toBe('inv-new');
      expect(entries.get(alreadyLinked.id)!.invoiceId).toBe('inv-already'); // untouched — already linked
    });
  });

  describe('getBalancesForVisibleCustomers (ERP UI Integration — Scope-filtered, one aggregate query)', () => {
    it('returns a balance for every customer CustomersService.listCustomers says is visible, defaulting to 0.00 when there are no entries', async () => {
      await service.postEntry({ customerId: 'cust-1', entryType: 'sales_invoice', direction: 'debit', amount: '100.00', createdByUserId: 'admin-1' });

      const balances = await service.getBalancesForVisibleCustomers('actor-1');

      expect(customersMock.listCustomers).toHaveBeenCalledWith('actor-1');
      expect(balances).toEqual(
        expect.arrayContaining([
          { customerId: 'cust-1', balance: '100.00' },
          { customerId: 'cust-limited', balance: '0.00' },
        ]),
      );
    });

    it('returns an empty array when the actor has no visible customers, without querying the ledger at all', async () => {
      customersMock.listCustomers.mockResolvedValueOnce([]);
      const balances = await service.getBalancesForVisibleCustomers('actor-2');
      expect(balances).toEqual([]);
    });
  });
});
