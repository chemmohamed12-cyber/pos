import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { InvoiceService } from './invoices.service';
import { SalesInvoice } from '../infrastructure/sales-invoice.entity';
import { SalesInvoiceLine } from '../infrastructure/sales-invoice-line.entity';
import { CustomerLedgerEntry } from '../infrastructure/customer-ledger-entry.entity';
import { CustomerLedgerService } from './customer-ledger.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { SalesOrdersService } from '../../sales-orders/application/sales-orders.service';
import { CustomersService } from '../../crm/application/customers.service';

/**
 * Proves the Sales Invoice lifecycle: draft creation snapshots the
 * order's OWN historical line prices (never live product prices, same
 * discipline Returns Phase A already established for `ReturnCredit`),
 * posting is the ONE place a debit ever hits the Customer Ledger, and
 * once posted no direct mutation is allowed — only a guarded void.
 */
describe('InvoiceService', () => {
  let service: InvoiceService;
  const invoices = new Map<string, SalesInvoice>();
  const invoiceLines = new Map<string, SalesInvoiceLine[]>();
  const ledgerEntries: CustomerLedgerEntry[] = [];
  const invoiceStates = new Map<string, string>();
  let idSeq = 0;

  // TypeORM's `In([...])` returns a FindOperator ({ _type: 'in', _value }), not a plain value —
  // this helper normalizes both a direct equality where and an `In(...)` where to a plain id array.
  function idsFromWhereClause(clause: unknown): string[] {
    if (clause && typeof clause === 'object' && '_value' in (clause as Record<string, unknown>)) {
      return (clause as { _value: string[] })._value;
    }
    return [clause as string];
  }

  const invoiceRepo = {
    create: jest.fn((d: Partial<SalesInvoice>) => ({ id: `inv-${++idSeq}`, ...d }) as SalesInvoice),
    save: jest.fn(async (i: SalesInvoice) => {
      invoices.set(i.id, i);
      return i;
    }),
    findOne: jest.fn(async ({ where }: { where: { id: string } }) => invoices.get(where.id) ?? null),
    find: jest.fn(async ({ where }: { where: { salesOrderId?: string; customerId?: unknown } }) => {
      const all = [...invoices.values()];
      if (where.salesOrderId) return all.filter((i) => i.salesOrderId === where.salesOrderId);
      if (where.customerId !== undefined) {
        const ids = idsFromWhereClause(where.customerId);
        return all.filter((i) => ids.includes(i.customerId));
      }
      return all;
    }),
  };
  const lineRepo = {
    create: jest.fn((d: Partial<SalesInvoiceLine>) => ({ id: `line-${++idSeq}`, ...d }) as SalesInvoiceLine),
    save: jest.fn(async (lines: SalesInvoiceLine[]) => {
      if (lines.length) invoiceLines.set(lines[0].salesInvoiceId, lines);
      return lines;
    }),
    find: jest.fn(async ({ where }: { where: { salesInvoiceId: string } }) => invoiceLines.get(where.salesInvoiceId) ?? []),
  };
  const ledgerEntryRepo = {
    find: jest.fn(async ({ where }: { where: { invoiceId: string; entryType?: string; status?: string } }) =>
      ledgerEntries.filter((e) => e.invoiceId === where.invoiceId && (!where.entryType || e.entryType === where.entryType)),
    ),
  };

  const getRepositoryMock = jest.fn((entity: unknown) => {
    if (entity === SalesInvoice) return invoiceRepo;
    if (entity === SalesInvoiceLine) return lineRepo;
    return ledgerEntryRepo;
  });
  const queryMock = jest.fn(async (sql: string, params: unknown[]) => {
    const invoiceId = params[0] as string;
    const applied = ledgerEntries
      .filter((e) => e.invoiceId === invoiceId && e.entryType !== 'sales_invoice')
      .reduce((sum, e) => sum + (e.direction === 'credit' ? Number(e.amount) : -Number(e.amount)), 0);
    return [{ applied: applied.toFixed(2) }];
  });
  const dataSourceMock = {
    getRepository: getRepositoryMock,
    query: queryMock,
    transaction: jest.fn(async (fn: (manager: unknown) => Promise<unknown>) => fn({ getRepository: getRepositoryMock })),
  };

  const numberingCounters = new Map<string, number>();
  const numberingMock = {
    registerDocumentType: jest.fn(async () => undefined),
    getNextNumber: jest.fn(async (documentType: string) => {
      const next = (numberingCounters.get(documentType) ?? 0) + 1;
      numberingCounters.set(documentType, next);
      return `INV-2026-${String(next).padStart(6, '0')}`;
    }),
  };
  const processEngineMock = {
    start: jest.fn(async (_d: unknown, _t: string, id: string) => invoiceStates.set(id, 'draft')),
    transition: jest.fn(async (_d: unknown, _t: string, id: string, action: string) => {
      const map: Record<string, string> = {
        post: 'posted',
        cancel_draft: 'void',
        void: 'void',
        record_partial_payment: 'partially_paid',
        mark_paid: 'paid',
      };
      invoiceStates.set(id, map[action]);
    }),
    getState: jest.fn(async (_d: unknown, _t: string, id: string) => invoiceStates.get(id) ?? 'draft'),
  };
  const auditMock = { record: jest.fn(async () => undefined) };

  const orderLines = [
    { id: 'sol-1', salesOrderId: 'so-1', productId: 'prod-1', quantity: 5, unitPrice: '20.00', discountAmount: '0', lineTotal: '100.00' },
    { id: 'sol-2', salesOrderId: 'so-1', productId: 'prod-2', quantity: 2, unitPrice: '30.00', discountAmount: '10.00', lineTotal: '50.00' },
  ];
  const salesOrdersMock = {
    getOrder: jest.fn(async (orderId: string) => (orderId === 'so-1' ? { id: 'so-1', customerId: 'cust-1', warehouseId: 'wh-1' } : null)),
    getOrderLines: jest.fn(async (orderId: string) => (orderId === 'so-1' ? orderLines : orderId === 'so-empty' ? [] : [])),
  };
  const customersMock = {
    getCustomer: jest.fn(async (customerId: string) => (customerId === 'cust-1' ? { id: 'cust-1', paymentTermsDays: 30 } : { id: customerId, paymentTermsDays: null })),
    listCustomers: jest.fn(async () => [
      { id: 'cust-1', code: 'CUST-001', name: 'Customer One' },
      { id: 'cust-2', code: 'CUST-002', name: 'Customer Two' },
    ]),
  };
  const postedEntries: Array<Record<string, unknown>> = [];
  const customerLedgerMock = {
    postEntry: jest.fn(async (input: Record<string, unknown>) => {
      const entry = { id: `cle-${postedEntries.length + 1}`, status: 'posted', direction: input.direction, amount: input.amount, invoiceId: input.invoiceId, entryType: input.entryType } as CustomerLedgerEntry;
      postedEntries.push(input);
      ledgerEntries.push(entry);
      return entry;
    }),
    sweepUnappliedFor: jest.fn(async () => undefined),
    reverseEntry: jest.fn(async (entryId: string) => {
      const entry = ledgerEntries.find((e) => e.id === entryId);
      if (entry) entry.status = 'reversed';
      return entry as CustomerLedgerEntry;
    }),
  };

  beforeEach(async () => {
    invoices.clear();
    invoiceLines.clear();
    ledgerEntries.length = 0;
    postedEntries.length = 0;
    invoiceStates.clear();
    numberingCounters.clear();
    idSeq = 0;
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        InvoiceService,
        { provide: DataSource, useValue: dataSourceMock },
        { provide: NumberingService, useValue: numberingMock },
        { provide: ProcessEngineService, useValue: processEngineMock },
        { provide: AuditService, useValue: auditMock },
        { provide: SalesOrdersService, useValue: salesOrdersMock },
        { provide: CustomersService, useValue: customersMock },
        { provide: CustomerLedgerService, useValue: customerLedgerMock },
      ],
    }).compile();
    service = moduleRef.get(InvoiceService);
  });

  describe('createDraftInvoice', () => {
    it('snapshots the order lines\' own historical prices, computes totals server-side, and resolves dueDate from the customer\'s payment terms', async () => {
      const invoice = await service.createDraftInvoice('so-1', 'admin-1');
      expect(invoice.invoiceNumber).toMatch(/^INV-2026-/);
      expect(invoice.customerId).toBe('cust-1');
      expect(invoice.subtotal).toBe('160.00'); // 20*5 + 30*2
      expect(invoice.discountAmount).toBe('10.00');
      expect(invoice.totalAmount).toBe('150.00'); // 100 + 50
      expect(invoice.dueDate).not.toBeNull();
      expect(await service.getStatus(invoice.id)).toBe('draft');

      const lines = invoiceLines.get(invoice.id)!;
      expect(lines).toHaveLength(2);
      expect(lines[0].unitPrice).toBe('20.00'); // snapshotted, not re-read live
    });

    it('rejects a sales order with no lines', async () => {
      await expect(service.createDraftInvoice('so-empty', 'admin-1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects creating a second invoice for the same order while one already exists (non-void)', async () => {
      await service.createDraftInvoice('so-1', 'admin-1');
      await expect(service.createDraftInvoice('so-1', 'admin-1')).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('postInvoice', () => {
    it('posts a debit entry for the full total, sweeps unapplied entries, and transitions to posted', async () => {
      const invoice = await service.createDraftInvoice('so-1', 'admin-1');
      const posted = await service.postInvoice(invoice.id, 'finance-1');

      expect(await service.getStatus(invoice.id)).toBe('posted');
      expect(posted.postedByUserId).toBe('finance-1');
      expect(postedEntries).toHaveLength(1);
      expect(postedEntries[0]).toMatchObject({ entryType: 'sales_invoice', direction: 'debit', amount: '150.00', invoiceId: invoice.id });
      expect(customerLedgerMock.sweepUnappliedFor).toHaveBeenCalledWith('cust-1', 'so-1', invoice.id);
    });

    it('rejects posting an already-posted invoice', async () => {
      const invoice = await service.createDraftInvoice('so-1', 'admin-1');
      await service.postInvoice(invoice.id, 'finance-1');
      await expect(service.postInvoice(invoice.id, 'finance-1')).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('getInvoiceRemaining / recomputeStatus', () => {
    it('a payment credit entry reduces remaining and flips to partially_paid, then paid at zero', async () => {
      const invoice = await service.createDraftInvoice('so-1', 'admin-1');
      await service.postInvoice(invoice.id, 'finance-1');

      await customerLedgerMock.postEntry({ customerId: 'cust-1', entryType: 'payment', direction: 'credit', amount: '50.00', invoiceId: invoice.id });
      await service.recomputeStatus(invoice.id, 'finance-1');
      expect(await service.getInvoiceRemaining(invoice.id)).toBe('100.00');
      expect(await service.getStatus(invoice.id)).toBe('partially_paid');

      await customerLedgerMock.postEntry({ customerId: 'cust-1', entryType: 'payment', direction: 'credit', amount: '100.00', invoiceId: invoice.id });
      await service.recomputeStatus(invoice.id, 'finance-1');
      expect(await service.getInvoiceRemaining(invoice.id)).toBe('0.00');
      expect(await service.getStatus(invoice.id)).toBe('paid');
    });
  });

  describe('voidInvoice', () => {
    it('a draft invoice cancels cleanly with no ledger reversal needed', async () => {
      const invoice = await service.createDraftInvoice('so-1', 'admin-1');
      const voided = await service.voidInvoice(invoice.id, 'customer cancelled', 'admin-1');
      expect(await service.getStatus(invoice.id)).toBe('void');
      expect(voided.voidedReason).toBe('customer cancelled');
    });

    it('a posted invoice with nothing applied reverses its own debit entry, then voids', async () => {
      const invoice = await service.createDraftInvoice('so-1', 'admin-1');
      await service.postInvoice(invoice.id, 'finance-1');
      await service.voidInvoice(invoice.id, 'wrong customer', 'admin-1');
      expect(await service.getStatus(invoice.id)).toBe('void');
    });

    it('rejects voiding an invoice that already has a payment or credit applied', async () => {
      const invoice = await service.createDraftInvoice('so-1', 'admin-1');
      await service.postInvoice(invoice.id, 'finance-1');
      await customerLedgerMock.postEntry({ customerId: 'cust-1', entryType: 'payment', direction: 'credit', amount: '50.00', invoiceId: invoice.id });
      await service.recomputeStatus(invoice.id, 'admin-1');

      await expect(service.voidInvoice(invoice.id, 'too late', 'admin-1')).rejects.toBeInstanceOf(ConflictException);
    });

    it('throws for an unknown invoice', async () => {
      await expect(service.voidInvoice('no-such-id', 'reason', 'admin-1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('getArAging', () => {
    it('buckets an overdue invoice correctly and excludes fully-paid ones', async () => {
      const invoice = await service.createDraftInvoice('so-1', 'admin-1');
      await service.postInvoice(invoice.id, 'finance-1');
      const saved = invoices.get(invoice.id)!;
      saved.dueDate = new Date(Date.now() - 45 * 86400000); // 45 days overdue -> 31-60 bucket
      invoices.set(invoice.id, saved);

      const aging = await service.getArAging('cust-1', 'admin-1');
      expect(aging).toHaveLength(1);
      expect(aging[0].bucket).toBe('31-60');
      expect(aging[0].remaining).toBe('150.00');

      await customerLedgerMock.postEntry({ customerId: 'cust-1', entryType: 'payment', direction: 'credit', amount: '150.00', invoiceId: invoice.id });
      const agingAfterFullPayment = await service.getArAging('cust-1', 'admin-1');
      expect(agingAfterFullPayment).toHaveLength(0);
    });
  });

  describe('ERP UI Integration — Scope-filtered all-customers reads', () => {
    it('listAllInvoices enriches each invoice with its customer code/name, Scope-filtered via CustomersService.listCustomers', async () => {
      await service.createDraftInvoice('so-1', 'admin-1');
      const all = await service.listAllInvoices('actor-1');
      expect(customersMock.listCustomers).toHaveBeenCalledWith('actor-1');
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ customerCode: 'CUST-001', customerName: 'Customer One', state: 'draft' });
    });

    it('listAllInvoices returns an empty array when the actor has no visible customers', async () => {
      await service.createDraftInvoice('so-1', 'admin-1');
      customersMock.listCustomers.mockResolvedValueOnce([]);
      const all = await service.listAllInvoices('actor-2');
      expect(all).toEqual([]);
    });

    it('getArAgingForAllCustomers uses the SAME bucket formula as getArAging — never a second independent calculation', async () => {
      const invoice = await service.createDraftInvoice('so-1', 'admin-1');
      await service.postInvoice(invoice.id, 'finance-1');
      const saved = invoices.get(invoice.id)!;
      saved.dueDate = new Date(Date.now() - 45 * 86400000);
      invoices.set(invoice.id, saved);

      const [singleCustomer, allCustomers] = await Promise.all([
        service.getArAging('cust-1', 'admin-1'),
        service.getArAgingForAllCustomers('actor-1'),
      ]);

      expect(allCustomers).toHaveLength(1);
      expect(allCustomers[0]).toMatchObject({ bucket: singleCustomer[0].bucket, remaining: singleCustomer[0].remaining, customerCode: 'CUST-001' });
    });

    it('getInvoiceForSalesOrder returns null when the order has no live invoice, and the invoice + its state/remaining when it does', async () => {
      expect(await service.getInvoiceForSalesOrder('so-1', 'admin-1')).toBeNull();

      const invoice = await service.createDraftInvoice('so-1', 'admin-1');
      const found = await service.getInvoiceForSalesOrder('so-1', 'admin-1');
      expect(found).toMatchObject({ id: invoice.id, state: 'draft', remaining: '150.00' });
    });
  });
});
