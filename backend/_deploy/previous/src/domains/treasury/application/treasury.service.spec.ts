import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { TreasuryService } from './treasury.service';
import { TreasuryAccount } from '../infrastructure/treasury-account.entity';
import { TreasuryAccountType } from '../infrastructure/treasury-account-type.entity';
import { TreasuryTransaction } from '../infrastructure/treasury-transaction.entity';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { AuditService } from '../../../foundation/audit/audit.service';

/**
 * Proves the ledger discipline this domain exists to guarantee: balance
 * is always derived from the transaction rows (never stored/edited
 * directly), cash-out/transfer can never overdraw, a Transfer's two legs
 * post atomically, and Reversal is the only correction path (an
 * offsetting row + a status flag — the original row is never mutated).
 */
describe('TreasuryService', () => {
  let service: TreasuryService;
  const accounts = new Map<string, TreasuryAccount>();
  const transactions: TreasuryTransaction[] = [];
  let accountSeq = 0;
  let txnSeq = 0;
  const lockCalls: string[] = [];

  function computeBalance(accountId: string): number {
    return transactions
      .filter((t) => t.treasuryAccountId === accountId)
      .reduce((sum, t) => sum + (t.type === 'cash_in' || t.type === 'transfer_in' ? Number(t.amount) : -Number(t.amount)), 0);
  }

  const accountRepo = {
    create: jest.fn((data: Partial<TreasuryAccount>) => ({ id: `acc-${++accountSeq}`, status: 'active', ...data }) as TreasuryAccount),
    save: jest.fn(async (a: TreasuryAccount) => {
      accounts.set(a.id, a);
      return a;
    }),
    findOne: jest.fn(async ({ where }: { where: { id?: string; code?: string } }) => {
      if (where.id) return accounts.get(where.id) ?? null;
      if (where.code) return [...accounts.values()].find((a) => a.code === where.code) ?? null;
      return null;
    }),
    find: jest.fn(async () => [...accounts.values()]),
  };

  const transactionRepo = {
    create: jest.fn((data: Partial<TreasuryTransaction>) => ({ id: `txn-${++txnSeq}`, status: 'posted', ...data }) as TreasuryTransaction),
    save: jest.fn(async (t: TreasuryTransaction) => {
      transactions.push(t);
      return t;
    }),
    find: jest.fn(async ({ where }: { where: Record<string, string> }) =>
      transactions.filter((t) => Object.entries(where).every(([k, v]) => (t as unknown as Record<string, string>)[k] === v)),
    ),
    // Pagination sibling `listLedgerPage` — same filter shape as `find`
    // above, plus `take`/`skip` slicing and the matching total.
    findAndCount: jest.fn(
      async (opts?: { where?: Record<string, string>; take?: number; skip?: number }) => {
        const filtered = !opts?.where
          ? transactions
          : transactions.filter((t) => Object.entries(opts.where!).every(([k, v]) => (t as unknown as Record<string, string>)[k] === v));
        const skip = opts?.skip ?? 0;
        const take = opts?.take ?? filtered.length;
        return [filtered.slice(skip, skip + take), filtered.length];
      },
    ),
    findOne: jest.fn(async ({ where }: { where: { id: string } }) => transactions.find((t) => t.id === where.id) ?? null),
    update: jest.fn(async (id: string, patch: Partial<TreasuryTransaction>) => {
      const t = transactions.find((x) => x.id === id);
      if (t) Object.assign(t, patch);
    }),
  };

  const CASH_TYPE_ID = 'type-cash';
  const accountTypes = new Map<string, TreasuryAccountType>([[CASH_TYPE_ID, { id: CASH_TYPE_ID, code: 'cash', name: 'Cash', status: 'active', createdAt: new Date() }]]);
  let accountTypeSeq = 0;
  const accountTypeRepo = {
    create: jest.fn((data: Partial<TreasuryAccountType>) => ({ id: `type-${++accountTypeSeq}`, status: 'active', ...data }) as TreasuryAccountType),
    save: jest.fn(async (t: TreasuryAccountType) => {
      accountTypes.set(t.id, t);
      return t;
    }),
    findOne: jest.fn(async ({ where }: { where: { id?: string; code?: string } }) => {
      if (where.id) return accountTypes.get(where.id) ?? null;
      if (where.code) return [...accountTypes.values()].find((t) => t.code === where.code) ?? null;
      return null;
    }),
    find: jest.fn(async () => [...accountTypes.values()]),
  };

  function getRepositoryMock(entity: unknown) {
    if (entity === TreasuryAccount) return accountRepo;
    if (entity === TreasuryAccountType) return accountTypeRepo;
    if (entity === TreasuryTransaction) return transactionRepo;
    throw new Error(`Unexpected entity in test: ${entity}`);
  }

  function queryMock(sql: string, params: string[]) {
    if (sql.includes('pg_advisory_xact_lock')) {
      lockCalls.push(params[0]);
      return Promise.resolve([]);
    }
    if (sql.includes('SUM(CASE')) {
      return Promise.resolve([{ balance: computeBalance(params[0]).toFixed(2) }]);
    }
    throw new Error(`Unexpected query in test: ${sql}`);
  }

  const managerMock = { getRepository: getRepositoryMock, query: queryMock };
  const dataSourceMock = {
    getRepository: getRepositoryMock,
    query: queryMock,
    transaction: jest.fn(async (fn: (manager: unknown) => Promise<unknown>) => fn(managerMock)),
  };

  const numberingMock = { getNextNumber: jest.fn(async (series: string) => `${series.toUpperCase()}-${++txnSeq}`) };
  const auditMock = { record: jest.fn(async () => undefined) };

  beforeEach(async () => {
    accounts.clear();
    transactions.length = 0;
    lockCalls.length = 0;
    accountSeq = 0;
    txnSeq = 0;
    accountTypes.clear();
    accountTypes.set(CASH_TYPE_ID, { id: CASH_TYPE_ID, code: 'cash', name: 'Cash', status: 'active', createdAt: new Date() });
    accountTypeSeq = 0;
    jest.clearAllMocks();
    numberingMock.getNextNumber.mockImplementation(async (series: string) => `${series.toUpperCase()}-${++txnSeq}`);

    const moduleRef = await Test.createTestingModule({
      providers: [
        TreasuryService,
        { provide: DataSource, useValue: dataSourceMock },
        { provide: NumberingService, useValue: numberingMock },
        { provide: AuditService, useValue: auditMock },
      ],
    }).compile();
    service = moduleRef.get(TreasuryService);
  });

  async function seedAccount(code: string): Promise<TreasuryAccount> {
    return service.createAccount(code, `${code} account`, CASH_TYPE_ID, 'admin-1');
  }

  it('creates an account and rejects a duplicate code', async () => {
    await seedAccount('MAIN');
    await expect(seedAccount('MAIN')).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects creating an account against an unknown account type id — never silently accepts an orphan type', async () => {
    await expect(service.createAccount('X', 'X account', 'not-a-real-type', 'admin-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('account types are addable without touching the Treasury Core — createAccountType + listAccountTypes', async () => {
    const type = await service.createAccountType('wallet', 'محافظ', 'admin-1');
    expect(type.code).toBe('wallet');
    const types = await service.listAccountTypes();
    expect(types.map((t) => t.code)).toContain('wallet');
  });

  it('rejects a duplicate account type code', async () => {
    await service.createAccountType('wallet', 'محافظ', 'admin-1');
    await expect(service.createAccountType('wallet', 'Wallets Again', 'admin-1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('balance is derived from the ledger, not stored — cash-in increases it, cash-out decreases it', async () => {
    const account = await seedAccount('MAIN');
    await service.cashIn(account.id, '100.00', null, null, null, null, 'finance-1');
    expect(await service.getAccountBalance(account.id)).toBe('100.00');

    await service.cashOut(account.id, '30.00', null, null, null, null, 'finance-1');
    expect(await service.getAccountBalance(account.id)).toBe('70.00');
  });

  it('rejects cash-out that would overdraw the account, with Requested/Available/Shortfall detail', async () => {
    const account = await seedAccount('MAIN');
    await service.cashIn(account.id, '50.00', null, null, null, null, 'finance-1');
    await expect(service.cashOut(account.id, '80.00', null, null, null, null, 'finance-1')).rejects.toThrow(
      /requested 80\.00, available 50\.00, short by 30\.00/,
    );
    // The rejected attempt must not have moved anything.
    expect(await service.getAccountBalance(account.id)).toBe('50.00');
  });

  it('rejects any new transaction against an inactive account', async () => {
    const account = await seedAccount('MAIN');
    await service.setAccountStatus(account.id, 'inactive', 'admin-1');
    await expect(service.cashIn(account.id, '10.00', null, null, null, null, 'finance-1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('transfer moves the exact amount between two accounts atomically, with sorted advisory-lock ordering', async () => {
    const a = await seedAccount('AAA');
    const b = await seedAccount('ZZZ');
    await service.cashIn(a.id, '100.00', null, null, null, null, 'finance-1');

    lockCalls.length = 0;
    const { out, in: inLeg } = await service.transfer(a.id, b.id, '40.00', 'REF', 'move', 'finance-1');

    expect(await service.getAccountBalance(a.id)).toBe('60.00');
    expect(await service.getAccountBalance(b.id)).toBe('40.00');
    expect(out.transferGroupId).toBe(inLeg.transferGroupId);
    expect(out.type).toBe('transfer_out');
    expect(inLeg.type).toBe('transfer_in');
    // Locks must be acquired in a deterministic (sorted) order regardless of source/destination argument order — deadlock safety.
    expect(lockCalls).toEqual([...lockCalls].sort());
  });

  describe('listLedgerPage (MASTER_PROJECT_STATUS.md §6 pagination audit — Treasury was 1 of the 2 endpoints deferred out of the first pagination pass)', () => {
    it('paginates with correct total and disjoint pages, honoring the same accountId filter as listLedger', async () => {
      const a = await seedAccount('PAGE-A');
      const other = await seedAccount('PAGE-B');
      for (let i = 0; i < 5; i++) {
        await service.cashIn(a.id, '10.00', null, null, null, null, 'finance-1');
      }
      await service.cashIn(other.id, '10.00', null, null, null, null, 'finance-1');

      const pageOne = await service.listLedgerPage({ accountId: a.id }, { page: 1, pageSize: 2 });
      const pageTwo = await service.listLedgerPage({ accountId: a.id }, { page: 2, pageSize: 2 });
      const pageThree = await service.listLedgerPage({ accountId: a.id }, { page: 3, pageSize: 2 });

      expect(pageOne.total).toBe(5); // filtered by accountId, not the 6th transaction on the other account
      expect(pageOne.rows).toHaveLength(2);
      expect(pageTwo.rows).toHaveLength(2);
      expect(pageThree.rows).toHaveLength(1); // partial last page
      const allIds = [...pageOne.rows, ...pageTwo.rows, ...pageThree.rows].map((t) => t.id);
      expect(new Set(allIds).size).toBe(5); // disjoint, no overlap/duplication across pages
    });
  });

  it('rejects a transfer that would overdraw the source account, leaving the destination untouched', async () => {
    const a = await seedAccount('AAA');
    const b = await seedAccount('BBB');
    await service.cashIn(a.id, '10.00', null, null, null, null, 'finance-1');

    await expect(service.transfer(a.id, b.id, '999.00', null, null, 'finance-1')).rejects.toBeInstanceOf(ConflictException);
    expect(await service.getAccountBalance(a.id)).toBe('10.00');
    expect(await service.getAccountBalance(b.id)).toBe('0.00');
  });

  it('createDepositTransaction posts a cash_in leg linked to the deposit/order/customer', async () => {
    const account = await seedAccount('MAIN');
    const txn = await service.createDepositTransaction('dep-1', 'so-1', 'cust-1', '250.00', account.id, 'finance-1');
    expect(txn.type).toBe('cash_in');
    expect(txn.depositId).toBe('dep-1');
    expect(txn.salesOrderId).toBe('so-1');
    expect(txn.customerId).toBe('cust-1');
    expect(await service.getAccountBalance(account.id)).toBe('250.00');
  });

  it('createDepositTransaction fails cleanly against an inactive account (validate before the caller commits anything)', async () => {
    const account = await seedAccount('MAIN');
    await service.setAccountStatus(account.id, 'inactive', 'admin-1');
    await expect(service.createDepositTransaction('dep-1', 'so-1', 'cust-1', '250.00', account.id, 'finance-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('reversal never edits the original row — it posts an offsetting entry and flips status to reversed, netting the balance back', async () => {
    const account = await seedAccount('MAIN');
    const original = await service.cashIn(account.id, '100.00', null, null, null, null, 'finance-1');
    expect(await service.getAccountBalance(account.id)).toBe('100.00');

    const [reversal] = await service.reverseTransaction(original.id, 'wrong amount entered', 'finance-1');

    expect(reversal.type).toBe('cash_out');
    expect(reversal.reversalOfTransactionId).toBe(original.id);
    expect(await service.getAccountBalance(account.id)).toBe('0.00');

    const stillThere = transactions.find((t) => t.id === original.id)!;
    expect(stillThere.amount).toBe('100.00'); // original row itself is untouched except status
    expect(stillThere.status).toBe('reversed');
  });

  it('rejects reversing a transaction that is already reversed', async () => {
    const account = await seedAccount('MAIN');
    const original = await service.cashIn(account.id, '10.00', null, null, null, null, 'finance-1');
    await service.reverseTransaction(original.id, 'first reversal', 'finance-1');
    await expect(service.reverseTransaction(original.id, 'second attempt', 'finance-1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('reversing one leg of a transfer reverses both legs together, keeping the ledger double-entry-consistent', async () => {
    const a = await seedAccount('AAA');
    const b = await seedAccount('BBB');
    await service.cashIn(a.id, '100.00', null, null, null, null, 'finance-1');
    const { out } = await service.transfer(a.id, b.id, '40.00', null, null, 'finance-1');

    const reversals = await service.reverseTransaction(out.id, 'wrong destination', 'finance-1');

    expect(reversals).toHaveLength(2);
    expect(await service.getAccountBalance(a.id)).toBe('100.00'); // fully unwound
    expect(await service.getAccountBalance(b.id)).toBe('0.00');
  });

  it('throws NotFoundException for an unknown account or transaction id', async () => {
    await expect(service.getAccount('missing')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.reverseTransaction('missing', 'x', 'finance-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('listAccountsWithBalances returns every account with its computed balance', async () => {
    const a = await seedAccount('AAA');
    await service.cashIn(a.id, '55.00', null, null, null, null, 'finance-1');
    await seedAccount('BBB');

    const list = await service.listAccountsWithBalances();
    expect(list.find((x) => x.code === 'AAA')?.balance).toBe('55.00');
    expect(list.find((x) => x.code === 'BBB')?.balance).toBe('0.00');
  });
});
