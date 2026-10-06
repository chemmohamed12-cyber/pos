import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { RfqService } from '../application/rfq.service';
import { InventoryService } from '../../inventory-warehouse/application/inventory.service';
import { PurchaseOrderService } from '../application/purchase-order.service';
import { PurchaseRequestService } from '../application/purchase-request.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { ApprovalEngineService } from '../../../foundation/approval-engine/approval-engine.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { PermissionService } from '../../../foundation/permission/permission.service';
import { AuthorizationService } from '../../../foundation/authorization/authorization.service';
import { setUpTwoCompanyHarness, TwoCompanyHarness, assertDataSourceNeverRequestedFor } from '../../../foundation/testing/two-company-real-pg-harness';
import { createAmbientDataSource } from '../../../foundation/testing/ambient-test-datasource';
import { makeProductLifecycleGate } from './product-lifecycle-gate.test-helper';

/**
 * D6 (2026-10-05) — RFQ award visibility, real PostgreSQL, Company A with Company B as the untouched witness.
 * The maker-checker rule is KEPT (maker ≠ checker, checker holds `procurement.rfq_award` at editable, 1 approver by default);
 * D6 only makes the award's state visible: the RFQ detail reports the latest award request (`approvalRequestId`, pending /
 * approved / rejected, who must approve, the resulting Purchase Order), and a second submission while one is still pending
 * is rejected instead of silently stacking another approval.
 */
