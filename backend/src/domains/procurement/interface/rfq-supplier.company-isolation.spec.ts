import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { SupplierService } from '../application/supplier.service';
import { RfqService } from '../application/rfq.service';
import { PurchaseOrderService } from '../application/purchase-order.service';
import { PurchaseRequestService } from '../application/purchase-request.service';
import { SupplierBankAccount } from '../infrastructure/supplier-bank-account.entity';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { ApprovalEngineService } from '../../../foundation/approval-engine/approval-engine.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { PermissionService } from '../../../foundation/permission/permission.service';
import { AuthorizationService } from '../../../foundation/authorization/authorization.service';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../../../foundation/testing/two-company-real-pg-harness';
import { createAmbientDataSource } from '../../../foundation/testing/ambient-test-datasource';
import { makeProductLifecycleGate } from './product-lifecycle-gate.test-helper';
import { makeWarehouseLookup } from './warehouse-lookup.test-helper';

/**
 * Area 21 (2026-10-05, CTO-authorized) — real-Postgres Company isolation for `supplier.controller.ts` and
 * `rfq.controller.ts`, the two controllers that were blocked on the Approval Engine (Matrix §30). Two real
 * Company databases, the real Approval + Process engines and the company-scope approval subscribers:
 * suppliers (with contacts/addresses/bank accounts), the two-checker bank-account approval, and the RFQ
 * → quotation → award → Purchase Order chain live — and are approved — only inside their own Company.
 */
