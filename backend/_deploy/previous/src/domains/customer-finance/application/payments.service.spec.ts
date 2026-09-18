import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { Payment } from '../infrastructure/payment.entity';
import { SalesInvoice } from '../infrastructure/sales-invoice.entity';
import { CustomerLedgerService } from './customer-ledger.service';
import { InvoiceService } from './invoices.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { TreasuryService } from '../../treasury/application/treasury.service';
import { CustomersService } from '../../crm/application/customers.service';

/**
 * Proves Customer -> Payment -> Customer Account -> Treasury: a payment
 * never mutates a balance directly — it posts one real Treasury `cash_in`
 * (same `TreasuryService` every other cash inflow uses) then one Customer
 * Ledger credit entry, and overpayment is rejected outright.
 */
describe('PaymentsService', () => {
  let service: PaymentsService;
  const payments = new Map<string, Payment>();
  const invoices = new Map<string, Partial<SalesInvoice> & { id: string }>([
    ['inv-1', { id: 'inv-1', customerId: 'cust-1', salesOrderId: 'so-1', invoiceNumber: 'INV-2026-000001', totalAmount: '150.00' }],
  ]);
  let idSeq = 0;

  // TypeORM's `In([...])` returns a FindOperator ({ _type: 'in', _value }), not a plain value —
  // this helper normalizes both a direct equality where and an `In(...)` where to a plain id array.
  function idsFromWhereClause(clause: unknown): string[] {
    if (clause && typeof clause === 'object' && '_value' in (clause as Record<string, unknown>)) {
      return (clause as { _value: string[] })._value;
    }
    return [clause as string];
  }

  const paymentRepo = {
    create: jest.fn((d: Partial<Payment>) => ({ id: `pay-${++idSeq}`, ...d }) as Payment),
    save: jest.fn(async (p: Payment) => {
      payments.set(p.id, p);
      return p;
    }),
    find: jest.fn(async ({ where }: { where: { customerId: unknown } }) => {
      const ids = idsFromWhereClause(where.customerId);
      return [...payments.values()].filter((p) => ids.includes(p.customerId));
    }),
  };
  const invoiceRepo = {
    findOne: jest.fn(async ({ where }: { where: { id: string } }) => invoices.get(where.id) ?? null),
    find: jest.fn(async ({ where }: { where: { id: unknown } }) => {
      const ids = idsFromWhereClause(where.id);
      return [...invoices.values()].filter((i) => ids.includes(i.id));
    }),
  };
  const getRepositoryMock = jest.fn((entity: unknown) => (entity === Payment ? paymentRepo : invoiceRepo));
  const dataSourceMock = { getRepository: getRepositoryMock };

  const numberingCounters = new Map<string, number>();
  const numberingMock = {
    registerDocumentType: jest.fn(async () => undefined),
    getNextNumber: jest.fn(async (documentType: string) => {
      const next = (numberingCounters.get(documentType) ?? 0) + 1;
      numberingCounters.set(documentType, next);
      return `PAY-2026-${String(next).padStart(6, '0')}`;
    }),
  };
  const auditMock = { record: jest.fn(async () => undefined) };
  const treasuryMock = {
    cashIn: jest.fn(async (accountId: string, amount: string) => ({ id: `txn-${accountId}-${amount}` })),
  };
  const postedEntries: Array<Record<string, unknown>> = [];
  const customerLedgerMock = {
    postEntry: jest.fn(async (input: Record<string, unknown>) => {
      postedEntries.push(input);
      return { id: `cle-${postedEntries.length}`, ...input };
    }),
  };
  const remainingByInvoice = new Map<string, string>([['inv-1', '150.00']]);
  const invoicesServiceMock = {
    getInvoiceRemaining: jest.fn(async (invoiceId: string) => remainingByInvoice.get(invoiceId) ?? '0.00'),
    recomputeStatus: jest.fn(async () => 'partially_paid'),
  };
  const customersMock = {
    listCustomers: jest.fn(async () => [
      { id: 'cust-1', code: 'CUST-001', name: 'Customer One' },
      { id: 'cust-2', code: 'CUST-002', name: 'Customer Two' },
    ]),
  };

  beforeEach(async () => {
    payments.clear();
    postedEntries.length = 0;
    numberingCounters.clear();
    remainingByInvoice.set('inv-1', '150.00');
    idSeq = 0;
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: DataSource, useValue: dataSourceMock },
        { provide: NumberingService, useValue: numberingMock },
        { provide: AuditService, useValue: auditMock },
        { provide: TreasuryService, useValue: treasuryMock },
        { provide: CustomerLedgerService, useValue: customerLedgerMock },
        { provide: InvoiceService, useValue: invoicesServiceMock },
        { provide: CustomersService, useValue: customersMock },
      ],
    }).compile();
    service = moduleRef.get(PaymentsService);
  });

  it('records a payment: posts one Treasury cash_in and one Customer Ledger credit entry, then recomputes invoice status', async () => {
    const payment = await service.recordPayment('cust-1', 'inv-1', '100.00', 'bank_transfer', 'treasury-acc-1', 'REF-1', 'finance-1');

    expect(payment.paymentNumber).toMatch(/^PAY-2026-/);
    expect(treasuryMock.cashIn).toHaveBeenCalledWith('treasury-acc-1', '100.00', 'cust-1', 'so-1', 'inv-1', 'customer_payment', 'finance-1');
    expect(postedEntries).toHaveLength(1);
    expect(postedEntries[0]).toMatchObject({ customerId: 'cust-1', entryType: 'payment', direction: 'credit', amount: '100.00', invoiceId: 'inv-1' });
    expect(invoicesServiceMock.recomputeStatus).toHaveBeenCalledWith('inv-1', 'finance-1');
  });

  it('rejects a non-positive amount', async () => {
    await expect(service.recordPayment('cust-1', 'inv-1', '0.00', 'cash', 'treasury-acc-1', null, 'finance-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects overpayment — more than the invoice\'s own remaining balance', async () => {
    await expect(service.recordPayment('cust-1', 'inv-1', '999.00', 'cash', 'treasury-acc-1', null, 'finance-1')).rejects.toBeInstanceOf(ConflictException);
    expect(treasuryMock.cashIn).not.toHaveBeenCalled();
  });

  it('rejects a payment against an invoice belonging to a different customer', async () => {
    await expect(service.recordPayment('cust-999', 'inv-1', '50.00', 'cash', 'treasury-acc-1', null, 'finance-1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('throws for an unknown invoice', async () => {
    await expect(service.recordPayment('cust-1', 'no-such-invoice', '50.00', 'cash', 'treasury-acc-1', null, 'finance-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('an exact-remaining payment is accepted (boundary, not rejected as "over")', async () => {
    await expect(service.recordPayment('cust-1', 'inv-1', '150.00', 'cash', 'treasury-acc-1', null, 'finance-1')).resolves.toBeDefined();
  });

  it('listPaymentsForCustomer returns only this customer\'s payments', async () => {
    await service.recordPayment('cust-1', 'inv-1', '50.00', 'cash', 'treasury-acc-1', null, 'finance-1');
    const list = await service.listPaymentsForCustomer('cust-1');
    expect(list).toHaveLength(1);
    expect(list[0].customerId).toBe('cust-1');
  });

  describe('listAllPayments (ERP UI Integration — Scope-filtered across every visible customer)', () => {
    it('enriches each payment with its customer code/name and invoice number', async () => {
      await service.recordPayment('cust-1', 'inv-1', '50.00', 'cash', 'treasury-acc-1', null, 'finance-1');
      const list = await service.listAllPayments('actor-1');
      expect(customersMock.listCustomers).toHaveBeenCalledWith('actor-1');
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ customerCode: 'CUST-001', customerName: 'Customer One', invoiceNumber: 'INV-2026-000001' });
    });

    it('returns an empty array when the actor has no visible customers', async () => {
      await service.recordPayment('cust-1', 'inv-1', '50.00', 'cash', 'treasury-acc-1', null, 'finance-1');
      customersMock.listCustomers.mockResolvedValueOnce([]);
      const list = await service.listAllPayments('actor-2');
      expect(list).toEqual([]);
    });
  });
});
