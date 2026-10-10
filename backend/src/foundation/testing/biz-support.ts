/* eslint-disable @typescript-eslint/no-var-requires */
import { randomUUID } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from './two-company-real-pg-harness';
import { InventoryService } from '../../domains/inventory-warehouse/application/inventory.service';
import { WarehouseTransactionsService } from '../../domains/inventory-warehouse/application/warehouse-transactions.service';
import { WAREHOUSE_TRANSACTION_PROCESS } from '../../domains/inventory-warehouse/domain/warehouse-transaction-process';
import { ProductsService } from '../../domains/commerce/application/products.service';
import { AuthorizationService } from '../authorization/authorization.service';
import { AuditService } from '../audit/audit.service';
import { NumberingService } from '../numbering/numbering.service';
import { ProcessEngineService } from '../process-engine/process-engine.service';
import { InventoryPostingPolicyRegistry } from '../inventory-posting-policy/inventory-posting-policy.registry';
import { Role } from '../authorization/role.entity';
import { UserRole } from '../authorization/user-role.entity';

const ev = require('../../../tools/testing/biz-evidence');
const guard = require('../../../tools/testing/db-guard');

/**
 * Shared support for the business-test program (T-01…T-12). Test infrastructure only — no product code.
 * Every run: fresh disposable databases (harness) → approved-instance identity check → test → evidence written and hash-verified
 * BEFORE cleanup → teardown of exactly those databases → proof that no other database changed.
 */
export const FINGERPRINT_TABLES = [
  'stock_movements', 'stock_reservations', 'inventory_valuation_state', 'inventory_valuation_movements', 'accounting_financial_events',
  'accounting_journal_entries', 'accounting_journal_lines', 'event_outbox', 'customer_ledger_entries', 'supplier_ledger_entries',
  'treasury_transactions', 'customer_payments', 'supplier_payments', 'warehouse_transactions', 'warehouse_transaction_lines',
  'process_instances', 'process_transition_records', 'idempotency_records',
];
export const COMPANY_TAGS = ['sales', 'inventory', 'finance', 'procurement', 'accounting'];

export type Status = 'PASS' | 'FAIL' | 'FAIL-DEFECT' | 'BLOCKED' | 'STOP';
export interface CaseResult { id: string; status: Status; note?: string; data?: unknown }

export interface BizEnv {
  testId: string;
  prefix: string;
  h: TwoCompanyHarness;
  dsA: DataSource;
  manager: EntityManager;
  actor: string;
  inventory: InventoryService;
  whTx: WarehouseTransactionsService;
  processEngine: ProcessEngineService;
  audit: AuditService;
  run: any;
  systemIdentifier: string;
  dbNamesBefore: Array<{ datname: string; oid: string }>;
  databases: string[];
  results: CaseResult[];
  extraDataSources: DataSource[];
  finished?: boolean;
}

export async function adminDs(): Promise<DataSource> {
  const ds = new DataSource({
    type: 'postgres', host: process.env.DB_HOST, port: Number(process.env.DB_PORT), username: process.env.DB_USER, password: process.env.DB_PASSWORD,
    database: 'postgres', synchronize: false, logging: false,
  });
  await ds.initialize();
  return ds;
}

async function listDatabases(): Promise<Array<{ datname: string; oid: string }>> {
  const a = await adminDs();
  try {
    return await a.query('SELECT datname, oid::text AS oid FROM pg_database ORDER BY datname');
  } finally {
    await a.destroy();
  }
}

