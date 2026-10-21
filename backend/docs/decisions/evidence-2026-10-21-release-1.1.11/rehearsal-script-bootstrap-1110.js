'use strict';
/**
 * Rehearsal bootstrap (2026-10-21): builds an isolated v1.1.10-SCHEMA platform DB + one Company DB using the INSTALLED v1.1.10 tree's own dist
 * (its migration runner, its services) - the same classes bv-bootstrap uses, but never the v1.1.11 source. Names must be daii_test_biz_tNN_* on 5546.
 * env: DB_HOST DB_PORT DB_USER DB_PASSWORD, RH_MAIN, RH_CO, RH_APP (installed tree root), DATABASE_CREDENTIAL_ENCRYPTION_KEY
 */
const path = require('path');
const APP = process.env.RH_APP;
const nm = (p) => require(path.join(APP, 'node_modules', p));
const R = (p) => require(path.join(APP, 'dist', p));
const { DataSource } = nm('typeorm');
const bcrypt = nm('bcrypt');
const { randomUUID } = require('crypto');

const HOST = process.env.DB_HOST, PORT = Number(process.env.DB_PORT), USERNAME = process.env.DB_USER, PASSWORD = process.env.DB_PASSWORD;
const MAIN = process.env.RH_MAIN, CO = process.env.RH_CO;
const KEY = process.env.DATABASE_CREDENTIAL_ENCRYPTION_KEY;
if (!/^daii_test_biz_t\d+_/.test(MAIN) || !/^daii_test_biz_t\d+_/.test(CO)) throw new Error('refusing: database names must be daii_test_biz_tNN_*');
const ADMIN_EMAIL = 'admin@daii.example';
const ADMIN_PASSWORD = process.env.RH_ADMIN_PASSWORD;
const MODULES = ['accounting', 'attendance', 'commission', 'finance', 'hr', 'inventory', 'logistics', 'manufacturing', 'payroll', 'procurement', 'reporting', 'sales', 'targets'];
const TAGS = ['core', 'sales', 'inventory', 'logistics', 'finance', 'hr', 'procurement', 'accounting', 'manufacturing', 'attendance', 'commission', 'payroll', 'targets'];