describe('SupplierController + RfqController Area 21 retrofit — real-Postgres Company isolation', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let ambient: DataSource;
  let suppliers: SupplierService;
  let rfqs: RfqService;
  let requests: PurchaseRequestService;
  let approvals: ApprovalEngineService;
  let makerA: string;
  let checker1: string;
  let checker2: string;
  const seeded: Record<'A' | 'B', { warehouseId: string; productId: string }> = { A: { warehouseId: '', productId: '' }, B: { warehouseId: '', productId: '' } };

  async function seed(companyId: string, key: 'A' | 'B') {
    const ds = await h.connections.getDataSource(companyId);
    const warehouseId = randomUUID();
    const productId = randomUUID();
    await ds.query(`INSERT INTO "warehouses" ("id","code","name","status") VALUES ($1,$2,$3,'active')`, [warehouseId, `WH-${key}`, `${key} Warehouse`]);
    await ds.query(`INSERT INTO "products" ("id","sku","name","unitPrice","status") VALUES ($1,$2,$3,'10.00','active')`, [productId, `SKU-${key}`, `${key} Product`]);
    seeded[key] = { warehouseId, productId };
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'rfq_supplier_isolation', extraCompanyTags: ['sales', 'inventory', 'procurement'] });
    ambient = await createAmbientDataSource(h);
    const inert = {} as never;
    const audit = new AuditService(ambient);
    const events = new EventBusService(inert, h.connections);
    const process = new ProcessEngineService(ambient);
    const numbering = new NumberingService(ambient);
    approvals = new ApprovalEngineService(ambient, process, audit, events, new PermissionService(inert, new AuthorizationService(inert, inert)), { get: () => 24 } as never);
    suppliers = new SupplierService(ambient, audit, approvals, numbering);
    const pos = new PurchaseOrderService(ambient, process, numbering, audit, makeProductLifecycleGate(ambient), makeWarehouseLookup(ambient));
    rfqs = new RfqService(ambient, process, numbering, audit, events, approvals, pos);
    requests = new PurchaseRequestService(ambient, process, numbering, audit, makeProductLifecycleGate(ambient), makeWarehouseLookup(ambient));
    await suppliers.onModuleInit();
    await rfqs.onModuleInit();

    makerA = (await h.createUserWithAdminRoleIn('Proc Maker A', h.companyAId)).id;
    checker1 = (await h.createUserWithAdminRoleIn('Proc Checker 1', h.companyAId)).id;
    checker2 = (await h.createUserWithAdminRoleIn('Proc Checker 2', h.companyAId)).id;
    const ds = await h.connections.getDataSource(h.companyAId);
    const role = (await ds.query(`SELECT id FROM roles WHERE key = 'admin'`))[0];
    for (const node of ['procurement.bank_account.edit', 'procurement.rfq_award']) {
      await ds.query(`INSERT INTO role_permissions ("roleId","nodeKey","access") VALUES ($1,$2,'editable') ON CONFLICT DO NOTHING`, [role.id, node]);
    }
    await seed(h.companyAId, 'A');
    await seed(h.companyBId, 'B');
  });

  afterAll(async () => {
    if (ambient?.isInitialized) await ambient.destroy();
    await h.teardown();
  });

  const mgr = async (id: string) => (await h.connections.getDataSource(id)).manager;
  let supA = '';
  let supB = '';
  let bankA = '';
  let rfqA = '';
  let quotationA = '';

  it('suppliers (and their contacts/addresses) live only in their own Company; a foreign supplier id is unknown', async () => {
    const mA = await mgr(h.companyAId);
    const mB = await mgr(h.companyBId);
    supA = (await suppliers.create({ code: 'SUP-X', legalName: 'Alpha Supplier' }, makerA, mA)).id;
    supB = (await suppliers.create({ code: 'SUP-X', legalName: 'Beta Supplier' }, makerA, mB)).id; // same code in another Company is legal
    expect((await suppliers.list(undefined, mA)).map((s) => s.legalName)).toEqual(['Alpha Supplier']);
    expect((await suppliers.listAllActive(mB)).map((s) => s.legalName)).toEqual(['Beta Supplier']);
    await expect(suppliers.getById(supA, mB)).rejects.toBeInstanceOf(NotFoundException);
    await expect(suppliers.addContact(supA, { name: 'Intruder' }, mB)).rejects.toBeInstanceOf(NotFoundException);
    await expect(suppliers.addAddress(supA, { addressLine: 'Nowhere' }, mB)).rejects.toBeInstanceOf(NotFoundException);
    await suppliers.addContact(supA, { name: 'Alice' }, mA);
    await suppliers.addAddress(supA, { addressLine: '1 Main St' }, mA);
    const detail = await suppliers.getById(supA, mA);
    expect(detail.contacts.map((c) => c.name)).toEqual(['Alice']);
    expect(detail.addresses.length).toBe(1);
    expect((await suppliers.getById(supB, mB)).contacts).toEqual([]);
  });

  it('a bank-account change needs two distinct checkers inside the Company; the other Company cannot decide it', async () => {
    const mA = await mgr(h.companyAId);
    const mB = await mgr(h.companyBId);
    await expect(suppliers.addBankAccount(supA, { bankName: 'Nile', accountNumber: '1' }, makerA, mB)).rejects.toBeInstanceOf(NotFoundException);
    const bank = await suppliers.addBankAccount(supA, { bankName: 'Nile', accountNumber: '12345' }, makerA, mA);
    bankA = bank.id;
    expect(bank.approvalStatus).toBe('pending');
    await expect(approvals.decide(bank.approvalRequestId!, checker1, 'approved', null, mB)).rejects.toBeInstanceOf(NotFoundException);
    await approvals.decide(bank.approvalRequestId!, checker1, 'approved', null, mA);
    expect((await suppliers.getById(supA, mA)).bankAccounts[0].approvalStatus).toBe('pending'); // one checker is not enough
    await approvals.decide(bank.approvalRequestId!, checker2, 'approved', null, mA);
    expect((await suppliers.getById(supA, mA)).bankAccounts[0].approvalStatus).toBe('approved');
    expect(await mB.getRepository(SupplierBankAccount).count()).toBe(0);
  });

  it('RFQ → send → quotation → award: the approved award creates the Purchase Order in the same Company only', async () => {
    const mA = await mgr(h.companyAId);
    const mB = await mgr(h.companyBId);
    const pr = await requests.create({ warehouseId: seeded.A.warehouseId, lines: [{ productId: seeded.A.productId, quantity: '5' }] }, makerA, mA);
    await requests.transition(pr.id, 'submit', makerA, mA);
    await requests.transition(pr.id, 'approve', checker1, mA);
    rfqA = (await requests.createRfqFromRequest(pr.id, [supA], null, makerA, mA)).id;

    expect((await rfqs.list(mA)).map((r) => r.id)).toEqual([rfqA]);
    expect(await rfqs.list(mB)).toEqual([]);
    await expect(rfqs.getById(rfqA, mB)).rejects.toBeInstanceOf(NotFoundException);
    await expect(rfqs.send(rfqA, makerA, mB)).rejects.toBeInstanceOf(Error); // unknown to B
    expect((await rfqs.send(rfqA, makerA, mA)).state).toBe('sent');

    const prLines = (await rfqs.getById(rfqA, mA)).purchaseRequestLines;
    const input = { rfqId: rfqA, supplierId: supA, lines: [{ purchaseRequestLineId: prLines[0].id, quantity: '5', unitCostBase: '9.50' }] };
    await expect(rfqs.recordQuotation(input, makerA, mB)).rejects.toBeInstanceOf(NotFoundException);
    const quotation = await rfqs.recordQuotation(input, makerA, mA);
    quotationA = quotation.id;
    expect(quotation.totalAmount).toBe('47.50');
    expect((await rfqs.getQuotationLines(quotationA, mA)).length).toBe(1);
    expect(await rfqs.getQuotationLines(quotationA, mB)).toEqual([]);

    await expect(rfqs.awardToSupplier(rfqA, quotationA, makerA, mB)).rejects.toBeInstanceOf(NotFoundException);
    const award = await rfqs.awardToSupplier(rfqA, quotationA, makerA, mA);
    await approvals.decide(award.approvalRequestId, checker1, 'approved', null, mA);

    expect((await rfqs.getById(rfqA, mA)).state).toBe('awarded');
    expect((await mA.query(`SELECT count(*)::int n FROM purchase_orders`))[0].n).toBe(1);
    expect((await mB.query(`SELECT count(*)::int n FROM purchase_orders`))[0].n).toBe(0);
  });

  it('Test F — nothing leaked into the other Company\'s supplier/RFQ tables', async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    expect((await dsB.query(`SELECT count(*)::int n FROM supplier_contacts`))[0].n).toBe(0);
    expect((await dsB.query(`SELECT count(*)::int n FROM supplier_quotations`))[0].n).toBe(0);
    expect((await dsB.query(`SELECT count(*)::int n FROM rfqs`))[0].n).toBe(0);
    expect(bankA).toBeTruthy();
  });
});
