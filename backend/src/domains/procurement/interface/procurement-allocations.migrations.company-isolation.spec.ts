import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { AddSupplierInvoiceApprovalAndPolicy1790020200000 } from '../../../database/migrations/procurement/1790020200000-AddSupplierInvoiceApprovalAndPolicy';
import { CreateSupplierInvoiceLineReceipts1790020000000 } from '../../../database/migrations/procurement/1790020000000-CreateSupplierInvoiceLineReceipts';
import { CreateSupplierPaymentAllocations1790020100000 } from '../../../database/migrations/procurement/1790020100000-CreateSupplierPaymentAllocations';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Procurement invoicing phases A/B (2026-10-20) - the two migrations on a real Company database, with LEGACY data written the way the old code wrote it (no allocation rows):
 * up -> down -> up, the FIFO backfill marked 'backfill_fifo', void invoices skipped, repeatable (second run inserts nothing), NO amount / journal / ledger / quantity / status touched,
 * the one-row-per-payment backfill, and the STOP case (invoiced beyond received) writes nothing.
 */
describe('Procurement allocations migrations - backfill of legacy data on a real Company database', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  const user = randomUUID();
  const sup = randomUUID();
  const wh = randomUUID();
  const prod = randomUUID();

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'proc_alloc_mig', extraCompanyTags: ['sales', 'inventory', 'finance', 'procurement', 'accounting'] });
    const ds = await h.connections.getDataSource(h.companyAId);
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,'Mig Operator','mig@test.local') ON CONFLICT DO NOTHING`, [user]);
    await ds.query(`INSERT INTO "warehouses" ("id","code","name","status") VALUES ($1,'WH-M','Main','active')`, [wh]);
    await ds.query(`INSERT INTO "products" ("id","sku","name","unitPrice","status") VALUES ($1,'SKU-M','M','10.00','active')`, [prod]);
    await ds.query(`INSERT INTO "suppliers" ("id","code","legalName") VALUES ($1,'SUP-M','Mig Supplier')`, [sup]);
  });
  afterAll(async () => {
    await h.teardown().catch(() => undefined);
  });

  it('backfills FIFO (marked backfill_fifo), skips void invoices, touches nothing else, is repeatable, and stops on inconsistent data', async () => {
    const ds = await h.connections.getDataSource(h.companyAId);
    const qr = ds.createQueryRunner();
    try {
      const m1 = new CreateSupplierInvoiceLineReceipts1790020000000();
      const m2 = new CreateSupplierPaymentAllocations1790020100000();
      // pre-migration state: the new tables do not exist
      await m2.down(qr);
      await m1.down(qr);

      // ---- legacy data: PO of 10, receipts 6 then 4, invoices: 7 (posted), 2 (void), 3 (draft); plus a payment of 70 on the first
      const po = randomUUID();
      const poLine = randomUUID();
      await ds.query(`INSERT INTO "purchase_orders" ("id","poNumber","supplierId","warehouseId") VALUES ($1,'PO-M1',$2,$3)`, [po, sup, wh]);
      await ds.query(
        `INSERT INTO "purchase_order_lines" ("id","purchaseOrderId","productId","quantity","unitCostBase","lineTotalBase","quantityReceived","quantityInvoiced") VALUES ($1,$2,$3,10,'10.00','100.00',10,10)`,
        [poLine, po, prod],
      );
      const grLines: string[] = [];
      for (const [n, qty] of [['GR-M1', 6], ['GR-M2', 4]] as Array<[string, number]>) {
        const gr = randomUUID();
        const grl = randomUUID();
        await ds.query(`INSERT INTO "goods_receipts" ("id","grNumber","purchaseOrderId","supplierId","warehouseId") VALUES ($1,$2,$3,$4,$5)`, [gr, n, po, sup, wh]);
        await ds.query(`INSERT INTO "goods_receipt_lines" ("id","goodsReceiptId","purchaseOrderLineId","productId","quantityReceived","unitCostBase") VALUES ($1,$2,$3,$4,$5,'10.00')`, [grl, gr, poLine, prod, qty]);
        grLines.push(grl);
        await new Promise((r) => setTimeout(r, 15)); // distinct createdAt ordering
      }
      const mkInvoice = async (num: string, qty: number, state: string | null) => {
        const inv = randomUUID();
        const line = randomUUID();
        await ds.query(`INSERT INTO "supplier_invoices" ("id","invoiceNumber","supplierId","purchaseOrderId","totalAmount","createdByUserId") VALUES ($1,$2,$3,$4,$5,$6)`, [inv, num, sup, po, (qty * 10).toFixed(2), user]);
        await ds.query(`INSERT INTO "supplier_invoice_lines" ("id","supplierInvoiceId","purchaseOrderLineId","productId","quantity","unitCostBase","lineTotalBase","unitCostVariance") VALUES ($1,$2,$3,$4,$5,'10.00',$6,'0.0000')`, [line, inv, poLine, prod, qty, (qty * 10).toFixed(2)]);
        if (state) await ds.query(`INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'supplier_invoice_lifecycle','supplier_invoice',$2,$3)`, [randomUUID(), inv, state]);
        await new Promise((r) => setTimeout(r, 15));
        return { inv, line };
      };
      const posted = await mkInvoice('SINV-M1', 7, 'partially_paid');
      const voided = await mkInvoice('SINV-M2', 2, 'void');
      const drafted = await mkInvoice('SINV-M3', 3, null); // no lifecycle row yet = draft = live
      const cash: Array<{ id: string }> = await ds.query(`SELECT id FROM "treasury_accounts" WHERE "code" = 'MAIN-CASH'`);
      const payment = randomUUID();
      await ds.query(`INSERT INTO "supplier_payments" ("id","paymentNumber","supplierId","supplierInvoiceId","amount","method","treasuryAccountId","recordedByUserId") VALUES ($1,'SPAY-M1',$2,$3,'70.00','cash',$4,$5)`, [payment, sup, posted.inv, cash[0].id, user]);

      const fingerprint = async () =>
        JSON.stringify([
          await ds.query(`SELECT * FROM supplier_invoices ORDER BY id`),
          await ds.query(`SELECT * FROM supplier_invoice_lines ORDER BY id`),
          await ds.query(`SELECT * FROM purchase_order_lines ORDER BY id`),
          await ds.query(`SELECT * FROM supplier_payments ORDER BY id`),
          await ds.query(`SELECT * FROM process_instances ORDER BY id`),
          await ds.query(`SELECT count(*) FROM supplier_ledger_entries`),
          await ds.query(`SELECT count(*) FROM accounting_journal_entries`),
          await ds.query(`SELECT count(*) FROM stock_movements`),
        ]);
      const before = await fingerprint();

      await m1.up(qr);
      await m2.up(qr);
      expect(await fingerprint()).toEqual(before); // nothing historical changed

      const rows = async () =>
        (await ds.query(
          `SELECT r."supplierInvoiceLineId" AS line, r."goodsReceiptLineId" AS grl, r."quantity"::text AS q, r."allocationBasis" AS basis FROM supplier_invoice_line_receipts r ORDER BY r."supplierInvoiceLineId", r."quantity" DESC`,
        )) as Array<{ line: string; grl: string; q: string; basis: string }>;
      const first = await rows();
      expect(first.every((r) => r.basis === 'backfill_fifo')).toBe(true);
      expect(first.filter((r) => r.line === voided.line)).toHaveLength(0); // void: no allocation
      // FIFO in invoice creation order: posted 7 -> 6 + 1, draft 3 -> 3 (from the second receipt)
      expect(first.filter((r) => r.line === posted.line).map((r) => [r.grl, Number(r.q)]).sort()).toEqual([[grLines[0], 6], [grLines[1], 1]].sort());
      expect(first.filter((r) => r.line === drafted.line).map((r) => [r.grl, Number(r.q)])).toEqual([[grLines[1], 3]]);
      // allocations per live invoice line equal the line quantity; per PO line equal quantityInvoiced - void (10 - 2 = 8 live ... 7 + 3 = 10 recorded on the line aggregate)
      const totals = (await ds.query(`SELECT sum(quantity)::text AS s FROM supplier_invoice_line_receipts`))[0].s;
      expect(Number(totals)).toBe(10);
      const pay = await ds.query(`SELECT "supplierPaymentId" AS p, "supplierInvoiceId" AS i, amount::text AS a FROM supplier_payment_allocations`);
      expect(pay).toEqual([{ p: payment, i: posted.inv, a: '70.00' }]);

      // repeatable: running both again inserts nothing
      await m1.up(qr);
      await m2.up(qr);
      expect(await rows()).toEqual(first);
      expect(await fingerprint()).toEqual(before);

      // up -> down -> up gives the same allocations
      await m2.down(qr);
      await m1.down(qr);
      await m1.up(qr);
      await m2.up(qr);
      expect((await rows()).map((r) => [r.line, Number(r.q), r.basis]).sort()).toEqual(first.map((r) => [r.line, Number(r.q), r.basis]).sort());

      // ---- STOP case: a live invoice line beyond what was received -> the migration throws and writes nothing
      await m1.down(qr);
      await mkInvoice('SINV-M4', 5, 'posted'); // 7 + 3 + 5 = 15 > 10 received
      // the read-only preflight predicts exactly this finding (check 1) and changes nothing
      const preflight = fs.readFileSync(path.resolve(__dirname, '../../../../tools/preflight/procurement-allocations-preflight.sql'), 'utf8');
      const sqlOnly = preflight.split(String.fromCharCode(10)).filter((l) => !l.trim().startsWith('--')).join(String.fromCharCode(10));
      expect(sqlOnly).not.toMatch(/(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE)/i);
      const statements = sqlOnly.split(';').map((x) => x.trim()).filter(Boolean);
      const findings: string[] = [];
      for (const st of statements) for (const row of await ds.query(st)) findings.push(row.check);
      expect(findings).toContain('1_invoiced_beyond_received');
      expect(findings).toContain('3_aggregate_vs_live_lines'); // the aggregate (10) no longer equals the live lines (15) once the extra invoice exists
      const beforeStop = await fingerprint();
      await expect(m1.up(qr)).rejects.toThrow(/STOPPED.*inconsistent/is);
      const leftover = await ds.query(`SELECT count(*) AS n FROM supplier_invoice_line_receipts`);
      expect(Number(leftover[0].n)).toBe(0);
      expect(await fingerprint()).toEqual(beforeStop);
    } finally {
      await qr.release();
    }
  });

  it('C-1 migration: up -> down -> up is idempotent, adds only nullable columns and the singleton policy table, and down removes exactly those', async () => {
    const ds = await h.connections.getDataSource(h.companyBId);
    const qr = ds.createQueryRunner();
    try {
      const mig = new AddSupplierInvoiceApprovalAndPolicy1790020200000();
      const cols = async () => (await ds.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'supplier_invoices' AND column_name IN ('submittedByUserId','submittedAt','approvedByUserId','approvedAt','matchStatus','matchDetail','holdReason','exceptionReason','rejectedReason') ORDER BY 1`)).length;
      const table = async () => (await ds.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'procurement_invoice_policies'`)).length;
      expect([await cols(), await table()]).toEqual([9, 1]);
      await mig.down(qr);
      expect([await cols(), await table()]).toEqual([0, 0]);
      await mig.down(qr); // idempotent down
      await mig.up(qr);
      await mig.up(qr); // idempotent up
      expect([await cols(), await table()]).toEqual([9, 1]);
      await ds.query(`INSERT INTO procurement_invoice_policies ("approvalRequired") VALUES (true)`);
      await expect(ds.query(`INSERT INTO procurement_invoice_policies ("approvalRequired") VALUES (false)`)).rejects.toThrow(/duplicate key|UQ_procurement_invoice_policies_singleton/);
      await expect(ds.query(`UPDATE procurement_invoice_policies SET "priceTolerancePct" = -1`)).rejects.toThrow();
      await ds.query(`DELETE FROM procurement_invoice_policies`);
    } finally {
      await qr.release();
    }
  });
});
