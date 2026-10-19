import { randomUUID } from 'crypto';
import { ConflictException } from '@nestjs/common';
import { ProductsService } from '../application/products.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * One item, one code (2026-10-19, owner): registering an item whose name already belongs to another item — under any code — is
 * refused with a message naming the existing code. Real PostgreSQL, Company A with Company B as the isolation witness. Covers the
 * three ways an item is registered (create, Excel import, New Item Request draft), a rename, the name normalisation, a
 * pre-existing duplicate that must not block unrelated edits, and two simultaneous registrations of the same item.
 */
describe('Item registration — the same item cannot get a second code — real-Postgres, A/B', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let products: ProductsService;
  const actor = randomUUID();

  const a = async () => (await h.connections.getDataSource(h.companyAId)).manager;
  const b = async () => (await h.connections.getDataSource(h.companyBId)).manager;
  const count = async (m: Awaited<ReturnType<typeof a>>) => Number((await m.query(`SELECT count(*)::int AS n FROM products`))[0].n);

  async function expectAlreadyRegistered(p: Promise<unknown>, existingSku: string) {
    const err = await p.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConflictException);
    const message = (err as Error).message;
    expect(message).toContain('already registered');
    expect(message).toContain('مضاف سابقاً');
    expect(message).toContain(`"${existingSku}"`);
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'item_name_guard', extraCompanyTags: ['sales', 'inventory'] });
    const inert = {} as never;
    products = new ProductsService(h.controlPlane, new AuditService(h.controlPlane), new EventBusService(inert, h.connections));
    const dsA = await h.connections.getDataSource(h.companyAId);
    await dsA.query(
      `INSERT INTO "products" ("id","sku","name","unitPrice","status") VALUES
        ($1,'LB-1','بوردة 9 وات ابيض','4.00','active'),
        ($2,'CAB-1','Cable 2M','5.00','active'),
        ($3,'OLD-1','صنف قديم مكرر','1.00','active'),
        ($4,'OLD-2','صنف قديم مكرر','1.00','active')`,
      [randomUUID(), randomUUID(), randomUUID(), randomUUID()],
    );
  });

  afterAll(async () => {
    await h.teardown();
  });

  it('create: a new code for an existing item name is refused with the existing code; nothing is written', async () => {
    const m = await a();
    const before = await count(m);
    await expectAlreadyRegistered(products.createProduct('LB-2', 'بوردة 9 وات ابيض', '4.50', actor, null, m), 'LB-1');
    expect(await count(m)).toBe(before);
    expect(await m.query(`SELECT 1 FROM products WHERE sku = 'LB-2'`)).toHaveLength(0);
  });

  it('create: spacing, case and Arabic letter variants of the same name are the same item', async () => {
    const m = await a();
    await expectAlreadyRegistered(products.createProduct('X-1', '  بوردة   9  وات  ابيض ', '1', actor, null, m), 'LB-1');
    await expectAlreadyRegistered(products.createProduct('X-2', 'بورده 9 وات ابيض', '1', actor, null, m), 'LB-1'); // ة → ه
    await expectAlreadyRegistered(products.createProduct('X-3', 'cable 2m', '1', actor, null, m), 'CAB-1'); // case
    await expectAlreadyRegistered(products.createProduct('X-4', 'CABLE   2M', '1', actor, null, m), 'CAB-1');
    await expectAlreadyRegistered(products.createProduct('X-5', 'بُوردة 9 وات ابيض', '1', actor, null, m), 'LB-1'); // tashkeel
  });

  it('create: a different name is accepted; an existing code is still refused by the code rule', async () => {
    const m = await a();
    const ok = await products.createProduct('LB-12W', 'بوردة 12 وات ابيض', '5.00', actor, null, m);
    expect(ok.sku).toBe('LB-12W');
    await expect(products.createProduct('LB-1', 'اسم جديد تماما', '1', actor, null, m)).rejects.toThrow(/SKU "LB-1" already exists/);
  });

  it('New Item Request draft product: the same guard applies', async () => {
    const m = await a();
    await expectAlreadyRegistered(products.createDraftProduct({ sku: 'DRAFT-1', name: 'Cable 2M' }, actor, m), 'CAB-1');
    const draft = await products.createDraftProduct({ sku: 'DRAFT-2', name: 'Brand new draft item' }, actor, m);
    expect(draft.status).toBe('draft');
  });

  it('Excel import: a duplicate-name row is rejected with the message, the other rows are imported, a duplicate inside the file is caught too', async () => {
    const m = await a();
    const result = await products.importRows(
      [
        { sku: 'IMP-1', name: 'Imported A', unitPrice: '1', status: 'active' },
        { sku: 'IMP-2', name: 'Cable 2M', unitPrice: '1', status: 'active' },
        { sku: 'IMP-3', name: 'imported  a', unitPrice: '1', status: 'active' },
        { sku: 'IMP-4', name: 'Imported B', unitPrice: '1', status: 'active' },
      ],
      actor,
      m,
    );
    expect(result.succeeded.map((p) => p.sku)).toEqual(['IMP-1', 'IMP-4']);
    expect(result.rejected.map((r) => r.row)).toEqual([3, 4]); // spreadsheet row numbers: the header is row 1, so data rows 2 and 3 are rows 3 and 4
    expect(result.rejected[0].errors[0]).toContain('"CAB-1"');
    expect(result.rejected[1].errors[0]).toContain('"IMP-1"');
  });

  it('rename: to another item\'s name is refused; to its own name or its own spacing is allowed; to a free name is allowed', async () => {
    const m = await a();
    const [lb] = await m.query(`SELECT id FROM products WHERE sku = 'LB-12W'`);
    await expectAlreadyRegistered(products.updateName(lb.id, 'Cable 2M', actor, m), 'CAB-1');
    expect((await products.updateName(lb.id, 'بوردة 12 وات ابيض', actor, m)).name).toBe('بوردة 12 وات ابيض');
    expect((await products.updateName(lb.id, ' بوردة  12 وات ابيض ', actor, m)).sku).toBe('LB-12W');
    expect((await products.updateName(lb.id, 'بوردة 12 وات ابيض - جديد', actor, m)).name).toBe('بوردة 12 وات ابيض - جديد');
  });

  it('a pre-existing duplicate does not block unrelated edits, but no new duplicate can be added to it', async () => {
    const m = await a();
    const [old1] = await m.query(`SELECT id FROM products WHERE sku = 'OLD-1'`);
    expect((await products.updateName(old1.id, 'صنف قديم مكرر', actor, m)).sku).toBe('OLD-1'); // same name re-saved
    await expectAlreadyRegistered(products.createProduct('OLD-3', 'صنف قديم مكرر', '1', actor, null, m), 'OLD-1');
  });

  it('Company B is independent: the same name may exist there, and A is untouched', async () => {
    const mb = await b();
    const created = await products.createProduct('B-LB-1', 'بوردة 9 وات ابيض', '4.00', actor, null, mb);
    expect(created.sku).toBe('B-LB-1');
    const ma = await a();
    expect(await ma.query(`SELECT 1 FROM products WHERE sku = 'B-LB-1'`)).toHaveLength(0);
    await expectAlreadyRegistered(products.createProduct('B-LB-2', 'بوردة 9 وات ابيض', '4.00', actor, null, mb), 'B-LB-1');
  });

  it('two simultaneous registrations of the same item: exactly one wins, the other is refused', async () => {
    const m = await a();
    const results = await Promise.allSettled([
      products.createProduct('RACE-1', 'Race condition item', '1', actor, null, m),
      products.createProduct('RACE-2', 'race  condition ITEM', '1', actor, null, m),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await m.query(`SELECT sku FROM products WHERE sku IN ('RACE-1','RACE-2')`)).toHaveLength(1);
  });
});