(async () => {
  const adm = new DataSource({ type: 'postgres', host: HOST, port: PORT, username: USERNAME, password: PASSWORD, database: 'postgres' });
  await adm.initialize();
  for (const n of [MAIN, CO]) { await adm.query(`DROP DATABASE IF EXISTS "${n}" WITH (FORCE)`); await adm.query(`CREATE DATABASE "${n}"`); }
  await adm.destroy();
  const mainCfg = { host: HOST, port: PORT, username: USERNAME, password: PASSWORD, database: MAIN };
  const coCfg = { host: HOST, port: PORT, username: USERNAME, password: PASSWORD, database: CO };
  const { runMigrationsForDatabase } = R('foundation/release-orchestration/company-migration-runner');
  const r1 = await runMigrationsForDatabase(APP, mainCfg, TAGS);
  if (!r1.success) throw new Error('main migration failed: ' + r1.error);
  const r2 = await runMigrationsForDatabase(APP, coCfg, TAGS);
  if (!r2.success) throw new Error('company migration failed: ' + r2.error);
  await R('foundation/company/company-authorization-schema-adjustment').applyCompanyAuthorizationSchemaAdjustment(coCfg);
  const seeding = R('foundation/company/company-role-seeding');
  await seeding.seedCompanyRoleTemplates(coCfg, MODULES);
  await seeding.seedCompanyAdminRole(coCfg, MODULES);

  const { Membership } = R('foundation/company/membership.entity');
  const { MembershipService } = R('foundation/company/membership.service');
  const { Company } = R('foundation/company/company.entity');
  const { User } = R('foundation/identity/user.entity');
  const { UsersService } = R('foundation/identity/users.service');
  const { DatabaseRegistry } = R('foundation/database-registry/database-registry.entity');
  const { DatabaseCredential } = R('foundation/database-registry/database-credential.entity');
  const { DatabaseRegistryService } = R('foundation/database-registry/database-registry.service');
  const { DatabaseCredentialCipherService } = R('foundation/database-registry/database-credential-cipher.service');

  const cp = new DataSource({ type: 'postgres', ...mainCfg, entities: [Membership, Company, User, DatabaseRegistry, DatabaseCredential] });
  await cp.initialize();
  const companyId = randomUUID();
  await cp.query(`INSERT INTO "installation" ("id","installationId","customerName","editionCode","editionVersion","entitlementManifest") VALUES ('installation','rh-installation','Rehearsal','DAII_STANDARD','1.0.0','{}')`);
  await cp.query(`INSERT INTO "companies" ("id","installationId","name","status") VALUES ($1,'installation','Rehearsal Co','READY')`, [companyId]);
  const cipher = new DatabaseCredentialCipherService({ databaseCredentialEncryptionKey: KEY });
  const registry = new DatabaseRegistryService(cp.getRepository(DatabaseRegistry), cp.getRepository(DatabaseCredential), cipher);
  await registry.register({ companyId, host: HOST, port: PORT, databaseName: CO, status: 'ACTIVE' }, JSON.stringify({ username: USERNAME, password: PASSWORD }));
  const users = new UsersService(cp.getRepository(User));
  const memberships = new MembershipService(cp.getRepository(Membership));
  const user = await users.create({ fullName: 'Rehearsal Admin', email: ADMIN_EMAIL });
  await cp.query(`UPDATE "users" SET "status" = 'active' WHERE id = $1`, [user.id]);
  await cp.query(`INSERT INTO "credentials" ("userId","passwordHash","passwordChangedAt") VALUES ($1,$2,now())`, [user.id, await bcrypt.hash(ADMIN_PASSWORD, 10)]);
  await memberships.create({ userId: user.id, companyId, roleKey: 'admin' });

  const co = new DataSource({ type: 'postgres', ...coCfg });
  await co.initialize();
  const role = (await co.query(`SELECT id FROM roles WHERE key = 'admin'`))[0];
  await co.query(`INSERT INTO "users" ("id","fullName","email","status") VALUES ($1,'Rehearsal Admin',$2,'active') ON CONFLICT DO NOTHING`, [user.id, ADMIN_EMAIL]);
  await co.query(`INSERT INTO "user_roles" ("id","userId","roleId") VALUES ($1,$2,$3)`, [randomUUID(), user.id, role.id]);

  // ---- Company master data present BEFORE the upgrade (so the upgrade has something to preserve): chart, open fiscal year, warehouse, product, customer + open invoices, supplier, mapped bank account
  const q = (s, p = []) => co.query(s, p);
  const year = new Date().toISOString().slice(0, 4);
  const accounts = [['1101', 'Cash on Hand', 'asset', 'debit', 'bank'], ['1102', 'Bank', 'asset', 'debit', 'bank'], ['1110', 'Accounts Receivable', 'asset', 'debit', 'ar'], ['1120', 'Inventory', 'asset', 'debit', 'inventory'], ['1140', 'Input VAT', 'asset', 'debit', 'tax_receivable'], ['2101', 'Accounts Payable', 'liability', 'credit', 'ap'], ['4900', 'Other Income', 'revenue', 'credit', null], ['5970', 'Office Expenses', 'expense', 'debit', null], ['3999', 'Cash Movement Clearing', 'equity', 'credit', null]];
  for (const [code, name, type, normal, fn] of accounts) await q(`INSERT INTO "accounting_gl_accounts" ("id","code","name","accountType","normalBalance","isPostable","allowManualJournal","isActive","isContra","controlFunction") VALUES ($1,$2,$3,$4,$5,true,$6,true,false,$7)`, [randomUUID(), code, name, type, normal, fn === null, fn]);
  const fy = randomUUID(), fp = randomUUID();
  await q(`INSERT INTO "accounting_fiscal_years" ("id","code","startDate","endDate") VALUES ($1,'FY',$2,$3)`, [fy, `${year}-01-01`, `${year}-12-31`]);
  await q(`INSERT INTO "accounting_fiscal_periods" ("id","fiscalYearId","code","startDate","endDate") VALUES ($1,$2,'P',$3,$4)`, [fp, fy, `${year}-01-01`, `${year}-12-31`]);
  await q(`INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'accounting_fiscal_year','FiscalYear',$2,'active'), ($3,'accounting_fiscal_period','FiscalPeriod',$4,'open')`, [randomUUID(), fy, randomUUID(), fp]);
  const wh = randomUUID();
  await q(`INSERT INTO "warehouses" ("id","code","name","status") VALUES ($1,'WH-MAIN','Main Warehouse','active')`, [wh]);
  const prod = randomUUID();
  await q(`INSERT INTO "products" ("id","sku","name","unitPrice","status") VALUES ($1,'SKU-RH-1','RH Widget','25.00','active')`, [prod]);
  await q(`INSERT INTO "stock_movements" ("id","warehouseId","productId","quantity","movementType") VALUES ($1,$2,$3,40,'receipt')`, [randomUUID(), wh, prod]);
  const types = await q(`SELECT id FROM treasury_account_types WHERE code = 'bank' LIMIT 1`);
  const ta = randomUUID();
  await q(`INSERT INTO "treasury_accounts" ("id","code","name","accountTypeId","glAccountCode") VALUES ($1,'RH-BANK','RH Bank Account',$2,'1102')`, [ta, types[0].id]);
  const customerId = randomUUID(), soId = randomUUID();
  await q(`INSERT INTO "customers" ("id","code","name","creditLimit") VALUES ($1,'CUST-RH','RH Customer Co','100000.00')`, [customerId]);
  await q(`INSERT INTO "sales_orders" ("id","orderNumber","customerId","salesRepUserId","totalAmount") VALUES ($1,'SO-RH-1',$2,$3,'900.00')`, [soId, customerId, user.id]);
  for (const [num, total] of [['INV-RH-1', '900.00'], ['INV-RH-2', '1200.00']]) {
    const id = randomUUID();
    await q(`INSERT INTO "sales_invoices" ("id","invoiceNumber","customerId","salesOrderId","subtotal","totalAmount","createdByUserId") VALUES ($1,$2,$3,$4,$5,$5,$6)`, [id, num, customerId, soId, total, user.id]);
    await q(`INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'sales_invoice_lifecycle','sales_invoice',$2,'posted')`, [randomUUID(), id]);
    await q(`INSERT INTO customer_ledger_entries (id,"entryNumber","customerId","entryType",direction,amount,"invoiceId","salesOrderId",reference,"entryDate","createdByUserId",status) VALUES (gen_random_uuid(),$1,$2,'sales_invoice','debit',$3,$4,$5,$6,now(),$7,'posted')`, ['CLE-RH-' + num, customerId, total, id, soId, num, user.id]);
  }
  const sup = randomUUID();
  await q(`INSERT INTO "suppliers" ("id","code","legalName") VALUES ($1,'SUP-RH','RH Supplier')`, [sup]);
  console.log(JSON.stringify({ companyId, userId: user.id, main: MAIN, co: CO, mainMigrations: r1.ranMigrationNames ? r1.ranMigrationNames.length : null, coMigrations: r2.ranMigrationNames ? r2.ranMigrationNames.length : null }));
  await co.destroy();
  await cp.destroy();
})().catch((e) => { console.error(e); process.exit(1); });
