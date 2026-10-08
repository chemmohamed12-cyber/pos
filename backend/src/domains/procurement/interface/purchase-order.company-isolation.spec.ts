import { randomUUID } from 'crypto';
import { ForbiddenException } from '@nestjs/common';
import { PurchaseOrderService } from '../application/purchase-order.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { PurchaseOrder } from '../infrastructure/purchase-order.entity';
import { makeProductLifecycleGate } from './product-lifecycle-gate.test-helper';
import { makeWarehouseLookup } from './warehouse-lookup.test-helper';
import {
  setUpTwoCompanyHarness,
  TwoCompanyHarness,
  assertDataSourceNeverRequestedFor,
} from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Area 21 Operational Company Scoping Retrofit (2026-09-28, CTO-authorized).
 * Real-Postgres proof that `purchase-order.controller.ts`'s reads/writes are
 * genuinely Company-scoped — two real, separately provisioned Company
 * databases, each with its own supplier, warehouse and Purchase Orders,
 * never mocked. `create` exercises the un-threaded
 * `registerDocumentType('purchase_order')` call, the Company-manager
 * transaction, the real Process Engine start and the audit write.
 */
describe('PurchaseOrderController Area 21 retrofit — real-Postgres Company isolation (2026-09-28)', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let service: PurchaseOrderService;
  const actorUserId = randomUUID();
  const approverUserId = randomUUID(); // ESC-3 — a DIFFERENT user from the maker approves

  const seeded: Record<'A' | 'B', { supplierId: string; warehouseId: string; productId: string; purchaseOrderId: string }> = {
    A: { supplierId: '', warehouseId: '', productId: '', purchaseOrderId: '' },
    B: { supplierId: '', warehouseId: '', productId: '', purchaseOrderId: '' },
  };

  async function seedCompanyData(companyId: string, key: 'A' | 'B', code: string) {
    const ds = await h.connections.getDataSource(companyId);
    const supplierId = randomUUID();
    const warehouseId = randomUUID();
    const productId = randomUUID();
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [
      actorUserId,
      'Isolation Test Buyer',
      `iso-buyer-${companyId}@test.local`,
    ]);
    await ds.query(`INSERT INTO "warehouses" ("id","code","name","status") VALUES ($1,$2,$3,'active')`, [warehouseId, `WH-${code}`, `${code} Warehouse`]);
    await ds.query(`INSERT INTO "products" ("id","sku","name","unitPrice","status") VALUES ($1,$2,$3,'10.00','active')`, [
      productId,
      `SKU-${code}`,
      `${code} Product`,
    ]);
    await ds.query(`INSERT INTO "suppliers" ("id","code","legalName") VALUES ($1,$2,$3)`, [supplierId, `SUP-${code}`, `${code} Supplier`]);
    seeded[key] = { supplierId, warehouseId, productId, purchaseOrderId: '' };
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'po_isolation', extraCompanyTags: ['sales', 'inventory', 'procurement'] });
    await seedCompanyData(h.companyAId, 'A', 'A');
    await seedCompanyData(h.companyBId, 'B', 'B');

    const audit = new AuditService(h.controlPlane);
    const numbering = new NumberingService(h.controlPlane);
    const processEngine = new ProcessEngineService(h.controlPlane);
    service = new PurchaseOrderService(h.controlPlane, processEngine, numbering, audit, makeProductLifecycleGate(h.controlPlane), makeWarehouseLookup(h.controlPlane));
  });

  afterAll(async () => {
    await h.teardown();
  });

  it("create for Company A writes the PO + line + process instance inside Company A's own database", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const po = await service.create(
      { supplierId: seeded.A.supplierId, warehouseId: seeded.A.warehouseId, lines: [{ productId: seeded.A.productId, quantity: '10', unitCostBase: '5.00' }] },
      actorUserId,
      dsA.manager,
    );
    seeded.A.purchaseOrderId = po.id;
    expect(po.totalAmountBase).toBe('50.00');
    expect(await dsA.getRepository(PurchaseOrder).findOne({ where: { id: po.id } })).toBeTruthy();
  });

  it("create for Company B writes independently in Company B's own database", async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    const po = await service.create(
      { supplierId: seeded.B.supplierId, warehouseId: seeded.B.warehouseId, lines: [{ productId: seeded.B.productId, quantity: '2', unitCostBase: '9.00' }] },
      actorUserId,
      dsB.manager,
    );
    seeded.B.purchaseOrderId = po.id;
    expect(await dsB.getRepository(PurchaseOrder).findOne({ where: { id: seeded.A.purchaseOrderId } })).toBeNull();
  });

  it("create against Company A's supplier through Company B's manager is rejected (wrong-resource-id DENY)", async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    await expect(
      service.create({ supplierId: seeded.A.supplierId, warehouseId: seeded.B.warehouseId, lines: [{ productId: seeded.B.productId, quantity: '1', unitCostBase: '1.00' }] }, actorUserId, dsB.manager),
    ).rejects.toThrow(/not found/i);
  });

  it("transition submit -> approve for Company A moves only Company A's PO", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    expect((await service.transition(seeded.A.purchaseOrderId, 'submit', actorUserId, dsA.manager)).state).toBe('submitted');
    expect((await service.transition(seeded.A.purchaseOrderId, 'approve', approverUserId, dsA.manager)).state).toBe('approved');

    const dsB = await h.connections.getDataSource(h.companyBId);
    const b = await service.getById(seeded.B.purchaseOrderId, dsB.manager);
    expect(b.state).toBe('draft');
  });

  it("list via Company A resolves only Company A's PO (state approved); via Company B only Company B's (state draft)", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const dsB = await h.connections.getDataSource(h.companyBId);
    const a = await service.list(dsA.manager);
    const b = await service.list(dsB.manager);
    expect(a.map((p) => [p.id, p.state])).toEqual([[seeded.A.purchaseOrderId, 'approved']]);
    expect(b.map((p) => [p.id, p.state])).toEqual([[seeded.B.purchaseOrderId, 'draft']]);
  });

  it("getById / transition of Company A's PO id through Company B's manager is rejected (A→B DENY)", async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    await expect(service.getById(seeded.A.purchaseOrderId, dsB.manager)).rejects.toThrow(/not found/i);
    await expect(service.transition(seeded.A.purchaseOrderId, 'cancel', actorUserId, dsB.manager)).rejects.toThrow(/not found/i);
  });

  it('ESC-3 (maker != checker): the user who created a PO cannot approve it — refused before any state change and audited; a DIFFERENT user approves it; Company B is untouched', async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const po = await service.create({ supplierId: seeded.A.supplierId, warehouseId: seeded.A.warehouseId, lines: [{ productId: seeded.A.productId, quantity: '2', unitCostBase: '3.00' }] }, actorUserId, dsA.manager);
    await service.transition(po.id, 'submit', actorUserId, dsA.manager);

    await expect(service.transition(po.id, 'approve', actorUserId, dsA.manager)).rejects.toBeInstanceOf(ForbiddenException);
    expect((await service.getById(po.id, dsA.manager)).state).toBe('submitted'); // unchanged
    const denied = await dsA.query(`SELECT result, action FROM audit_records WHERE "resourceId" = $1 AND action = 'purchase_order.approve'`, [po.id]);
    expect(denied).toEqual([{ result: 'failure', action: 'purchase_order.approve' }]);

    expect((await service.transition(po.id, 'approve', approverUserId, dsA.manager)).state).toBe('approved'); // another user, same permission model
    expect((await service.getById(po.id, dsA.manager)).state).toBe('approved');

    const dsB = await h.connections.getDataSource(h.companyBId);
    expect((await service.getById(seeded.B.purchaseOrderId, dsB.manager)).state).toBe('draft'); // Company B unaffected
    await expect(service.transition(po.id, 'approve', approverUserId, dsB.manager)).rejects.toThrow(/not found/i); // A's PO is invisible to B
  });

  it('ESC-3 scope: only APPROVE is gated — the maker may still submit and cancel their own PO (existing workflow unchanged)', async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const po = await service.create({ supplierId: seeded.A.supplierId, warehouseId: seeded.A.warehouseId, lines: [{ productId: seeded.A.productId, quantity: '1', unitCostBase: '1.00' }] }, actorUserId, dsA.manager);
    expect((await service.transition(po.id, 'submit', actorUserId, dsA.manager)).state).toBe('submitted');
    expect((await service.transition(po.id, 'cancel', actorUserId, dsA.manager)).state).toBe('cancelled');
  });

  it("Test F — resolving Company A's purchase orders never even requests Company B's DataSource", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      await service.list(dsA.manager);
      await service.getById(seeded.A.purchaseOrderId, dsA.manager);
    });
  });
});
