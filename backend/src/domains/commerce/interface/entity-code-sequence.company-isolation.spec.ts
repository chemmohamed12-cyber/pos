import { randomUUID } from 'crypto';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { ProductsService } from '../application/products.service';
import { CustomersService } from '../../crm/application/customers.service';
import { SupplierService } from '../../procurement/application/supplier.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Owner request 2026-10-20 — a new item, customer or supplier gets a DEFAULT sequential code of its own kind (PRD-/CUST-/SUP-000001 …) that the user may replace with
 * another code, and the same code can never exist twice. Real PostgreSQL, Company A with Company B as the isolation witness. Covers the preview (nothing issued), the
 * issued serial, a hand-typed code (valid, taken, other letter case, invalid), a typed code that equals a future serial, a refused creation that must not burn a number,
 * and simultaneous creation.
 */
describe('Default sequential codes — items, customers, suppliers — real-Postgres, A/B', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let products: ProductsService;
  let customers: CustomersService;
  let suppliers: SupplierService;
  const actor = randomUUID();

  const a = async () => (await h.connections.getDataSource(h.companyAId)).manager;
  const b = async () => (await h.connections.getDataSource(h.companyBId)).manager;
  const lastNumber = async (m: Awaited<ReturnType<typeof a>>, type: string) => {
    const rows = await m.query(`SELECT "lastNumber" FROM numbering_sequences WHERE "documentType" = $1`, [type]);
    return rows.length ? Number(rows[0].lastNumber) : 0;
  };
  async function expectError(p: Promise<unknown>, type: new (...args: never[]) => Error, fragment: string) {
    const err = await p.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(type);
    expect((err as Error).message).toContain(fragment);
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'entity_codes', extraCompanyTags: ['sales', 'inventory', 'procurement'] });
    const inert = {} as never;
    const audit = new AuditService(h.controlPlane);
    const events = new EventBusService(inert, h.connections);
    const numbering = new NumberingService(h.controlPlane);
    const limits = { check: async () => ({ allowed: true, max: null }), consume: async () => ({ allowed: true, max: null }) } as never;
    products = new ProductsService(h.controlPlane, audit, events);
    customers = new CustomersService(h.controlPlane, numbering, inert, audit, events, inert, inert, limits);
    suppliers = new SupplierService(h.controlPlane, audit, inert, numbering);
  });

  afterAll(async () => {
    await h.teardown();
  });

  describe('items', () => {
    it('the preview shows the next serial and issues nothing', async () => {
      const m = await a();
      const first = await products.peekNextCode(m);
      expect(first).toBe('PRD-000001');
      expect(await products.peekNextCode(m)).toBe(first);
      expect(await lastNumber(m, 'product')).toBe(0);
    });

    it('no code → the next serial is issued; the preview then moves on', async () => {
      const m = await a();
      const p = await products.createProduct(null, 'Item one', '1.00', actor, null, m);
      expect(p.sku).toBe('PRD-000001');
      expect(await products.peekNextCode(m)).toBe('PRD-000002');
      const blank = await products.createProduct('   ', 'Item two', '1.00', actor, null, m);
      expect(blank.sku).toBe('PRD-000002');
    });

    it('a typed code is used as is, does not use up the serial, and can never be repeated (also in another letter case)', async () => {
      const m = await a();
      const before = await lastNumber(m, 'product');
      const typed = await products.createProduct('ABC-100', 'Typed item', '1.00', actor, null, m);
      expect(typed.sku).toBe('ABC-100');
      expect(await lastNumber(m, 'product')).toBe(before);
      await expectError(products.createProduct('ABC-100', 'Other name A', '1.00', actor, null, m), ConflictException, 'already exists');
      await expectError(products.createProduct('abc-100', 'Other name B', '1.00', actor, null, m), ConflictException, 'already exists');
      expect(await m.query(`SELECT 1 FROM products WHERE lower(sku) = 'abc-100'`)).toHaveLength(1);
    });

    it('a typed code that equals a future serial is skipped by the sequence, never reused', async () => {
      const m = await a();
      const next = await products.peekNextCode(m); // PRD-000003
      const n = Number(next.slice(4));
      await products.createProduct(`PRD-${String(n + 1).padStart(6, '0')}`, 'Takes the number after next', '1.00', actor, null, m);
      const first = await products.createProduct(null, 'Serial A', '1.00', actor, null, m);
      const second = await products.createProduct(null, 'Serial B', '1.00', actor, null, m);
      expect(first.sku).toBe(next);
      expect(second.sku).toBe(`PRD-${String(n + 2).padStart(6, '0')}`); // n+1 was taken by the typed code
      expect(await products.peekNextCode(m)).toBe(`PRD-${String(n + 3).padStart(6, '0')}`);
    });

    it('a creation that is refused does not burn a serial', async () => {
      const m = await a();
      const preview = await products.peekNextCode(m);
      await expectError(products.createProduct(null, 'Item one', '1.00', actor, null, m), ConflictException, 'already registered'); // same item name as an existing item
      expect(await products.peekNextCode(m)).toBe(preview);
    });

    it('simultaneous creation without a code gives every item its own code', async () => {
      const m = await a();
      const created = await Promise.all([1, 2, 3, 4, 5].map((i) => products.createProduct(null, `Parallel item ${i}`, '1.00', actor, null, m)));
      const codes = created.map((p) => p.sku);
      expect(new Set(codes).size).toBe(5);
      expect(await m.query(`SELECT sku FROM products GROUP BY sku HAVING count(*) > 1`)).toHaveLength(0);
    });

    it('Company B has its own serial: its first item is PRD-000001 whatever Company A has issued', async () => {
      const mb = await b();
      expect(await products.peekNextCode(mb)).toBe('PRD-000001');
      expect((await products.createProduct(null, 'B item', '1.00', actor, null, mb)).sku).toBe('PRD-000001');
    });
  });

  describe('customers', () => {
    it('preview, issued serial, typed code and every refusal', async () => {
      const m = await a();
      expect(await customers.peekNextCode(m)).toBe('CUST-000001');
      expect(await lastNumber(m, 'customer')).toBe(0);
      expect((await customers.createCustomer({ name: 'First customer' }, actor, m)).code).toBe('CUST-000001');
      expect(await customers.peekNextCode(m)).toBe('CUST-000002');

      const before = await lastNumber(m, 'customer');
      expect((await customers.createCustomer({ name: 'Typed customer', code: 'ACME-01' }, actor, m)).code).toBe('ACME-01');
      expect(await lastNumber(m, 'customer')).toBe(before); // a typed code does not use up the serial
      await expectError(customers.createCustomer({ name: 'Again', code: 'ACME-01' }, actor, m), ConflictException, 'already in use');
      await expectError(customers.createCustomer({ name: 'Again', code: 'acme-01' }, actor, m), ConflictException, 'already in use');
      await expectError(customers.createCustomer({ name: 'Bad', code: 'bad code!' }, actor, m), BadRequestException, 'not valid');
      await expectError(customers.createCustomer({ name: 'Long', code: 'X'.repeat(33) }, actor, m), BadRequestException, 'not valid');
      expect(await m.query(`SELECT 1 FROM customers WHERE lower(code) = 'acme-01'`)).toHaveLength(1);
    });

    it('a typed code equal to a future serial is skipped; simultaneous creation never repeats a code; Company B is independent', async () => {
      const m = await a();
      const next = await customers.peekNextCode(m);
      const n = Number(next.slice(5));
      await customers.createCustomer({ name: 'Takes next+1', code: `CUST-${String(n + 1).padStart(6, '0')}` }, actor, m);
      const x = await customers.createCustomer({ name: 'Serial X' }, actor, m);
      const y = await customers.createCustomer({ name: 'Serial Y' }, actor, m);
      expect(x.code).toBe(next);
      expect(y.code).toBe(`CUST-${String(n + 2).padStart(6, '0')}`);
      const parallel = await Promise.all([1, 2, 3, 4].map((i) => customers.createCustomer({ name: `Parallel ${i}` }, actor, m)));
      expect(new Set(parallel.map((c) => c.code)).size).toBe(4);
      expect(await m.query(`SELECT code FROM customers GROUP BY code HAVING count(*) > 1`)).toHaveLength(0);
      const mb = await b();
      expect((await customers.createCustomer({ name: 'B first' }, actor, mb)).code).toBe('CUST-000001');
    });
  });

  describe('suppliers', () => {
    it('preview, issued serial, typed code and every refusal', async () => {
      const m = await a();
      expect(await suppliers.peekNextCode(m)).toBe('SUP-000001');
      expect((await suppliers.create({ legalName: 'First supplier' } as never, actor, m)).code).toBe('SUP-000001');
      expect(await suppliers.peekNextCode(m)).toBe('SUP-000002');
      const before = await lastNumber(m, 'supplier');
      expect((await suppliers.create({ legalName: 'Typed supplier', code: 'VND-7' } as never, actor, m)).code).toBe('VND-7');
      expect(await lastNumber(m, 'supplier')).toBe(before);
      await expectError(suppliers.create({ legalName: 'Again', code: 'VND-7' } as never, actor, m), ConflictException, 'already in use');
      await expectError(suppliers.create({ legalName: 'Again', code: 'vnd-7' } as never, actor, m), ConflictException, 'already in use');
      await expectError(suppliers.create({ legalName: 'Bad', code: 'no spaces allowed' } as never, actor, m), BadRequestException, 'not valid');
    });

    it('a typed code equal to a future serial is skipped; simultaneous creation never repeats a code; Company B is independent', async () => {
      const m = await a();
      const next = await suppliers.peekNextCode(m);
      const n = Number(next.slice(4));
      await suppliers.create({ legalName: 'Takes next+1', code: `SUP-${String(n + 1).padStart(6, '0')}` } as never, actor, m);
      const x = await suppliers.create({ legalName: 'Serial X' } as never, actor, m);
      const y = await suppliers.create({ legalName: 'Serial Y' } as never, actor, m);
      expect(x.code).toBe(next);
      expect(y.code).toBe(`SUP-${String(n + 2).padStart(6, '0')}`);
      const parallel = await Promise.all([1, 2, 3, 4].map((i) => suppliers.create({ legalName: `Parallel ${i}` } as never, actor, m)));
      expect(new Set(parallel.map((s) => s.code)).size).toBe(4);
      const mb = await b();
      expect((await suppliers.create({ legalName: 'B first' } as never, actor, mb)).code).toBe('SUP-000001');
    });
  });

  it('the three kinds use separate sequences', async () => {
    const m = await a();
    const rows = await m.query(`SELECT "documentType", prefix FROM numbering_sequences WHERE "documentType" IN ('product','customer','supplier') ORDER BY 1`);
    expect(rows).toEqual([
      { documentType: 'customer', prefix: 'CUST' },
      { documentType: 'product', prefix: 'PRD' },
      { documentType: 'supplier', prefix: 'SUP' },
    ]);
  });
});
