import { randomUUID } from 'crypto';
import { SupplierInvoiceService } from '../application/supplier-invoice.service';
import { SupplierLedgerService } from '../application/supplier-ledger.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import {
  setUpTwoCompanyHarness,
  TwoCompanyHarness,
  assertDataSourceNeverRequestedFor,
} from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Area 21 Operational Company Scoping Retrofit (2026-09-27, CTO-authorized).
 * Real-Postgres proof that `supplier-invoice.controller.ts`'s reads are
 * genuinely Company-scoped after this retrofit — two real, separately
 * provisioned Company databases, each with its own distinct supplier and
 * invoice, never mocked. `SupplierInvoiceService` genuinely calls
 * `ProcessEngineService.getState` (`getStatus`) for every invoice read, so
 * a real process instance is seeded per invoice and `ProcessEngineService`
 * is constructed for real (it has zero cross-domain dependencies of its
 * own). `SupplierLedgerService`/`NumberingService`/`AuditService`/
 * `EventBusService` are never invoked by the read-only methods this test
 * exercises and are inert.
 */
describe('SupplierInvoiceController Area 21 retrofit — real-Postgres Company isolation (2026-09-27)', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let service: SupplierInvoiceService;

  const seeded: Record<'A' | 'B', { invoiceId: string; supplierId: string; totalAmount: string }> = {
    A: { invoiceId: '', supplierId: '', totalAmount: '1500.00' },
    B: { invoiceId: '', supplierId: '', totalAmount: '4200.00' },
  };

  async function seedCompanyData(companyId: string, key: 'A' | 'B', invoiceNumber: string) {
    const ds = await h.connections.getDataSource(companyId);
    const supplierId = randomUUID();
    const purchaseOrderId = randomUUID();
    const invoiceId = randomUUID();
    const actorUserId = randomUUID();

    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [
      actorUserId,
      'Isolation Test Admin',
      `iso-admin-${companyId}@test.local`,
    ]);
    const warehouseId = randomUUID();
    await ds.query(`INSERT INTO "warehouses" ("id","code","name","status") VALUES ($1,$2,$3,'active')`, [
      warehouseId,
      `WH-${invoiceNumber}`,
      `${invoiceNumber} Warehouse`,
    ]);
    await ds.query(`INSERT INTO "suppliers" ("id","code","legalName") VALUES ($1,$2,$3)`, [
      supplierId,
      `SUP-${invoiceNumber}`,
      `${invoiceNumber} Supplier`,
    ]);
    await ds.query(`INSERT INTO "purchase_orders" ("id","poNumber","supplierId","warehouseId") VALUES ($1,$2,$3,$4)`, [
      purchaseOrderId,
      `PO-${invoiceNumber}`,
      supplierId,
      warehouseId,
    ]);
    await ds.query(
      `INSERT INTO "supplier_invoices" ("id","invoiceNumber","supplierId","purchaseOrderId","totalAmount","createdByUserId")
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [invoiceId, invoiceNumber, supplierId, purchaseOrderId, seeded[key].totalAmount, actorUserId],
    );
    // `getStatus`/`getInvoiceRemaining` require a real process instance — seed one directly at 'draft',
    // the process the entity is created in, matching `createDraftInvoice`'s own real effect.
    await ds.query(
      `INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'supplier_invoice_lifecycle','supplier_invoice',$2,'draft')`,
      [randomUUID(), invoiceId],
    );

    seeded[key].invoiceId = invoiceId;
    seeded[key].supplierId = supplierId;
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'supplier_invoice_isolation', extraCompanyTags: ['sales', 'inventory', 'procurement'] });
    await seedCompanyData(h.companyAId, 'A', 'SINV-A-001');
    await seedCompanyData(h.companyBId, 'B', 'SINV-B-001');

    const inert = {} as never;
    const processEngine = new ProcessEngineService(h.controlPlane);
    const ledger = new SupplierLedgerService(h.controlPlane, inert, inert);
    service = new SupplierInvoiceService(h.controlPlane, inert, processEngine, inert, ledger, inert);
  });

  afterAll(async () => {
    await h.teardown();
  });

  it("getInvoice for Company A's own invoice resolves Company A's own amount and 'draft' state", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const invoice = await service.getInvoice(seeded.A.invoiceId, dsA.manager);
    expect(invoice.totalAmount).toBe(seeded.A.totalAmount);
    expect(invoice.state).toBe('draft');
    expect(invoice.remaining).toBe(seeded.A.totalAmount);
  });

  it("getInvoice for Company A's invoice id via Company B's manager 404s — the row genuinely does not exist in Company B's own database", async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    await expect(service.getInvoice(seeded.A.invoiceId, dsB.manager)).rejects.toThrow();
  });

  it("listAll via Company A resolves only Company A's real invoice", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const invoices = await service.listAll(dsA.manager);
    expect(invoices.map((i) => i.invoiceNumber)).toEqual(['SINV-A-001']);
  });

  it("listAll via Company B resolves only Company B's real invoice — no leakage of Company A's data", async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    const invoices = await service.listAll(dsB.manager);
    expect(invoices.map((i) => i.invoiceNumber)).toEqual(['SINV-B-001']);
  });

  it("listForSupplier for Company A's own supplier resolves only Company A's own invoice", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const invoices = await service.listForSupplier(seeded.A.supplierId, dsA.manager);
    expect(invoices.map((i) => i.invoiceNumber)).toEqual(['SINV-A-001']);
  });

  it("Test F — resolving Company A's invoices never even requests Company B's DataSource", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      await service.getInvoice(seeded.A.invoiceId, dsA.manager);
      await service.listAll(dsA.manager);
      await service.listForSupplier(seeded.A.supplierId, dsA.manager);
    });
  });

  // ---- T0-F1 (2026-10-04): the WRITE path. The read/list tests above never exercised createDraftInvoice, whose
  // registerDocumentType call used to be un-threaded (ambient/Platform connection). The control-plane connection
  // here has no NumberingSequence entity metadata, so ANY ambient fallback throws; the numbering and audit
  // services are REAL. ----
  describe('createDraftInvoice write path (T0-F1)', () => {
    let writer: SupplierInvoiceService;
    const actor = randomUUID();
    const fixture: Record<'A' | 'B', { supplierId: string; purchaseOrderId: string; poLineId: string }> = {
      A: { supplierId: '', purchaseOrderId: '', poLineId: '' },
      B: { supplierId: '', purchaseOrderId: '', poLineId: '' },
    };

    async function seedReceivedPo(companyId: string, key: 'A' | 'B') {
      const ds = await h.connections.getDataSource(companyId);
      const warehouseId = randomUUID();
      const productId = randomUUID();
      const supplierId = randomUUID();
      const purchaseOrderId = randomUUID();
      const poLineId = randomUUID();
      await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,'Write Path Clerk',$2) ON CONFLICT DO NOTHING`, [actor, `wp-${companyId}@test.local`]);
      await ds.query(`INSERT INTO "warehouses" ("id","code","name","status") VALUES ($1,$2,'WP Warehouse','active')`, [warehouseId, `WP-${key}`]);
      await ds.query(`INSERT INTO "products" ("id","sku","name","unitPrice","status") VALUES ($1,$2,'WP Product','10.00','active')`, [productId, `WP-SKU-${key}`]);
      await ds.query(`INSERT INTO "suppliers" ("id","code","legalName") VALUES ($1,$2,'WP Supplier')`, [supplierId, `WP-SUP-${key}`]);
      await ds.query(`INSERT INTO "purchase_orders" ("id","poNumber","supplierId","warehouseId") VALUES ($1,$2,$3,$4)`, [purchaseOrderId, `WP-PO-${key}`, supplierId, warehouseId]);
      await ds.query(
        `INSERT INTO "purchase_order_lines" ("id","purchaseOrderId","productId","quantity","quantityReceived","unitCostBase","lineTotalBase") VALUES ($1,$2,$3,10,10,'5.00','50.00')`,
        [poLineId, purchaseOrderId, productId],
      );
      // phase A: the 10 received units now live on a real goods-receipt line (invoice lines are allocated to receipt lines)
      const grId = randomUUID();
      await ds.query(`INSERT INTO "goods_receipts" ("id","grNumber","purchaseOrderId","supplierId","warehouseId") VALUES ($1,$2,$3,$4,$5)`, [grId, `WP-GR-${key}`, purchaseOrderId, supplierId, warehouseId]);
      await ds.query(
        `INSERT INTO "goods_receipt_lines" ("id","goodsReceiptId","purchaseOrderLineId","productId","quantityReceived","unitCostBase") VALUES ($1,$2,$3,$4,10,'5.00')`,
        [randomUUID(), grId, poLineId, productId],
      );
      await ds.query(
        `INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'purchase_order_lifecycle','purchase_order',$2,'received')`,
        [randomUUID(), purchaseOrderId],
      );
      fixture[key] = { supplierId, purchaseOrderId, poLineId };
    }

    const invoiceCount = async (companyId: string) =>
      Number((await (await h.connections.getDataSource(companyId)).query('SELECT count(*) AS n FROM "supplier_invoices"'))[0].n);
    const sequenceRows = async (companyId: string) =>
      (await h.connections.getDataSource(companyId)).query(`SELECT "prefix", "lastNumber" FROM "numbering_sequences" WHERE "documentType" = 'supplier_invoice'`);

    beforeAll(async () => {
      await seedReceivedPo(h.companyAId, 'A');
      await seedReceivedPo(h.companyBId, 'B');
      const inert = {} as never;
      const processEngine = new ProcessEngineService(h.controlPlane);
      const ledger = new SupplierLedgerService(h.controlPlane, inert, inert);
      writer = new SupplierInvoiceService(h.controlPlane, new NumberingService(h.controlPlane), processEngine, new AuditService(h.controlPlane), ledger, inert);
    });

    const draftInput = (key: 'A' | 'B') => ({
      purchaseOrderId: fixture[key].purchaseOrderId,
      supplierReference: `WP-REF-${key}`,
      lines: [{ purchaseOrderLineId: fixture[key].poLineId, quantity: '10', unitCostBase: '5.00' }],
    });

    it("A write lands ONLY in Company A (invoice + its own SINV sequence), Company B is untouched, the Platform DB is never used, and B's DataSource is never requested", async () => {
      const dsA = await h.connections.getDataSource(h.companyAId);
      const aBefore = await invoiceCount(h.companyAId);
      const bBefore = await invoiceCount(h.companyBId);
      expect(await sequenceRows(h.companyBId)).toEqual([]);

      let created: { invoiceNumber: string; supplierId: string } | undefined;
      await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
        created = await writer.createDraftInvoice(draftInput('A'), actor, dsA.manager);
      });

      expect(created!.invoiceNumber).toMatch(/^SINV-/);
      expect(created!.supplierId).toBe(fixture.A.supplierId);
      expect(await invoiceCount(h.companyAId)).toBe(aBefore + 1);
      expect(await invoiceCount(h.companyBId)).toBe(bBefore); // B untouched
      expect(await sequenceRows(h.companyAId)).toEqual([{ prefix: 'SINV', lastNumber: 1 }]);
      expect(await sequenceRows(h.companyBId)).toEqual([]); // B's sequence not even registered
      // no ambient fallback: nothing was registered in the control-plane/Platform database
      const platformSeq = await h.controlPlane.query(`SELECT count(*) AS n FROM "numbering_sequences" WHERE "documentType" = 'supplier_invoice'`);
      expect(Number(platformSeq[0].n)).toBe(0);
    });

    it("B writes independently with its OWN sequence (also number 1) — A's invoice count and sequence are unaffected", async () => {
      const dsB = await h.connections.getDataSource(h.companyBId);
      const aBefore = await invoiceCount(h.companyAId);
      const seqABefore = await sequenceRows(h.companyAId);

      const created = await writer.createDraftInvoice(draftInput('B'), actor, dsB.manager);

      expect(created.supplierId).toBe(fixture.B.supplierId);
      expect(await sequenceRows(h.companyBId)).toEqual([{ prefix: 'SINV', lastNumber: 1 }]);
      expect(await invoiceCount(h.companyAId)).toBe(aBefore);
      expect(await sequenceRows(h.companyAId)).toEqual(seqABefore);
    });

    it("A→B DENY: Company A's PO through Company B's manager is rejected and writes nothing", async () => {
      const dsB = await h.connections.getDataSource(h.companyBId);
      const bBefore = await invoiceCount(h.companyBId);
      await expect(writer.createDraftInvoice(draftInput('A'), actor, dsB.manager)).rejects.toThrow(/not found/i);
      expect(await invoiceCount(h.companyBId)).toBe(bBefore);
    });
  });
});
