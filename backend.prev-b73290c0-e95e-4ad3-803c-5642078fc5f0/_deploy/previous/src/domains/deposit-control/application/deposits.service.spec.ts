import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { DepositsService } from './deposits.service';
import { Deposit } from '../infrastructure/deposit.entity';
import { SalesOrdersService } from '../../sales-orders/application/sales-orders.service';
import { TreasuryService } from '../../treasury/application/treasury.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { CustomerLedgerService } from '../../customer-finance/application/customer-ledger.service';
import { InvoiceService } from '../../customer-finance/application/invoices.service';

/**
 * Proves the final link in the V1 vertical slice (blueprint §42):
 * Deposit approval releases the Sales Order and emits the
 * finance-sufficient `deposit.verified` event (ADR-018) — without
 * Deposit Control ever touching Sales Orders' persistence directly.
 */
describe('DepositsService', () => {
  let service: DepositsService;
  const deposits = new Map<string, Deposit>();
  let idSeq = 0;
  const publishedEvents: Array<{ topic: string; payload: unknown }> = [];

  const repoMock = {
    create: jest.fn((data: Partial<Deposit>) => ({ id: `dep-${++idSeq}`, ...data }) as Deposit),
    save: jest.fn(async (d: Deposit) => {
      deposits.set(d.id, d);
      return d;
    }),
    findOne: jest.fn(async ({ where }: { where: { id: string } }) => deposits.get(where.id) ?? null),
  };

  const dataSourceMock = {
    getRepository: jest.fn(() => repoMock),
    transaction: jest.fn(async (fn: (manager: unknown) => Promise<unknown>) => fn({ getRepository: () => repoMock })),
  };

  const salesOrdersMock = {
    getOrder: jest.fn(async (orderId: string) => ({ id: orderId, customerId: 'cust-1', totalAmount: '75.00' })),
    getOrderStatus: jest.fn(async () => 'deposit_verification'),
    releaseAfterDepositVerified: jest.fn(async () => 'released'),
  };
  const treasuryMock = {
    createDepositTransaction: jest.fn(async () => ({ id: 'treasury-txn-1' })),
  };
  const auditMock = { record: jest.fn(async () => undefined) };
  const eventsMock = {
    publish: jest.fn(async (_manager: unknown, topic: string, payload: unknown) => {
      publishedEvents.push({ topic, payload });
    }),
  };
  const postedLedgerEntries: Array<Record<string, unknown>> = [];
  const customerLedgerMock = {
    postEntry: jest.fn(async (input: Record<string, unknown>) => {
      postedLedgerEntries.push(input);
      return { id: `cle-${postedLedgerEntries.length}`, ...input };
    }),
  };
  const invoicesMock = {
    findOpenInvoiceForOrder: jest.fn(async (): Promise<{ id: string } | null> => null),
    getStatus: jest.fn(async () => 'draft'),
    recomputeStatus: jest.fn(async () => 'posted'),
  };

  beforeEach(async () => {
    deposits.clear();
    idSeq = 0;
    publishedEvents.length = 0;
    postedLedgerEntries.length = 0;
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        DepositsService,
        { provide: DataSource, useValue: dataSourceMock },
        { provide: SalesOrdersService, useValue: salesOrdersMock },
        { provide: TreasuryService, useValue: treasuryMock },
        { provide: AuditService, useValue: auditMock },
        { provide: EventBusService, useValue: eventsMock },
        { provide: CustomerLedgerService, useValue: customerLedgerMock },
        { provide: InvoiceService, useValue: invoicesMock },
      ],
    }).compile();
    service = moduleRef.get(DepositsService);
  });

  it('submits a deposit in "submitted" status and publishes deposit.submitted', async () => {
    const deposit = await service.submitDeposit('so-1', '75.00', 'bank_transfer', 'REF123', null, 'rep-1');
    expect(deposit.status).toBe('submitted');
    expect(publishedEvents.map((e) => e.topic)).toContain('deposit.submitted');
  });

  it('approving a deposit releases the Sales Order and emits a finance-sufficient deposit.verified event', async () => {
    const deposit = await service.submitDeposit('so-1', '75.00', 'bank_transfer', 'REF123', null, 'rep-1');
    await service.approveDeposit(deposit.id, 'admin-1', 'treasury-acc-1');

    expect(salesOrdersMock.releaseAfterDepositVerified).toHaveBeenCalledWith('so-1', 'admin-1');

    const verifiedEvent = publishedEvents.find((e) => e.topic === 'deposit.verified');
    expect(verifiedEvent).toBeDefined();
    const payload = verifiedEvent!.payload as Record<string, unknown>;
    // ADR-018 finance-sufficient payload — amount, currency, party, date all present,
    // no callback into Sales Orders needed to enrich this event later.
    expect(payload).toMatchObject({
      salesOrderId: 'so-1',
      customerId: 'cust-1',
      amount: '75.00',
      currency: 'EGP',
      verifiedByUserId: 'admin-1',
    });
    expect(payload.businessDate).toBeDefined();
  });

  it('approving as finance succeeds and passes the finance actor through to SalesOrdersService.getOrder — that call\'s own Scope check used to 404 for finance until getOrder\'s reviewer/role bypass list included it (REAL BUG FOUND LIVE, Post-Deposit-Approval Edit Control verification, CTO directive §1)', async () => {
    const deposit = await service.submitDeposit('so-1', '75.00', 'bank_transfer', 'REF123', null, 'rep-1');
    await expect(service.approveDeposit(deposit.id, 'finance-1', 'treasury-acc-1')).resolves.toMatchObject({ status: 'approved' });
    expect(salesOrdersMock.getOrder).toHaveBeenCalledWith('so-1', 'finance-1');
  });

  it('rejects approving an already-approved deposit', async () => {
    const deposit = await service.submitDeposit('so-1', '75.00', 'cash', null, null, 'rep-1');
    await service.approveDeposit(deposit.id, 'admin-1', 'treasury-acc-1');
    await expect(service.approveDeposit(deposit.id, 'admin-1', 'treasury-acc-1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('throws for an unknown deposit id', async () => {
    await expect(service.approveDeposit('no-such-id', 'admin-1', 'treasury-acc-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses to approve — and never touches Treasury or the deposit itself — when the order is not awaiting deposit verification', async () => {
    const deposit = await service.submitDeposit('so-1', '75.00', 'bank_transfer', null, null, 'rep-1');
    salesOrdersMock.getOrderStatus.mockResolvedValueOnce('draft');

    await expect(service.approveDeposit(deposit.id, 'admin-1', 'treasury-acc-1')).rejects.toBeInstanceOf(ConflictException);
    expect(treasuryMock.createDepositTransaction).not.toHaveBeenCalled();
    expect(deposits.get(deposit.id)!.status).toBe('submitted');
  });

  describe('Customer Ledger bridge (Customer Financial Account / AR — CTO directive)', () => {
    it('posts exactly one unapplied "deposit" credit ledger entry when approved, no invoice yet existing for the order', async () => {
      const deposit = await service.submitDeposit('so-1', '75.00', 'bank_transfer', 'REF123', null, 'rep-1');
      await service.approveDeposit(deposit.id, 'admin-1', 'treasury-acc-1');

      expect(postedLedgerEntries).toHaveLength(1);
      expect(postedLedgerEntries[0]).toMatchObject({
        customerId: 'cust-1',
        entryType: 'deposit',
        direction: 'credit',
        amount: '75.00',
        salesOrderId: 'so-1',
        invoiceId: null,
        depositId: deposit.id,
      });
      expect(invoicesMock.recomputeStatus).not.toHaveBeenCalled();
    });

    it('links the ledger entry directly to an already-posted invoice for the same order, and recomputes its status', async () => {
      invoicesMock.findOpenInvoiceForOrder.mockResolvedValueOnce({ id: 'inv-1' });
      invoicesMock.getStatus.mockResolvedValueOnce('posted');

      const deposit = await service.submitDeposit('so-1', '75.00', 'bank_transfer', 'REF123', null, 'rep-1');
      await service.approveDeposit(deposit.id, 'admin-1', 'treasury-acc-1');

      expect(postedLedgerEntries[0]).toMatchObject({ invoiceId: 'inv-1' });
      expect(invoicesMock.recomputeStatus).toHaveBeenCalledWith('inv-1', 'admin-1');
    });

    it('never posts a ledger entry when approval itself fails (order not awaiting deposit verification)', async () => {
      const deposit = await service.submitDeposit('so-1', '75.00', 'bank_transfer', null, null, 'rep-1');
      salesOrdersMock.getOrderStatus.mockResolvedValueOnce('draft');

      await expect(service.approveDeposit(deposit.id, 'admin-1', 'treasury-acc-1')).rejects.toBeInstanceOf(ConflictException);
      expect(postedLedgerEntries).toHaveLength(0);
    });
  });

  describe('reject / resubmit', () => {
    it('rejects a submitted deposit, records the reason, and audits it', async () => {
      const deposit = await service.submitDeposit('so-1', '75.00', 'cash', null, null, 'rep-1');
      const rejected = await service.rejectDeposit(deposit.id, 'Evidence does not match amount', 'admin-1');

      expect(rejected.status).toBe('rejected');
      expect(rejected.rejectionReason).toBe('Evidence does not match amount');
      expect(rejected.reviewedByUserId).toBe('admin-1');
      expect(salesOrdersMock.releaseAfterDepositVerified).not.toHaveBeenCalled();
      expect(auditMock.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'deposit.rejected' }));
    });

    it('rejects re-rejecting or approving an already-rejected deposit', async () => {
      const deposit = await service.submitDeposit('so-1', '75.00', 'cash', null, null, 'rep-1');
      await service.rejectDeposit(deposit.id, 'bad reference', 'admin-1');
      await expect(service.rejectDeposit(deposit.id, 'again', 'admin-1')).rejects.toBeInstanceOf(ConflictException);
      await expect(service.approveDeposit(deposit.id, 'admin-1', 'treasury-acc-1')).rejects.toBeInstanceOf(ConflictException);
    });

    it('resubmission is just a new submitDeposit call — getLatestDepositForOrder picks up the newest row', async () => {
      const first = await service.submitDeposit('so-1', '75.00', 'cash', null, null, 'rep-1');
      await service.rejectDeposit(first.id, 'wrong amount', 'admin-1');

      // Simulate real ordering: the resubmission happens strictly after the rejection.
      const second = await service.submitDeposit('so-1', '100.00', 'bank_transfer', 'REF-2', null, 'rep-1');
      (second as unknown as { createdAt: Date }).createdAt = new Date(Date.now() + 1000);

      const latestRepo = {
        findOne: jest.fn(async () => second),
      };
      dataSourceMock.getRepository.mockReturnValueOnce(latestRepo as never);
      const latest = await service.getLatestDepositForOrder('so-1', 'rep-1');
      expect(latest?.id).toBe(second.id);
      expect(latest?.status).toBe('submitted');
    });
  });
});