describe('D6 — RFQ award approval visibility (maker-checker unchanged) — real-Postgres, A/B', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let ambient: DataSource;
  let rfqs: RfqService;
  let requests: PurchaseRequestService;
  let approvals: ApprovalEngineService;
  let maker: string;
  let checker: string;
  let warehouseId = '';
  let productId = '';
  let supplierId = '';

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'd6_rfq_award', extraCompanyTags: ['sales', 'inventory', 'procurement'] });
    ambient = await createAmbientDataSource(h);
    const inert = {} as never;
    const audit = new AuditService(ambient);
    const events = new EventBusService(inert, h.connections);
    const process = new ProcessEngineService(ambient);
    const numbering = new NumberingService(ambient);
    approvals = new ApprovalEngineService(ambient, process, audit, events, new PermissionService(inert, new AuthorizationService(inert, inert)), { get: () => 24 } as never);
    const pos = new PurchaseOrderService(ambient, process, numbering, audit, makeProductLifecycleGate(ambient));
    rfqs = new RfqService(ambient, process, numbering, audit, events, approvals, pos);
    requests = new PurchaseRequestService(ambient, process, numbering, audit, makeProductLifecycleGate(ambient));
    await rfqs.onModuleInit();

    maker = (await h.createUserWithAdminRoleIn('Award Maker', h.companyAId)).id;
    checker = (await h.createUserWithAdminRoleIn('Award Checker', h.companyAId)).id;
    const ds = await h.connections.getDataSource(h.companyAId);
    const role = (await ds.query(`SELECT id FROM roles WHERE key = 'admin'`))[0];
    await ds.query(`INSERT INTO role_permissions ("roleId","nodeKey","access") VALUES ($1,'procurement.rfq_award','editable') ON CONFLICT DO NOTHING`, [role.id]);
    warehouseId = randomUUID();
    productId = randomUUID();
    supplierId = randomUUID();
    await ds.query(`INSERT INTO "warehouses" ("id","code","name","status") VALUES ($1,'WH-D6','D6 Warehouse','active')`, [warehouseId]);
    await ds.query(`INSERT INTO "products" ("id","sku","name","unitPrice","status") VALUES ($1,'SKU-D6','D6 Product','10.00','active')`, [productId]);
    await ds.query(`INSERT INTO "suppliers" ("id","code","legalName") VALUES ($1,'SUP-D6','D6 Supplier')`, [supplierId]);
  });

  afterAll(async () => {
    if (ambient?.isInitialized) await ambient.destroy();
    await h.teardown().catch((e) => console.warn('D6 teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  const mgr = async (id: string) => (await h.connections.getDataSource(id)).manager;

  /** A sent RFQ with one recorded quotation (5 units @ 9.50 = 47.50). */
  async function sentRfqWithQuotation() {
    const mA = await mgr(h.companyAId);
    const pr = await requests.create({ warehouseId, lines: [{ productId, quantity: '5' }] }, maker, mA);
    await requests.transition(pr.id, 'submit', maker, mA);
    await requests.transition(pr.id, 'approve', checker, mA);
    const rfqId = (await requests.createRfqFromRequest(pr.id, [supplierId], null, maker, mA)).id;
    await rfqs.send(rfqId, maker, mA);
    const prLines = (await rfqs.getById(rfqId, mA)).purchaseRequestLines;
    const quotation = await rfqs.recordQuotation({ rfqId, supplierId, lines: [{ purchaseRequestLineId: prLines[0].id, quantity: '5', unitCostBase: '9.50' }] }, maker, mA);
    return { rfqId, quotationId: quotation.id };
  }
  const approvalCount = async () => Number((await (await h.connections.getDataSource(h.companyAId)).query(`SELECT count(*) AS n FROM approval_requests WHERE "requestTypeCode" = 'procurement.rfq_award'`))[0].n);

  it('1. before any award there is nothing pending: awardApproval is null', async () => {
    const mA = await mgr(h.companyAId);
    const { rfqId } = await sentRfqWithQuotation();
    expect((await rfqs.getById(rfqId, mA)).awardApproval).toBeNull();
  });

  it('2. SUBMITTED award is VISIBLE: the RFQ detail reports the pending request id, the maker, the node a DIFFERENT user must hold, the supplier and total; the RFQ stays "sent", no PO yet', async () => {
    const mA = await mgr(h.companyAId);
    const { rfqId, quotationId } = await sentRfqWithQuotation();
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      const award = await rfqs.awardToSupplier(rfqId, quotationId, maker, mA);
      const detail = await rfqs.getById(rfqId, mA);
      expect(detail.state).toBe('sent');
      expect(detail.awardApproval).toMatchObject({
        approvalRequestId: award.approvalRequestId,
        state: 'pending',
        makerUserId: maker,
        requiredNode: 'procurement.rfq_award',
        minApprovers: 1,
        approvedCount: 0,
        quotationId,
        supplierId,
        totalAmount: '47.50',
        purchaseOrderId: null,
        purchaseOrderNumber: null,
      });
    });
  });

  it('3. a SECOND award while one is pending is rejected and names the pending request — no second approval request is created', async () => {
    const mA = await mgr(h.companyAId);
    const { rfqId, quotationId } = await sentRfqWithQuotation();
    const award = await rfqs.awardToSupplier(rfqId, quotationId, maker, mA);
    const before = await approvalCount();
    await expect(rfqs.awardToSupplier(rfqId, quotationId, maker, mA)).rejects.toThrow(new RegExp(award.approvalRequestId));
    expect(await approvalCount()).toBe(before);
  });

  it('4. maker-checker is UNCHANGED: the maker cannot approve their own award (still pending); a DIFFERENT user approves → state approved, PO created and linked, RFQ awarded', async () => {
    const mA = await mgr(h.companyAId);
    const { rfqId, quotationId } = await sentRfqWithQuotation();
    const award = await rfqs.awardToSupplier(rfqId, quotationId, maker, mA);
    await expect(approvals.decide(award.approvalRequestId, maker, 'approved', null, mA)).rejects.toThrow();
    expect((await rfqs.getById(rfqId, mA)).awardApproval?.state).toBe('pending');

    await approvals.decide(award.approvalRequestId, checker, 'approved', null, mA);
    const detail = await rfqs.getById(rfqId, mA);
    expect(detail.state).toBe('awarded');
    expect(detail.awardApproval).toMatchObject({ state: 'approved', approvedCount: 1 });
    expect(detail.awardApproval?.purchaseOrderId).toBeTruthy();
    expect(detail.awardApproval?.purchaseOrderNumber).toMatch(/^PO/);
  });

  it('5. REJECTED award is visible as rejected, the RFQ stays "sent", and it can be awarded again (a new request)', async () => {
    const mA = await mgr(h.companyAId);
    const { rfqId, quotationId } = await sentRfqWithQuotation();
    const first = await rfqs.awardToSupplier(rfqId, quotationId, maker, mA);
    await approvals.decide(first.approvalRequestId, checker, 'rejected', 'price too high', mA);
    let detail = await rfqs.getById(rfqId, mA);
    expect(detail.state).toBe('sent');
    expect(detail.awardApproval).toMatchObject({ approvalRequestId: first.approvalRequestId, state: 'rejected' });

    const second = await rfqs.awardToSupplier(rfqId, quotationId, maker, mA);
    expect(second.approvalRequestId).not.toBe(first.approvalRequestId);
    detail = await rfqs.getById(rfqId, mA);
    expect(detail.awardApproval).toMatchObject({ approvalRequestId: second.approvalRequestId, state: 'pending' });
  });

  it("7. PRC-01 STOCK VISIBILITY: the RFQ detail carries the request's warehouse, and the OFFICIAL on-hand / reserved / available for its items come per warehouse from the movements (another warehouse's stock is never mixed in)", async () => {
    const mA = await mgr(h.companyAId);
    const ds = await h.connections.getDataSource(h.companyAId);
    const otherWh = randomUUID();
    await ds.query(`INSERT INTO "warehouses" ("id","code","name","status") VALUES ($1,'WH-D6-2','Other','active')`, [otherWh]);
    await ds.query(`INSERT INTO "stock_movements" ("id","warehouseId","productId","quantity","movementType") VALUES ($1,$2,$3,40,'receipt'), ($4,$5,$3,9,'receipt')`, [randomUUID(), warehouseId, productId, randomUUID(), otherWh]);
    await ds.query(`INSERT INTO "stock_reservations" ("id","warehouseId","productId","quantity","salesOrderId","status") VALUES ($1,$2,$3,15,$4,'active')`, [randomUUID(), warehouseId, productId, randomUUID()]);

    const { rfqId } = await sentRfqWithQuotation();
    const detail = await rfqs.getById(rfqId, mA);
    expect(detail.warehouseId).toBe(warehouseId);

    const inert = {} as never;
    const inventory = new InventoryService(ambient, new AuditService(ambient), inert, inert, inert, inert, undefined);
    expect(await inventory.getOnHand(detail.warehouseId!, productId, mA)).toBe(40); // this warehouse only — the other one's 9 is not mixed in
    expect(await inventory.getReserved(detail.warehouseId!, productId, mA)).toBe(15);
    expect(await inventory.getAvailable(detail.warehouseId!, productId, mA)).toBe(25);
    expect(await inventory.getOnHand(otherWh, productId, mA)).toBe(9);
  });

  it('6. ISOLATION: Company B cannot see A\'s RFQ or its award, and has no approval requests, RFQs or POs of its own', async () => {
    const mA = await mgr(h.companyAId);
    const mB = await mgr(h.companyBId);
    const { rfqId, quotationId } = await sentRfqWithQuotation();
    await rfqs.awardToSupplier(rfqId, quotationId, maker, mA);
    await expect(rfqs.getById(rfqId, mB)).rejects.toBeInstanceOf(NotFoundException);
    expect(await rfqs.getAwardApproval(rfqId, mB)).toBeNull();
    for (const t of ['approval_requests', 'rfqs', 'purchase_orders', 'supplier_quotations']) {
      expect({ t, n: Number((await mB.query(`SELECT count(*) AS n FROM "${t}"`))[0].n) }).toEqual({ t, n: 0 });
    }
  });
});
