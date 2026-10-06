/**
 * Browser-verification master data for the isolated Company DB `bv_co` (see bv-bootstrap.ts). Raw, idempotent-by-fresh-DB inserts: a small
 * chart, an open fiscal period, two warehouses, products, a customer with an order + posted invoices + a shipment, mapped treasury accounts.
 * Everything else (suppliers, item requests, PR/RFQ/PO, payments, edits) is created through the real UI/API during the verification itself.
 */
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';

const cfg = { type: 'postgres' as const, host: process.env.DB_HOST ?? '127.0.0.1', port: Number(process.env.DB_PORT ?? 5656), username: process.env.DB_USER ?? 'd3verify', password: process.env.DB_PASSWORD ?? 'x', database: process.env.BV_CO_DB ?? 'bv_co' };
const today = new Date().toISOString().slice(0, 10);
const year = today.slice(0, 4);

async function main() {
  const ds = new DataSource(cfg);
  await ds.initialize();
  const q = (sql: string, p: unknown[] = []) => ds.query(sql, p);
  const adminUser = (await q(`SELECT id FROM users LIMIT 1`))[0].id as string;

  // chart
  const accounts: Array<[string, string, string, string, string | null]> = [
    ['1101', 'Cash on Hand', 'asset', 'debit', 'bank'],
    ['1102', 'Bank', 'asset', 'debit', 'bank'],
    ['1110', 'Accounts Receivable', 'asset', 'debit', 'ar'],
    ['1120', 'Inventory', 'asset', 'debit', 'inventory'],
    ['1140', 'Input VAT', 'asset', 'debit', 'tax_receivable'],
    ['1210', 'Equipment', 'asset', 'debit', null],
    ['1219', 'Accumulated Depreciation', 'asset', 'credit', null],
    ['2101', 'Accounts Payable', 'liability', 'credit', 'ap'],
    ['2900', 'Acquisition Offset', 'liability', 'credit', null],
    ['4900', 'Gain on Disposal of Fixed Assets', 'revenue', 'credit', null],
    ['5800', 'Depreciation Expense', 'expense', 'debit', null],
    ['5900', 'Loss on Disposal of Fixed Assets', 'expense', 'debit', null],
  ];
  for (const [code, name, type, normal, fn] of accounts) {
    await q(
      `INSERT INTO "accounting_gl_accounts" ("id","code","name","accountType","normalBalance","isPostable","allowManualJournal","isActive","isContra","controlFunction") VALUES ($1,$2,$3,$4,$5,true,$6,true,false,$7)`,
      [randomUUID(), code, name, type, normal, fn === null, fn],
    );
  }
  const fy = randomUUID();
  const fp = randomUUID();
  await q(`INSERT INTO "accounting_fiscal_years" ("id","code","startDate","endDate") VALUES ($1,'FY',$2,$3)`, [fy, `${year}-01-01`, `${year}-12-31`]);
  await q(`INSERT INTO "accounting_fiscal_periods" ("id","fiscalYearId","code","startDate","endDate") VALUES ($1,$2,'P',$3,$4)`, [fp, fy, `${year}-01-01`, `${year}-12-31`]);
  await q(`INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'accounting_fiscal_year','FiscalYear',$2,'active'), ($3,'accounting_fiscal_period','FiscalPeriod',$4,'open')`, [randomUUID(), fy, randomUUID(), fp]);

  // warehouses + products + stock
  const wh1 = randomUUID();
  const wh2 = randomUUID();
  await q(`INSERT INTO "warehouses" ("id","code","name","status") VALUES ($1,'WH-MAIN','Main Warehouse','active'), ($2,'WH-SEC','Secondary Warehouse','active')`, [wh1, wh2]);
  const products: Array<[string, string, string]> = [[randomUUID(), 'SKU-BV-1', 'BV Widget'], [randomUUID(), 'SKU-BV-2', 'BV Gadget'], [randomUUID(), 'SKU-BV-3', 'BV Gizmo']];
  for (const [id, sku, name] of products) await q(`INSERT INTO "products" ("id","sku","name","unitPrice","status") VALUES ($1,$2,$3,'25.00','active')`, [id, sku, name]);
  await q(`INSERT INTO "stock_movements" ("id","warehouseId","productId","quantity","movementType") VALUES ($1,$2,$3,40,'receipt'), ($4,$2,$5,15,'receipt')`, [randomUUID(), wh1, products[0][0], randomUUID(), products[1][0]]);

  // treasury: two mapped accounts
  const types = await q(`SELECT id FROM treasury_account_types LIMIT 1`);
  const t1 = randomUUID();
  await q(`INSERT INTO "treasury_accounts" ("id","code","name","accountTypeId","glAccountCode") VALUES ($1,'BV-BANK','BV Bank Account',$2,'1102')`, [t1, types[0].id]);

  // customer + order + posted invoices + shipment
  const customerId = randomUUID();
  const soId = randomUUID();
  await q(`INSERT INTO "customers" ("id","code","name","creditLimit") VALUES ($1,'CUST-BV','BV Customer Co','100000.00')`, [customerId]);
  await q(`INSERT INTO "sales_orders" ("id","orderNumber","customerId","salesRepUserId","totalAmount") VALUES ($1,'SO-BV-1',$2,$3,'900.00')`, [soId, customerId, adminUser]);
  const invoices: string[] = [];
  for (const [num, total] of [['INV-BV-1', '900.00'], ['INV-BV-2', '1200.00']]) {
    const id = randomUUID();
    invoices.push(id);
    await q(`INSERT INTO "sales_invoices" ("id","invoiceNumber","customerId","salesOrderId","subtotal","totalAmount","createdByUserId") VALUES ($1,$2,$3,$4,$5,$5,$6)`, [id, num, customerId, soId, total, adminUser]);
    await q(`INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'sales_invoice_lifecycle','sales_invoice',$2,'posted')`, [randomUUID(), id]);
  }
  const shipmentId = randomUUID();
  await q(`INSERT INTO "shipments" ("id","fulfillmentOrderId","waybillNumber","salesOrderId") VALUES ($1,'FO-BV-1','WB-BV-1',$2)`, [shipmentId, soId]);
  console.log(JSON.stringify({ wh1, wh2, products: products.map((p) => p[0]), t1, customerId, soId, invoices, shipmentId }));
  await ds.destroy();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
