import { randomUUID } from 'crypto';
import { ForbiddenException } from '@nestjs/common';
import { PurchaseRequestService } from '../application/purchase-request.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { PurchaseRequest } from '../infrastructure/purchase-request.entity';
import { makeProductLifecycleGate } from './product-lifecycle-gate.test-helper';
import { makeWarehouseLookup } from './warehouse-lookup.test-helper';
import {
  setUpTwoCompanyHarness,
  TwoCompanyHarness,
  assertDataSourceNeverRequestedFor,
} from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Area 21 Operational Company Scoping Retrofit (2026-09-28, CTO-authorized).
 * Real-Postgres proof that `purchase-request.controller.ts`'s reads/writes
 * are genuinely Company-scoped — two real, separately provisioned Company
 * databases, each with its own warehouse, product, suppliers and Purchase
 * Requests, never mocked. `createRfqFromRequest` is the deep-chain proof:
 * one transaction writing the RFQ + supplier invites, starting the RFQ
 * process and converting the PR's own process state.
 */
describe('PurchaseRequestController Area 21 retrofit — real-Postgres Company isolation (2026-09-28)', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let service: PurchaseRequestService;
  const actorUserId = randomUUID();
  const approverUserId = randomUUID(); // ESC-3 — a DIFFERENT user from the maker approves

  const seeded: Record<'A' | 'B', { warehouseId: string; productId: string; supplierId: string; purchaseRequestId: string }> = {
    A: { warehouseId: '', productId: '', supplierId: '', purchaseRequestId: '' },
    B: { warehouseId: '', productId: '', supplierId: '', purchaseRequestId: '' },
  };

  async function seedCompanyData(companyId: string, key: 'A' | 'B', code: string) {
    const ds = await h.connections.getDataSource(companyId);
    const warehouseId = randomUUID();
    const productId = randomUUID();
    const supplierId = randomUUID();
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [
      actorUserId,
      'Isolation Test Requester',
      `iso-req-${companyId}@test.local`,
    ]);
    await ds.query(`INSERT INTO "warehouses" ("id","code","name","status") VALUES ($1,$2,$3,'active')`, [warehouseId, `WH-${code}`, `${code} Warehouse`]);
    await ds.query(`INSERT INTO "products" ("id","sku","name","unitPrice","status") VALUES ($1,$2,$3,'10.00','active')`, [
      productId,
      `SKU-${code}`,
      `${code} Product`,
    ]);
    await ds.query(`INSERT INTO "suppliers" ("id","code","legalName") VALUES ($1,$2,$3)`, [supplierId, `SUP-${code}`, `${code} Supplier`]);
    seeded[key] = { warehouseId, productId, supplierId, purchaseRequestId: '' };
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'pr_isolation', extraCompanyTags: ['sales', 'inventory', 'procurement'] });
    await seedCompanyData(h.companyAId, 'A', 'A');
    await seedCompanyData(h.companyBId, 'B', 'B');

    const audit = new AuditService(h.controlPlane);
    const numbering = new NumberingService(h.controlPlane);
    const processEngine = new ProcessEngineService(h.controlPlane);
    service = new PurchaseRequestService(h.controlPlane, processEngine, numbering, audit, makeProductLifecycleGate(h.controlPlane), makeWarehouseLookup(h.controlPlane));
  });

  afterAll(async () => {
    await h.teardown();
  });

  it("create for Company A writes the PR + line + process instance inside Company A's own database", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const pr = await service.create({ warehouseId: seeded.A.warehouseId, lines: [{ productId: seeded.A.productId, quantity: '5' }] }, actorUserId, dsA.manager);
    seeded.A.purchaseRequestId = pr.id;
    expect(await dsA.getRepository(PurchaseRequest).findOne({ where: { id: pr.id } })).toBeTruthy();
  });

  it("create for Company B writes independently in Company B's own database", async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    const pr = await service.create({ warehouseId: seeded.B.warehouseId, lines: [{ productId: seeded.B.productId, quantity: '2' }] }, actorUserId, dsB.manager);
    seeded.B.purchaseRequestId = pr.id;
    expect(await dsB.getRepository(PurchaseRequest).findOne({ where: { id: seeded.A.purchaseRequestId } })).toBeNull();
  });

  it("submit -> approve -> create RFQ for Company A converts only Company A's PR and writes the RFQ into Company A's database", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    expect((await service.transition(seeded.A.purchaseRequestId, 'submit', actorUserId, dsA.manager)).state).toBe('submitted');
    expect((await service.transition(seeded.A.purchaseRequestId, 'approve', approverUserId, dsA.manager)).state).toBe('approved');
    const rfq = await service.createRfqFromRequest(seeded.A.purchaseRequestId, [seeded.A.supplierId], null, actorUserId, dsA.manager);
    expect(rfq.purchaseRequestId).toBe(seeded.A.purchaseRequestId);

    const rfqsA: Array<{ id: string }> = await dsA.query(`SELECT id FROM "rfqs"`);
    expect(rfqsA).toHaveLength(1);
    const dsB = await h.connections.getDataSource(h.companyBId);
    const rfqsB: Array<{ id: string }> = await dsB.query(`SELECT id FROM "rfqs"`);
    expect(rfqsB).toHaveLength(0);
    expect((await service.getById(seeded.A.purchaseRequestId, dsA.manager)).state).toBe('converted_to_rfq');
    expect((await service.getById(seeded.B.purchaseRequestId, dsB.manager)).state).toBe('draft');
  });

  it("list via Company A resolves only Company A's PR; via Company B only Company B's", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const dsB = await h.connections.getDataSource(h.companyBId);
    expect((await service.list(dsA.manager)).map((p) => p.id)).toEqual([seeded.A.purchaseRequestId]);
    expect((await service.list(dsB.manager)).map((p) => p.id)).toEqual([seeded.B.purchaseRequestId]);
  });

  it("getById / transition / createRfq of Company A's PR id through Company B's manager is rejected (A→B DENY)", async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    await expect(service.getById(seeded.A.purchaseRequestId, dsB.manager)).rejects.toThrow(/not found/i);
    await expect(service.transition(seeded.A.purchaseRequestId, 'cancel', actorUserId, dsB.manager)).rejects.toThrow(/not found/i);
    await expect(service.createRfqFromRequest(seeded.A.purchaseRequestId, [seeded.B.supplierId], null, actorUserId, dsB.manager)).rejects.toThrow(/not found/i);
  });

  it('ESC-3 (maker != checker): the requester cannot approve their own PR — refused before any state change and audited; a DIFFERENT user approves it; Company B is untouched', async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const pr = await service.create({ warehouseId: seeded.A.warehouseId, lines: [{ productId: seeded.A.productId, quantity: '1' }] }, actorUserId, dsA.manager);
    await service.transition(pr.id, 'submit', actorUserId, dsA.manager);

    await expect(service.transition(pr.id, 'approve', actorUserId, dsA.manager)).rejects.toBeInstanceOf(ForbiddenException);
    expect((await service.getById(pr.id, dsA.manager)).state).toBe('submitted'); // unchanged
    const denied = await dsA.query(`SELECT result, action FROM audit_records WHERE "resourceId" = $1 AND action = 'purchase_request.approve'`, [pr.id]);
    expect(denied).toEqual([{ result: 'failure', action: 'purchase_request.approve' }]);

    expect((await service.transition(pr.id, 'approve', approverUserId, dsA.manager)).state).toBe('approved'); // another user, same permission model
    const dsB = await h.connections.getDataSource(h.companyBId);
    await expect(service.transition(pr.id, 'approve', approverUserId, dsB.manager)).rejects.toThrow(/not found/i); // A's PR is invisible to B
  });

  it('ESC-3 scope: only APPROVE is gated — the requester may still submit, and cancel, their own PR (existing workflow unchanged)', async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const pr = await service.create({ warehouseId: seeded.A.warehouseId, lines: [{ productId: seeded.A.productId, quantity: '1' }] }, actorUserId, dsA.manager);
    expect((await service.transition(pr.id, 'submit', actorUserId, dsA.manager)).state).toBe('submitted');
    expect((await service.transition(pr.id, 'cancel', actorUserId, dsA.manager)).state).toBe('cancelled');
  });

  it("Test F — resolving Company A's purchase requests never even requests Company B's DataSource", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      await service.list(dsA.manager);
      await service.getById(seeded.A.purchaseRequestId, dsA.manager);
    });
  });
});
