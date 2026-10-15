import { randomUUID } from 'crypto';
import { ConflictException } from '@nestjs/common';
import { PurchaseOrderService } from '../application/purchase-order.service';
import { PurchaseRequestService } from '../application/purchase-request.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { makeProductLifecycleGate } from './product-lifecycle-gate.test-helper';
import { makeWarehouseLookup } from './warehouse-lookup.test-helper';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * CR-2026-10-15 — procurement item eligibility, real Postgres. Before this change (evidence-2026-10-15-cr-review/probe-results.json):
 * a discontinued item was accepted on PO create and PR create, a missing item id surfaced as a raw FK `QueryFailedError` (HTTP 500),
 * and a PO whose item was discontinued after creation could still be approved. Now: PO create and PO approve require every item to
 * exist and be `active`; PR create refuses missing/discontinued (draft stays allowed for the New Item flow). Every refusal is a
 * controlled 409 that lists every bad line and writes nothing (no document, no line, no number consumed). PO/PR have no update path.
 */
describe('CR-2026-10-15 procurement item eligibility — real-Postgres', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let po: PurchaseOrderService;
  let pr: PurchaseRequestService;
  const maker = randomUUID();
  const checker = randomUUID();
  const ids = { supplier: randomUUID(), warehouse: randomUUID(), active: randomUUID(), discontinued: randomUUID(), draft: randomUUID(), foreignB: randomUUID() };
  const missing = randomUUID();

  const poLine = (productId: string) => ({ productId, quantity: '5', unitCostBase: '2.00' });
  const poInput = (...productIds: string[]) => ({ supplierId: ids.supplier, warehouseId: ids.warehouse, lines: productIds.map(poLine) });
  const prInput = (...productIds: string[]) => ({ warehouseId: ids.warehouse, lines: productIds.map((productId) => ({ productId, quantity: '5' })) });

  async function dsA() {
    return h.connections.getDataSource(h.companyAId);
  }
  async function count(table: string): Promise<number> {
    return Number((await (await dsA()).query(`SELECT COUNT(*)::int AS n FROM ${table}`))[0].n);
  }
  async function expectRefused(promise: Promise<unknown>, ...fragments: string[]) {
    const err = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConflictException);
    for (const f of fragments) expect((err as Error).message).toContain(f);
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'proc_item_elig', extraCompanyTags: ['sales', 'inventory', 'procurement'] });
    const ds = await dsA();
    for (const u of [maker, checker]) await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,'Eligibility',$2)`, [u, `elig-${u}@test.local`]);
    await ds.query(`INSERT INTO "warehouses" ("id","code","name","status") VALUES ($1,'WH-E','Eligibility Warehouse','active')`, [ids.warehouse]);
    await ds.query(
      `INSERT INTO "products" ("id","sku","name","unitPrice","status") VALUES ($1,'SKU-ACT','Active item','10.00','active'), ($2,'SKU-DISC','Discontinued item','10.00','discontinued'), ($3,'SKU-DRAFT','Draft item','10.00','draft')`,
      [ids.active, ids.discontinued, ids.draft],
    );
    await ds.query(`INSERT INTO "suppliers" ("id","code","legalName") VALUES ($1,'SUP-E','Eligibility Supplier')`, [ids.supplier]);
    // A product that exists only in Company B — from Company A it is a missing item.
    const dsB = await h.connections.getDataSource(h.companyBId);
    await dsB.query(`INSERT INTO "products" ("id","sku","name","unitPrice","status") VALUES ($1,'SKU-B','B-only item','10.00','active')`, [ids.foreignB]);

    const audit = new AuditService(h.controlPlane);
    const numbering = new NumberingService(h.controlPlane);
    const processEngine = new ProcessEngineService(h.controlPlane);
    po = new PurchaseOrderService(h.controlPlane, processEngine, numbering, audit, makeProductLifecycleGate(h.controlPlane), makeWarehouseLookup(h.controlPlane));
    pr = new PurchaseRequestService(h.controlPlane, processEngine, numbering, audit, makeProductLifecycleGate(h.controlPlane), makeWarehouseLookup(h.controlPlane));
  });

  afterAll(async () => {
    await h.teardown();
  });

  it('PO create: an active item is accepted', async () => {
    const created = await po.create(poInput(ids.active), maker, (await dsA()).manager);
    expect(created.poNumber).toMatch(/^PO-\d{4}-000001$/);
  });

  it('PO create: discontinued, draft and missing items are each refused with a controlled 409 — nothing is written', async () => {
    const m = (await dsA()).manager;
    const before = { orders: await count('purchase_orders'), lines: await count('purchase_order_lines') };
    await expectRefused(po.create(poInput(ids.discontinued), maker, m), 'Cannot create this Purchase Order', '"SKU-DISC — Discontinued item" is discontinued');
    await expectRefused(po.create(poInput(ids.draft), maker, m), '"SKU-DRAFT — Draft item" is a draft item');
    await expectRefused(po.create(poInput(missing), maker, m), `item ${missing} does not exist`);
    await expectRefused(po.create(poInput(ids.foreignB), maker, m), `item ${ids.foreignB} does not exist`);
    expect({ orders: await count('purchase_orders'), lines: await count('purchase_order_lines') }).toEqual(before);
  });

  it('PO create: a mixed order lists EVERY ineligible line and is refused whole; the next valid PO takes the next number (none consumed)', async () => {
    const m = (await dsA()).manager;
    const before = await count('purchase_orders');
    await expectRefused(po.create(poInput(ids.active, missing, ids.discontinued), maker, m), `item ${missing} does not exist`, '"SKU-DISC — Discontinued item" is discontinued');
    expect(await count('purchase_orders')).toBe(before);
    const next = await po.create(poInput(ids.active), maker, m);
    expect(next.poNumber).toMatch(/^PO-\d{4}-000002$/);
  });

  it('PO approve: an item discontinued after the PO was raised blocks approval (state unchanged); once active again it approves', async () => {
    const m = (await dsA()).manager;
    const ds = await dsA();
    const created = await po.create(poInput(ids.active), maker, m);
    await po.transition(created.id, 'submit', maker, m);
    await ds.query(`UPDATE products SET status = 'discontinued' WHERE id = $1`, [ids.active]);
    try {
      await expectRefused(po.transition(created.id, 'approve', checker, m), 'Cannot approve this Purchase Order', '"SKU-ACT — Active item" is discontinued');
      expect((await po.getById(created.id, m)).state).toBe('submitted');
    } finally {
      await ds.query(`UPDATE products SET status = 'active' WHERE id = $1`, [ids.active]);
    }
    expect((await po.transition(created.id, 'approve', checker, m)).state).toBe('approved');
  });

  it('PO reject/cancel are not gated — a PO carrying a discontinued item can still be closed out', async () => {
    const m = (await dsA()).manager;
    const ds = await dsA();
    const created = await po.create(poInput(ids.active), maker, m);
    await po.transition(created.id, 'submit', maker, m);
    await ds.query(`UPDATE products SET status = 'discontinued' WHERE id = $1`, [ids.active]);
    try {
      expect((await po.transition(created.id, 'reject', checker, m)).state).toBe('draft');
      expect((await po.transition(created.id, 'cancel', maker, m)).state).toBe('cancelled');
    } finally {
      await ds.query(`UPDATE products SET status = 'active' WHERE id = $1`, [ids.active]);
    }
  });

  it('PR create: missing and discontinued items are refused with a controlled 409 (no raw FK error); draft stays allowed', async () => {
    const m = (await dsA()).manager;
    const before = { requests: await count('purchase_requests'), lines: await count('purchase_request_lines') };
    await expectRefused(pr.create(prInput(missing), maker, m), 'Cannot create this Purchase Request', `item ${missing} does not exist`);
    await expectRefused(pr.create(prInput(ids.discontinued), maker, m), '"SKU-DISC — Discontinued item" is discontinued');
    await expectRefused(pr.create(prInput(ids.active, missing), maker, m), `item ${missing} does not exist`);
    expect({ requests: await count('purchase_requests'), lines: await count('purchase_request_lines') }).toEqual(before);

    const draftPr = await pr.create(prInput(ids.draft), maker, m);
    expect(draftPr.prNumber).toMatch(/^PR-\d{4}-000001$/);
    // The existing approval gate still requires `active`.
    await pr.transition(draftPr.id, 'submit', maker, m);
    await expectRefused(pr.transition(draftPr.id, 'approve', checker, m), 'Cannot approve this Purchase Request');
  });
});
