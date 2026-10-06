import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { NewItemRequestService } from '../application/new-item-request.service';
import { PurchaseRequestService } from '../application/purchase-request.service';
import { PurchaseOrderService } from '../application/purchase-order.service';
import { ProductsService } from '../../commerce/application/products.service';
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
 * D7 (2026-10-05, CTO decision) — New Item Request, real PostgreSQL, Company A with Company B as the witness.
 * Draft Product = the request (productId stays NOT NULL through PR → RFQ → PO → GR, no relinking); ONE approver holding
 * `sales.catalog.edit` (maker ≠ checker) activates it through the Approval Engine; Purchase Request APPROVAL is the gate, and
 * RFQ / PO / GR refuse a draft item whatever path reaches them.
 */
describe('D7 — New Item Request + product lifecycle gate — real-Postgres, A/B', () => {
  jest.setTimeout(580_000);
  let h: TwoCompanyHarness;
  let ambient: DataSource;
  let items: NewItemRequestService;
  let requests: PurchaseRequestService;
  let orders: PurchaseOrderService;
  let approvals: ApprovalEngineService;
  let requester: string;
  let checker: string;
  let buyer: string; // holds procurement.* only — NOT sales.catalog.edit
  let warehouseId = '';
  let supplierId = '';
  let activeProductId = '';
  const mgr = async (id: string) => (await h.connections.getDataSource(id)).manager;
  const count = async (m: Awaited<ReturnType<typeof mgr>>, table: string) => Number((await m.query(`SELECT count(*) AS n FROM "${table}"`))[0].n);

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'd7_new_item', extraCompanyTags: ['sales', 'inventory', 'procurement'] });
    ambient = await createAmbientDataSource(h);
    const inert = {} as never;
    const audit = new AuditService(ambient);
    const events = new EventBusService(inert, h.connections);
    const process = new ProcessEngineService(ambient);
    const numbering = new NumberingService(ambient);
    approvals = new ApprovalEngineService(ambient, process, audit, events, new PermissionService(inert, new AuthorizationService(inert, inert)), { get: () => 24 } as never);
    const products = new ProductsService(ambient, audit, events);
    items = new NewItemRequestService(ambient, audit, approvals, events, numbering, products);
    const gate = makeProductLifecycleGate(ambient);
    requests = new PurchaseRequestService(ambient, process, numbering, audit, gate);
    orders = new PurchaseOrderService(ambient, process, numbering, audit, gate);
    await items.onModuleInit();

    requester = (await h.createUserWithAdminRoleIn('Item Requester', h.companyAId)).id;
    checker = (await h.createUserWithAdminRoleIn('Catalog Owner', h.companyAId)).id;
    const ds = await h.connections.getDataSource(h.companyAId);
    // A limited user: role "buyer" with only the `procurement` grant (no `sales` ancestor of sales.catalog.edit).
    const buyerUser = await h.users.create({ fullName: 'Plain Buyer', email: 'plain-buyer@test.local' });
    await h.memberships.create({ userId: buyerUser.id, companyId: h.companyAId, roleKey: 'buyer' });
    buyer = buyerUser.id;
    const buyerRoleId = randomUUID();
    await ds.query(`INSERT INTO roles ("id","key") VALUES ($1,'buyer')`, [buyerRoleId]);
    await ds.query(`INSERT INTO role_permissions ("roleId","nodeKey","access") VALUES ($1,'procurement','editable')`, [buyerRoleId]);
    await ds.query(`INSERT INTO user_roles ("userId","roleId") VALUES ($1,$2)`, [buyer, buyerRoleId]);
    warehouseId = randomUUID();
    supplierId = randomUUID();
    activeProductId = randomUUID();
    await ds.query(`INSERT INTO "warehouses" ("id","code","name","status") VALUES ($1,'WH-D7','D7 Warehouse','active')`, [warehouseId]);
    await ds.query(`INSERT INTO "suppliers" ("id","code","legalName") VALUES ($1,'SUP-D7','D7 Supplier')`, [supplierId]);
    await ds.query(`INSERT INTO "products" ("id","sku","name","unitPrice","status") VALUES ($1,'SKU-D7-ACTIVE','Existing Item','10.00','active')`, [activeProductId]);
  });

  afterAll(async () => {
    if (ambient?.isInitialized) await ambient.destroy();
    await h.teardown().catch((e) => console.warn('D7 teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  let first: { productId: string; approvalRequestId: string; sku: string; itemRequestId: string };

  it('1. CREATE: a draft Product (system SKU, price 0) + a request record (requester, reason, pending) + an approval request needing ONE approver holding sales.catalog.edit', async () => {
    const mA = await mgr(h.companyAId);
    const created = await items.create({ name: 'Industrial Gasket 12mm', unit: 'pcs', reason: 'Needed for line 3 maintenance' }, requester, mA);
    first = { productId: created.productId, approvalRequestId: created.approvalRequestId, sku: created.sku, itemRequestId: created.request.id };
    expect(created.sku).toBe('NEW-000001');
    const product = (await mA.query(`SELECT sku, name, unit, "unitPrice", status FROM products WHERE id = $1`, [created.productId]))[0];
    expect(product).toMatchObject({ sku: 'NEW-000001', name: 'Industrial Gasket 12mm', unit: 'pcs', status: 'draft' });
    expect(Number(product.unitPrice)).toBe(0);
    const view = await items.getById(created.request.id, mA);
    expect(view).toMatchObject({ status: 'pending', requestedByUserId: requester, reason: 'Needed for line 3 maintenance', productStatus: 'draft', sku: 'NEW-000001' });
    const approval = await approvals.getRequest(created.approvalRequestId, mA);
    expect(approval).toMatchObject({ requestTypeCode: 'procurement.new_item_request', resourceId: created.productId, resolvedRequiredNode: 'sales.catalog.edit', resolvedMinApprovers: 1, makerUserId: requester });
    expect(approval.state).toBe('pending');
  });

  it('2. ATOMICITY: an invalid request (no reason / no name) is refused before anything is created — no product, no request, no approval, no SKU consumed', async () => {
    const mA = await mgr(h.companyAId);
    const before = [await count(mA, 'products'), await count(mA, 'product_item_requests'), await count(mA, 'approval_requests')];
    await expect(items.create({ name: 'No reason', reason: '   ' }, requester, mA)).rejects.toBeInstanceOf(BadRequestException);
    await expect(items.create({ name: '  ', reason: 'x' }, requester, mA)).rejects.toBeInstanceOf(BadRequestException);
    expect([await count(mA, 'products'), await count(mA, 'product_item_requests'), await count(mA, 'approval_requests')]).toEqual(before);
  });

  it('3. GATE at PR approval: a PR carrying the draft item can be created and submitted but NOT approved — refused before the transition, state unchanged, no RFQ; an active-only PR approves normally', async () => {
    const mA = await mgr(h.companyAId);
    const pr = await requests.create({ warehouseId, lines: [{ productId: activeProductId, quantity: '2' }, { productId: first.productId, quantity: '5' }] }, requester, mA);
    await requests.transition(pr.id, 'submit', requester, mA);
    await expect(requests.transition(pr.id, 'approve', requester, mA)).rejects.toThrow(/NEW-000001.*draft/);
    expect((await requests.getById(pr.id, mA)).state).toBe('submitted');
    await expect(requests.createRfqFromRequest(pr.id, [supplierId], null, requester, mA)).rejects.toBeInstanceOf(ConflictException); // not approved
    expect(await count(mA, 'rfqs')).toBe(0);

    const ok = await requests.create({ warehouseId, lines: [{ productId: activeProductId, quantity: '3' }] }, requester, mA); // existing flow unaffected
    await requests.transition(ok.id, 'submit', requester, mA);
    expect((await requests.transition(ok.id, 'approve', requester, mA)).state).toBe('approved');
    expect((await requests.createRfqFromRequest(ok.id, [supplierId], null, requester, mA)).rfqNumber).toBeTruthy();
  });

  it('4. NO BYPASS: a Purchase Order that carries the draft item is refused (nothing created); the same PO on an active item is created', async () => {
    const mA = await mgr(h.companyAId);
    const before = await count(mA, 'purchase_orders');
    await expect(orders.create({ supplierId, warehouseId, lines: [{ productId: first.productId, quantity: '5', unitCostBase: '4.00' }] }, requester, mA)).rejects.toThrow(/draft item/);
    expect(await count(mA, 'purchase_orders')).toBe(before);
    const po = await orders.create({ supplierId, warehouseId, lines: [{ productId: activeProductId, quantity: '5', unitCostBase: '4.00' }] }, requester, mA);
    expect(po.poNumber).toBeTruthy();
  });

  it('5. AUTHORIZATION: the requester cannot approve their own request (maker ≠ checker); a different user WITHOUT sales.catalog.edit cannot either; the item stays draft', async () => {
    const mA = await mgr(h.companyAId);
    await expect(approvals.decide(first.approvalRequestId, requester, 'approved', null, mA)).rejects.toThrow();
    await expect(approvals.decide(first.approvalRequestId, buyer, 'approved', null, mA)).rejects.toThrow(/Not authorized.*sales.catalog.edit/);
    expect((await items.getById(first.itemRequestId, mA)).productStatus).toBe('draft');
    expect((await items.getById(first.itemRequestId, mA)).status).toBe('pending');
  });

  it('6. APPROVAL: a user holding sales.catalog.edit approves → the product is ACTIVE, the request is approved with the decider recorded; PR approval and the RFQ now pass', async () => {
    const mA = await mgr(h.companyAId);
    await approvals.decide(first.approvalRequestId, checker, 'approved', null, mA);

    const view = await items.getById(first.itemRequestId, mA);
    expect(view).toMatchObject({ status: 'approved', decidedByUserId: checker, productStatus: 'active' });
    expect(view.decidedAt).toBeTruthy();

    const pr = await requests.create({ warehouseId, lines: [{ productId: first.productId, quantity: '5' }] }, requester, mA);
    await requests.transition(pr.id, 'submit', requester, mA);
    expect((await requests.transition(pr.id, 'approve', requester, mA)).state).toBe('approved');
    expect((await requests.createRfqFromRequest(pr.id, [supplierId], null, requester, mA)).id).toBeTruthy();
    const po = await orders.create({ supplierId, warehouseId, lines: [{ productId: first.productId, quantity: '5', unitCostBase: '4.00' }] }, requester, mA);
    expect(po.poNumber).toBeTruthy();
    const audits = await mA.query(`SELECT action FROM audit_records WHERE "resourceId" = $1 ORDER BY seq`, [first.itemRequestId]);
    expect(audits.map((a: { action: string }) => a.action)).toEqual(['procurement.new_item_request.created', 'procurement.new_item_request.approved']);
  });

  it('7. REJECTION: a rejected request leaves the product draft and the gate keeps blocking every document that references it', async () => {
    const mA = await mgr(h.companyAId);
    const second = await items.create({ name: 'Unneeded Widget', reason: 'Maybe useful' }, requester, mA);
    expect(second.sku).toBe('NEW-000002');
    await approvals.decide(second.approvalRequestId, checker, 'rejected', 'duplicate of an existing item', mA);
    const view = await items.getById(second.request.id, mA);
    expect(view).toMatchObject({ status: 'rejected', decidedByUserId: checker, productStatus: 'draft' });
    const pr = await requests.create({ warehouseId, lines: [{ productId: second.productId, quantity: '1' }] }, requester, mA);
    await requests.transition(pr.id, 'submit', requester, mA);
    await expect(requests.transition(pr.id, 'approve', requester, mA)).rejects.toThrow(/NEW-000002.*draft/);
    await expect(orders.create({ supplierId, warehouseId, lines: [{ productId: second.productId, quantity: '1', unitCostBase: '1' }] }, requester, mA)).rejects.toThrow(/draft item/);
    expect((await items.list('rejected', mA)).map((r) => r.id)).toEqual([second.request.id]);
  });

  it('8. ISOLATION: B sees none of A\'s requests/products/approvals and cannot decide A\'s approval; B has its own numbering; the Platform DB holds none of it; B\'s DataSource is never requested for A\'s calls', async () => {
    const mA = await mgr(h.companyAId);
    const mB = await mgr(h.companyBId);
    expect(await items.list(undefined, mB)).toEqual([]);
    await expect(items.getById(first.itemRequestId, mB)).rejects.toBeInstanceOf(NotFoundException);
    await expect(approvals.decide(first.approvalRequestId, checker, 'approved', null, mB)).rejects.toBeInstanceOf(NotFoundException);
    expect(await count(mB, 'products')).toBe(0);
    const bItem = await items.create({ name: 'B-Co Item', reason: 'B need' }, requester, mB);
    expect(bItem.sku).toBe('NEW-000001'); // B's own sequence
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      await items.list(undefined, mA);
      await items.create({ name: 'Another A item', reason: 'more' }, requester, mA);
    });
    expect((await items.list(undefined, mB)).map((r) => r.name)).toEqual(['B-Co Item']);
    // Platform (ambient) DB: no item-request table, no new-item approvals, no leaked products
    const platformTables = await ambient.query(`SELECT table_name FROM information_schema.tables WHERE table_name = 'product_item_requests'`);
    expect(platformTables).toEqual([]);
    expect(Number((await ambient.query(`SELECT count(*) AS n FROM approval_requests WHERE "requestTypeCode" = 'procurement.new_item_request'`))[0].n)).toBe(0);
  });
});
