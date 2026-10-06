import { randomUUID } from 'crypto';
import { SupplierPaymentService } from '../application/supplier-payment.service';
import { SupplierLedgerService } from '../application/supplier-ledger.service';
import { SupplierInvoiceService } from '../application/supplier-invoice.service';
import { TreasuryService } from '../../treasury/application/treasury.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import {
  setUpTwoCompanyHarness,
  TwoCompanyHarness,
  assertDataSourceNeverRequestedFor,
} from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Area 21 Operational Company Scoping Retrofit (2026-09-28, CTO-authorized).
 * Real-Postgres proof that `supplier-payment.controller.ts`'s reads/writes
 * are genuinely Company-scoped — two real, separately provisioned Company
 * databases, each with its own supplier, posted supplier invoice and
 * funded treasury account, never mocked. `recordPayment` is the
 * deep-chain proof: Treasury `cash_out` leg + `SupplierPayment` row +
 * Supplier Ledger debit + outbox publish + invoice status recompute, in
 * one transaction on the Company's own database.
 */
describe('SupplierPaymentController Area 21 retrofit — real-Postgres Company isolation (2026-09-28)', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let service: SupplierPaymentService;
  let treasury: TreasuryService;
  const actorUserId = randomUUID();

  const seeded: Record<'A' | 'B', { supplierId: string; invoiceId: string; treasuryAccountId: string }> = {
    A: { supplierId: '', invoiceId: '', treasuryAccountId: '' },
    B: { supplierId: '', invoiceId: '', treasuryAccountId: '' },
  };

  async function seedCompanyData(companyId: string, key: 'A' | 'B', code: string) {
    const ds = await h.connections.getDataSource(companyId);
    const supplierId = randomUUID();
    const purchaseOrderId = randomUUID();
    const invoiceId = randomUUID();
    const warehouseId = randomUUID();
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [
      actorUserId,
      'Isolation Test AP Clerk',
      `iso-ap-${companyId}@test.local`,
    ]);
    await ds.query(`INSERT INTO "warehouses" ("id","code","name","status") VALUES ($1,$2,$3,'active')`, [warehouseId, `WH-${code}`, `${code} Warehouse`]);
    await ds.query(`INSERT INTO "suppliers" ("id","code","legalName") VALUES ($1,$2,$3)`, [supplierId, `SUP-${code}`, `${code} Supplier`]);
    await ds.query(`INSERT INTO "purchase_orders" ("id","poNumber","supplierId","warehouseId") VALUES ($1,$2,$3,$4)`, [
      purchaseOrderId,
      `PO-${code}`,
      supplierId,
      warehouseId,
    ]);
    await ds.query(
      `INSERT INTO "supplier_invoices" ("id","invoiceNumber","supplierId","purchaseOrderId","totalAmount","createdByUserId") VALUES ($1,$2,$3,$4,'1500.00',$5)`,
      [invoiceId, `SINV-${code}`, supplierId, purchaseOrderId, actorUserId],
    );
    await ds.query(
      `INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'supplier_invoice_lifecycle','supplier_invoice',$2,'posted')`,
      [randomUUID(), invoiceId],
    );
    const mainCash: Array<{ id: string }> = await ds.query(`SELECT id FROM "treasury_accounts" WHERE "code" = 'MAIN-CASH'`);
    // D2 (2026-10-04): a payment now requires the paying Treasury account to be GL-mapped (rejected before any mutation otherwise).
    await ds.query(`UPDATE "treasury_accounts" SET "glAccountCode" = '1102' WHERE id = $1`, [mainCash[0].id]);
    seeded[key] = { supplierId, invoiceId, treasuryAccountId: mainCash[0].id };
    // Fund the account through the real, manager-threaded Treasury path so the cash_out has a balance.
    await treasury.cashIn(mainCash[0].id, '5000.00', null, null, null, 'isolation test funding', actorUserId, ds.manager);
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'sp_isolation', extraCompanyTags: ['sales', 'inventory', 'finance', 'procurement'] });

    const inert = {} as never;
    const audit = new AuditService(h.controlPlane);
    const numbering = new NumberingService(h.controlPlane);
    const events = new EventBusService(inert);
    const processEngine = new ProcessEngineService(h.controlPlane);
    treasury = new TreasuryService(h.controlPlane, numbering, audit, inert, events);
    const ledger = new SupplierLedgerService(h.controlPlane, numbering, audit);
    const invoices = new SupplierInvoiceService(h.controlPlane, numbering, processEngine, audit, ledger, events);
    service = new SupplierPaymentService(h.controlPlane, numbering, audit, treasury, ledger, invoices, events);

    await seedCompanyData(h.companyAId, 'A', 'A');
    await seedCompanyData(h.companyBId, 'B', 'B');
  });

  afterAll(async () => {
    await h.teardown();
  });

  it("recordPayment for Company A pays Company A's own invoice: Treasury leg, payment row and ledger debit land in Company A's database, invoice -> partially_paid", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const payment = await service.recordPayment(seeded.A.supplierId, seeded.A.invoiceId, '500.00', 'bank_transfer', seeded.A.treasuryAccountId, null, actorUserId, dsA.manager);
    expect(payment.supplierInvoiceId).toBe(seeded.A.invoiceId);

    const ledger: Array<{ amount: string }> = await dsA.query(`SELECT "amount" FROM "supplier_ledger_entries" WHERE "supplierPaymentId" = $1`, [payment.id]);
    expect(ledger).toHaveLength(1);
    const state: Array<{ currentState: string }> = await dsA.query(
      `SELECT "currentState" FROM "process_instances" WHERE "entityId" = $1 AND "entityType" = 'supplier_invoice'`,
      [seeded.A.invoiceId],
    );
    expect(state[0].currentState).toBe('partially_paid');
  });

  it("recordPayment for Company B pays independently in Company B's own database — Company B's invoice state unaffected by A's payment", async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    const stateBefore: Array<{ currentState: string }> = await dsB.query(
      `SELECT "currentState" FROM "process_instances" WHERE "entityId" = $1 AND "entityType" = 'supplier_invoice'`,
      [seeded.B.invoiceId],
    );
    expect(stateBefore[0].currentState).toBe('posted');

    const payment = await service.recordPayment(seeded.B.supplierId, seeded.B.invoiceId, '1500.00', 'cash', seeded.B.treasuryAccountId, null, actorUserId, dsB.manager);
    expect(payment.supplierId).toBe(seeded.B.supplierId);
    const stateAfter: Array<{ currentState: string }> = await dsB.query(
      `SELECT "currentState" FROM "process_instances" WHERE "entityId" = $1 AND "entityType" = 'supplier_invoice'`,
      [seeded.B.invoiceId],
    );
    expect(stateAfter[0].currentState).toBe('paid');
  });

  it("recordPayment against Company A's invoice through Company B's manager is rejected (A→B DENY)", async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    await expect(
      service.recordPayment(seeded.A.supplierId, seeded.A.invoiceId, '10.00', 'cash', seeded.B.treasuryAccountId, null, actorUserId, dsB.manager),
    ).rejects.toThrow(/not found/i);
  });

  it('listAll via Company A resolves only Company A\'s payment (with its own supplier/invoice labels); via Company B only Company B\'s', async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const dsB = await h.connections.getDataSource(h.companyBId);
    const a = await service.listAll(dsA.manager);
    const b = await service.listAll(dsB.manager);
    expect(a.map((p) => [p.supplierCode, p.invoiceNumber])).toEqual([['SUP-A', 'SINV-A']]);
    expect(b.map((p) => [p.supplierCode, p.invoiceNumber])).toEqual([['SUP-B', 'SINV-B']]);
  });

  it("listForSupplier of Company A's supplier id is empty from Company B's manager", async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    expect(await service.listForSupplier(seeded.A.supplierId, dsB.manager)).toHaveLength(0);
  });

  it("Test F — resolving Company A's supplier payments never even requests Company B's DataSource", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      await service.listAll(dsA.manager);
      await service.listForSupplier(seeded.A.supplierId, dsA.manager);
    });
  });
});