/** Seeds the admin user/role a workflow action needs plus a warehouse; returns ids. */
export async function seedBase(ds: DataSource, actor: string, code: string): Promise<{ warehouseId: string }> {
  await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [actor, 'Biz Test Admin', `biz-admin-${actor}@test.local`]);
  await ds.query(`INSERT INTO "roles" ("id","key") VALUES ($1,'admin') ON CONFLICT DO NOTHING`, [randomUUID()]);
  const role: Array<{ id: string }> = await ds.query(`SELECT id FROM "roles" WHERE "key" = 'admin'`);
  await ds.query(`INSERT INTO "user_roles" ("id","userId","roleId") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [randomUUID(), actor, role[0].id]);
  const warehouseId = randomUUID();
  await ds.query(`INSERT INTO "warehouses" ("id","code","name","status","kind") VALUES ($1,$2,$3,'active','main')`, [warehouseId, `WH-${code}`, `${code} Warehouse`]);
  return { warehouseId };
}

export async function seedWarehouse(ds: DataSource, code: string): Promise<string> {
  const id = randomUUID();
  await ds.query(`INSERT INTO "warehouses" ("id","code","name","status","kind") VALUES ($1,$2,$3,'active','main')`, [id, `WH-${code}`, `${code} Warehouse`]);
  return id;
}

export async function seedProduct(ds: DataSource, sku: string): Promise<string> {
  const id = randomUUID();
  await ds.query(`INSERT INTO "products" ("id","sku","name","unitPrice","status") VALUES ($1,$2,$3,'10.00','active')`, [id, sku, `${sku} Product`]);
  return id;
}

export async function setUpBiz(testId: string, prefix: string, opts: { tags?: string[]; roleModuleCodes?: string[] } = {}): Promise<BizEnv & { warehouseId: string }> {
  const run = ev.createRun(testId);
  const policyEntry = guard.loadPolicy().approved[0];
  if (!policyEntry) throw new Error('STOP: no approved test-database entry (the DB guard would refuse anyway)');
  const admin = await adminDs();
  const systemIdentifier: string = await ev.readSystemIdentifier(admin);
  await admin.destroy();
  if (systemIdentifier !== policyEntry.expectedSystemIdentifier) {
    ev.writeHeader(run, { systemIdentifier, expectedSystemIdentifier: policyEntry.expectedSystemIdentifier });
    ev.writeResult(run, [{ id: 'identity', status: 'STOP', note: 'system_identifier differs from the approved entry' }]);
    ev.finalize(run);
    throw new Error(`STOP: unexpected PostgreSQL system_identifier ${systemIdentifier}`);
  }
  const dbNamesBefore = await listDatabases();
  const databases = ['control_plane', 'company_a', 'company_b'].map((s) => `daii_test_${prefix}_${s}`);
  for (const n of databases) if (dbNamesBefore.some((d) => d.datname === n)) throw new Error(`STOP: ${n} already exists (fresh databases only)`);

  const h = await setUpTwoCompanyHarness({ namePrefix: prefix, extraCompanyTags: opts.tags ?? COMPANY_TAGS, ...(opts.roleModuleCodes ? { roleModuleCodes: opts.roleModuleCodes } : {}) });
  const dsA = await h.connections.getDataSource(h.companyAId);
  const actor = randomUUID();
  const { warehouseId } = await seedBase(dsA, actor, 'A1');

  const inert = {} as never;
  const audit = new AuditService(h.controlPlane);
  const numbering = new NumberingService(h.controlPlane);
  const processEngine = new ProcessEngineService(h.controlPlane);
  const authorization = new AuthorizationService(dsA.getRepository(Role), dsA.getRepository(UserRole));
  const products = new ProductsService(h.controlPlane, audit, inert);
  const policyRegistry = new InventoryPostingPolicyRegistry();
  policyRegistry.bind({
    assertManualReceiptReason: async () => ({ glAccountCode: 'stub' }),
    listManualReceiptReasons: () => ['FOUND_STOCK'],
    assertSaleReturnPostable: async () => undefined,
    assertSupplierInvoicePostable: async () => undefined,
  });
  const eventsStub = { publish: async () => undefined } as never;
  const inventory = new InventoryService(h.controlPlane, audit, inert, inert, numbering, eventsStub, undefined, policyRegistry);
  const whTx = new WarehouseTransactionsService(h.controlPlane, numbering, processEngine, authorization, audit, products, inventory, policyRegistry);

  ev.writeHeader(run, { systemIdentifier, databases, prefix, tags: { controlPlane: ['core'], company: ['core', ...(opts.tags ?? COMPANY_TAGS)] } });
  ev.writeJson(run, 'databases-before.json', dbNamesBefore);
  return { testId, prefix, h, dsA, manager: dsA.manager, actor, inventory, whTx, processEngine, audit, run, systemIdentifier, dbNamesBefore, databases, results: [], extraDataSources: [], warehouseId };
}

/** A clone of the company DataSource with a larger pool so N concurrent calls really run on N connections. */
export async function widePool(env: BizEnv, max: number): Promise<DataSource> {
  const opts: any = env.dsA.options;
  const ds = new DataSource({ ...opts, extra: { ...(opts.extra ?? {}), max, application_name: `biz-${env.testId}` } });
  await ds.initialize();
  env.extraDataSources.push(ds);
  return ds;
}

export async function receive(env: BizEnv, warehouseId: string, productId: string, quantity: number, cost = '4.00'): Promise<string> {
  const txn = await env.whTx.createTransaction('receipt', warehouseId, null, [{ productId, quantity, unitCostBase: cost }], null, null, null, env.actor, undefined, env.manager, 'FOUND_STOCK');
  const state = await env.whTx.transition(txn.id, 'submit', env.actor, env.manager);
  if (state !== 'posted') throw new Error(`receipt did not post (state ${state})`);
  return txn.id;
}

/** issue/transfer document advanced to the `approved` state through the process engine — only the POSTING step remains. */
export async function approvedDoc(
  env: BizEnv, type: 'issue' | 'transfer' | 'adjustment', warehouseId: string, lines: Array<{ productId: string; quantity: number }>, destinationWarehouseId: string | null = null,
): Promise<string> {
  const txn = await env.whTx.createTransaction(type, warehouseId, destinationWarehouseId, lines, null, 'biz-test', null, env.actor, undefined, env.manager);
  await env.whTx.transition(txn.id, 'submit', env.actor, env.manager);
  await env.processEngine.transition(WAREHOUSE_TRANSACTION_PROCESS, 'warehouse_transaction', txn.id, 'approve', env.actor, env.manager);
  return txn.id;
}

export interface Outcome { ok: boolean; kind: string; message?: string }
export function classify(e: unknown): Outcome {
  const err = e as { constructor?: { name?: string }; message?: string; status?: number; getStatus?: () => number };
  const status = typeof err.getStatus === 'function' ? err.getStatus() : err.status;
  return { ok: false, kind: `${err.constructor?.name ?? 'Error'}${status ? `:${status}` : ''}`, message: String(err.message ?? '').slice(0, 200) };
}
export async function attempt(fn: () => Promise<unknown>): Promise<Outcome> {
  try {
    await fn();
    return { ok: true, kind: 'OK' };
  } catch (e) {
    return classify(e);
  }
}
export const tally = (rs: Outcome[]) => rs.reduce<Record<string, number>>((m, r) => ({ ...m, [r.kind]: (m[r.kind] ?? 0) + 1 }), {});

export const fp = (env: BizEnv) => ev.fingerprint(env.dsA, FINGERPRINT_TABLES);
export const fpDiff = (a: Record<string, string>, b: Record<string, string>) => ev.diffFingerprints(a, b);
export const onHand = (env: BizEnv, wh: string, p: string) => env.inventory.getOnHand(wh, p, env.manager);
export const reserved = (env: BizEnv, wh: string, p: string) => env.inventory.getReserved(wh, p, env.manager);

export async function auditChainValid(env: BizEnv): Promise<boolean> {
  return (await env.audit.verifyCompanyChain(env.manager)).valid;
}

export async function negativeStockPairs(env: BizEnv): Promise<number> {
  const r = await env.dsA.query(`SELECT count(*)::int AS n FROM (SELECT 1 FROM stock_movements GROUP BY "warehouseId","productId" HAVING SUM(quantity) < 0) x`);
  return r[0].n;
}

export function record(env: BizEnv, name: string, data: unknown) { ev.writeJson(env.run, name, data); }
export function result(env: BizEnv, id: string, status: Status, note?: string, data?: unknown) { env.results.push({ id, status, note, data }); }

/**
 * Evidence first (written and hash-verified), then cleanup of exactly this run's databases, then proof that no other database changed.
 * Throws AFTER cleanup if any case is FAIL / STOP so jest reports the failure; BLOCKED / FAIL-DEFECT are reported in evidence without hiding them.
 */
export async function finishBiz(env: BizEnv): Promise<void> {
  env.finished = true;
  ev.writeResult(env.run, env.results);
  ev.finalize(env.run); // throws (=> STOP before cleanup) if evidence cannot be re-read with identical hashes
  for (const ds of env.extraDataSources) if (ds.isInitialized) await ds.destroy();
  await env.h.teardown();
  const after = await listDatabases();
  const gone = env.databases.every((n) => !after.some((d) => d.datname === n));
  const othersUnchanged = JSON.stringify(after) === JSON.stringify(env.dbNamesBefore);
  ev.writeJson(env.run, 'post-cleanup.json', { removed: env.databases, allRemoved: gone, otherDatabasesUnchanged: othersUnchanged, databasesAfter: after });
  ev.finalize(env.run);
  if (!gone || !othersUnchanged) throw new Error('STOP: cleanup did not leave the instance as found');
  const bad = env.results.filter((r) => r.status === 'FAIL' || r.status === 'STOP');
  if (bad.length) throw new Error(`cases failed: ${bad.map((b) => `${b.id}=${b.status}`).join(', ')}`);
}

/** Called from afterAll when a test threw before finishBiz: records what exists as STOP evidence, then removes this run's databases only. */
export async function abortBiz(env: BizEnv, reason: unknown): Promise<void> {
  if (env.finished) return;
  env.finished = true;
  try {
    env.results.push({ id: 'run-aborted', status: 'STOP', note: String((reason as Error)?.message ?? reason ?? 'test threw before completion').slice(0, 500) });
    ev.writeResult(env.run, env.results);
    ev.finalize(env.run);
  } finally {
    for (const ds of env.extraDataSources) if (ds.isInitialized) await ds.destroy();
    await env.h.teardown();
  }
}
