import { randomUUID } from 'crypto';
import { cpus, totalmem } from 'os';
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { COMPANY_TAGS, abortBiz, auditProbe, finishBiz, negativeStockPairs, record, result, seedBase, seedProduct, widePool } from './biz-support';
import { reconcileAndRecord } from './biz-reconcile';
import { FinEnv, setUpFinance } from './biz-finance-support';
import { PaymentsController } from '../../domains/customer-finance/interface/payments.controller';
import { TreasuryController } from '../../domains/treasury/interface/treasury.controller';
import { InventoryController } from '../../domains/inventory-warehouse/interface/inventory.controller';
import { InventoryService } from '../../domains/inventory-warehouse/application/inventory.service';
import { PaymentsService } from '../../domains/customer-finance/application/payments.service';
import { TreasuryService } from '../../domains/treasury/application/treasury.service';
import { IdempotencyService } from '../error-contract/idempotency.service';
import { EventBusService } from '../events/event-bus.service';
import { JwtAuthGuard } from '../authentication/jwt-auth.guard';
import { CompanyContextGuard } from '../company/company-context.guard';
import { AllExceptionsFilter } from '../error-contract/all-exceptions.filter';
import { ExcelService } from '../excel/excel.service';
import { SALES_PRODUCTS_CONTRACT } from '../module-registry/contracts/sales.contract';
import { SALES_CUSTOMERS_CONTRACT } from '../module-registry/contracts/sales.contract';
import { AccessScopeService } from '../scope/access-scope.service';
import { AuthorizationContextService } from '../authorization/authorization-context.service';
import { AuthorizationService } from '../authorization/authorization.service';
import { PermissionService } from '../permission/permission.service';
import { RolePermission } from '../permission/role-permission.entity';
import { Role } from '../authorization/role.entity';
import { UserRole } from '../authorization/user-role.entity';
import { ProductsService } from '../../domains/commerce/application/products.service';
import { AuditService } from '../audit/audit.service';
import { ScopeService } from '../scope/scope.service';
import { ScopeResolver } from '../scope/scope-resolver.service';
import { OrganizationService } from '../organization/organization.service';
import { NumberingService as NumberingSvc } from '../numbering/numbering.service';

/**
 * T-16 — HTTP-LEVEL CAPACITY BENCHMARK (informational; NOT a frozen acceptance test; NO capacity PASS/FAIL).
 * The targets are PROPOSED only (docs/decisions/test-program/CAPACITY-WORKLOAD-ASSUMPTIONS-AND-PROPOSED-TARGETS-2026-10-10.md, tools/testing/capacity-profile.json): until
 * they are approved, this test records measurements and verifies only INTEGRITY (the oracle at the end): no duplicate financial effect, exact balances, intact audit
 * chains, clean reconciliation, no unauthorised inventory outcome.
 * Path: real HTTP (node fetch, keep-alive) -> real controllers (Payments, Treasury, Inventory) -> real guards (PermissionGuard, RequireModuleGuard, ValidationPipe,
 * AllExceptionsFilter) -> real services -> real PostgreSQL. Test doubles: authentication and Company-context resolution only (headers choose user and Company A/B).
 * The load generator, the application and PostgreSQL share ONE small machine: results are conservative for the app and not extrapolable to hosting.
 * Disposable databases `daii_test_biz_t16_*` only.
 */
const PROFILE = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'tools', 'testing', 'capacity-profile.json'), 'utf8'));
const SCALE = Number(process.env.CAPACITY_SCALE ?? '1');
const pct = (s: number[], p: number) => (s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : 0);

interface Ctx { company: 'A' | 'B'; ds: DataSource; accounts: string[]; products: string[]; warehouseId: string; customerId: string; ledger: { cashIn: number; cashOut: number; payments: number; receipts: number; receiptUnits: number; okByAccount: Record<string, number> } }

describe('T-16 — HTTP capacity benchmark (measurements + integrity oracle)', () => {
  jest.setTimeout(3_600_000);
  let env: FinEnv | undefined;
  let app: INestApplication | undefined;
  let failure: unknown;
  afterAll(async () => {
    if (app) await app.close();
    if (env) await abortBiz(env, failure);
  });

  it('ramp, hot-spot, sustained, peak, recovery over HTTP', async () => {
    try {
      env = await setUpFinance('T-16', 'biz_t16');
      const e = env;
      const dsA = e.dsA;
      const dsB = await e.h.connections.getDataSource(e.h.companyBId);
      const actor = e.actor;

      // ---------- fixtures: Company B finance + N accounts / products per Company ----------
      const year = new Date().toISOString().slice(0, 4);
      const NACC = PROFILE.perCompany.treasuryAccounts as number;
      const NPROD = PROFILE.perCompany.products as number;
      await seedBase(dsB, actor, 'B16');
      const seedFinance = async (ds: DataSource, label: string, includeBase: boolean) => {
        const codes = Array.from({ length: NACC }, (_, i) => String(1102 + i));
        if (!includeBase) {
          for (const [code, name, type, normal, fn] of [['1110', 'Accounts Receivable', 'asset', 'debit', 'ar'], ['2101', 'Accounts Payable', 'liability', 'credit', 'ap'], ['1199', 'Cash Movement Clearing', 'asset', 'debit', null]] as const) {
            await ds.query(`INSERT INTO "accounting_gl_accounts" ("id","code","name","accountType","normalBalance","isPostable","allowManualJournal","isActive","controlFunction") VALUES ($1,$2,$3,$4,$5,true,false,true,$6)`, [randomUUID(), code, name, type, normal, fn]);
          }
        }
        for (const code of codes.slice(includeBase ? 1 : 0)) {
          await ds.query(`INSERT INTO "accounting_gl_accounts" ("id","code","name","accountType","normalBalance","isPostable","allowManualJournal","isActive","controlFunction") VALUES ($1,$2,$3,'asset','debit',true,false,true,'bank')`, [randomUUID(), code, `Bank ${code}`]);
        }
        if (!includeBase) {
          const fy = randomUUID(); const fpId = randomUUID();
          await ds.query(`INSERT INTO "accounting_fiscal_years" ("id","code","startDate","endDate") VALUES ($1,'FY',$2,$3)`, [fy, `${year}-01-01`, `${year}-12-31`]);
          await ds.query(`INSERT INTO "accounting_fiscal_periods" ("id","fiscalYearId","code","startDate","endDate") VALUES ($1,$2,'P',$3,$4)`, [fpId, fy, `${year}-01-01`, `${year}-12-31`]);
          await ds.query(`INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'accounting_fiscal_year','FiscalYear',$2,'active'), ($3,'accounting_fiscal_period','FiscalPeriod',$4,'open')`, [randomUUID(), fy, randomUUID(), fpId]);
          const { NumberingService } = await import('../numbering/numbering.service');
          const { JOURNAL_ENTRY_DOCUMENT_TYPE } = await import('../../domains/accounting/application/journal-entry.service');
          await new NumberingService(e.h.controlPlane).registerDocumentType(JOURNAL_ENTRY_DOCUMENT_TYPE, 'JV', true, ds.manager);
        }
        const bankType = (await e.treasury.listAccountTypes(ds.manager)).find((t) => t.code === 'bank')!;
        const accounts: string[] = includeBase ? [e.bankAccountId] : [];
        for (let i = includeBase ? 1 : 0; i < NACC; i += 1) {
          const acct = await e.treasury.createAccount(`CAP-${label}-${i}`, `Cap ${label} ${i}`, bankType.id, actor, ds.manager);
          await e.treasury.setAccountGlMapping(acct.id, codes[i], actor, ds.manager);
          accounts.push(acct.id);
        }
        for (const a of accounts) await e.treasury.cashIn(a, '1000000.00', null, null, null, 'T-16 opening funding', actor, ds.manager); // non-emitting
        let customerId = e.customerId;
        if (!includeBase) { customerId = randomUUID(); await ds.query(`INSERT INTO "customers" ("id","code","name","creditLimit") VALUES ($1,$2,'Cap Customer','1000000000.00')`, [customerId, `CAP-CUST-${label}`]); }
        else await ds.query(`UPDATE "customers" SET "creditLimit" = '1000000000.00' WHERE id = $1`, [customerId]);
        const products: string[] = [];
        for (let i = 0; i < NPROD; i += 1) products.push(await seedProduct(ds, `CAP-${label}-P${i}`));
        const w = includeBase ? e.warehouseId : (await ds.query(`SELECT id FROM warehouses LIMIT 1`))[0].id;
        return { accounts, products, warehouseId: w as string, customerId };
      };
      const fa = await seedFinance(dsA, 'A', true);
      const fb = await seedFinance(dsB, 'B', false);
      const mk = (company: 'A' | 'B', ds: DataSource, f: Awaited<ReturnType<typeof seedFinance>>): Ctx => ({ company, ds, ...f, ledger: { cashIn: 0, cashOut: 0, payments: 0, receipts: 0, receiptUnits: 0, okByAccount: {} } });
      const ctxs: Record<'A' | 'B', Ctx> = { A: mk('A', dsA, fa), B: mk('B', dsB, fb) };
      const FUND = 1_000_000;

      // ---------- the application: real controllers + guards; auth / company context are doubles ----------
      const authorization = new AuthorizationService(dsA.getRepository(Role), dsA.getRepository(UserRole));
      const contexts = new AuthorizationContextService(e.h.controlPlane);
      const permission = new PermissionService(e.h.controlPlane.getRepository(RolePermission), authorization);
      const scopes = new AccessScopeService(e.h.controlPlane, authorization, contexts);
      const products = new ProductsService(e.h.controlPlane, new AuditService(e.h.controlPlane), {} as never);
      // the treasury READ endpoints need a real scope resolver (the finance fixture builds its TreasuryService with an inert one): a dedicated instance serves the HTTP controller
      const scopeResolver = new ScopeResolver(new ScopeService(e.h.controlPlane, {} as never), new OrganizationService(e.h.controlPlane), authorization, new AccessScopeService(e.h.controlPlane, authorization));
      const treasuryHttp = new TreasuryService(e.h.controlPlane, new NumberingSvc(e.h.controlPlane), new AuditService(e.h.controlPlane), scopeResolver, e.events);
      const moduleRef = await Test.createTestingModule({
        controllers: [PaymentsController, TreasuryController, InventoryController],
        providers: [
          { provide: PaymentsService, useValue: e.payments },
          { provide: SALES_CUSTOMERS_CONTRACT, useValue: (e.payments as unknown as { customers: unknown }).customers },
          { provide: IdempotencyService, useValue: e.idempotency },
          { provide: EventBusService, useValue: e.events },
          { provide: TreasuryService, useValue: treasuryHttp },
          { provide: InventoryService, useValue: e.inventory },
          { provide: ExcelService, useValue: {} },
          { provide: SALES_PRODUCTS_CONTRACT, useValue: products },
          { provide: AccessScopeService, useValue: scopes },
          { provide: PermissionService, useValue: permission },
          { provide: AuthorizationContextService, useValue: contexts },
        ],
      })
        .overrideGuard(JwtAuthGuard).useValue({ canActivate: (ctx: any) => { const req = ctx.switchToHttp().getRequest(); req.user = { id: actor, email: 'cap@test.local' }; return true; } })
        .overrideGuard(CompanyContextGuard).useValue({
          canActivate: (ctx: any) => {
            const req = ctx.switchToHttp().getRequest();
            const c = req.headers['x-test-company'] === 'B' ? { id: e.h.companyBId, ds: dsB } : { id: e.h.companyAId, ds: dsA };
            req.companyContext = { companyId: c.id, dataSource: c.ds };
            return true;
          },
        })
        .compile();
      app = moduleRef.createNestApplication();
      app.setGlobalPrefix('api');
      app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
      app.useGlobalFilters(new AllExceptionsFilter());
      await app.init();
      await app.listen(0, '127.0.0.1');
      const base = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}/api`;

      // ---------- HTTP helpers ----------
      type Res = { status: number; ms: number; ok: boolean };
      const call = async (company: 'A' | 'B', method: string, path: string, body?: unknown, key?: string): Promise<Res> => {
        const t0 = performance.now();
        let status = 0;
        try {
          const r = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', 'x-test-company': company, ...(key ? { 'idempotency-key': key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
          await r.arrayBuffer();
          status = r.status;
        } catch { status = -1; }
        return { status, ms: performance.now() - t0, ok: status >= 200 && status < 300 };
      };
      const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
      const mix = PROFILE.mix as Array<{ op: string; weight: number }>;
      const totalW = mix.reduce((s, m) => s + m.weight, 0);
      const chooseOp = () => { let r = Math.random() * totalW; for (const m of mix) { if ((r -= m.weight) < 0) return m.op; } return mix[0].op; };

      const runOp = async (kind: 'distributed' | 'hot'): Promise<{ op: string; r: Res }> => {
        const op = chooseOp();
        const c = kind === 'hot' ? ctxs.A : ctxs[Math.random() < 0.5 ? 'A' : 'B'];
        const acct = kind === 'hot' ? c.accounts[0] : pick(c.accounts);
        const prod = kind === 'hot' ? c.products[0] : pick(c.products);
        const key = randomUUID();
        let r: Res;
        if (op === 'payment.on-account') {
          r = await call(c.company, 'POST', '/payments/on-account', { customerId: c.customerId, amount: '1.00', method: 'bank_transfer', treasuryAccountId: acct, reference: key.slice(0, 20) }, key);
          if (r.ok) { c.ledger.payments += 1; c.ledger.okByAccount[acct] = (c.ledger.okByAccount[acct] ?? 0) + 1; }
        } else if (op === 'inventory.receipt') {
          r = await call(c.company, 'POST', '/inventory/movements', { warehouseId: c.warehouseId, productId: prod, quantity: 1, movementType: 'receipt', unitCostBase: '4.00', reasonCode: 'FOUND_STOCK' });
          if (r.ok) { c.ledger.receipts += 1; c.ledger.receiptUnits += 1; }
        } else if (op === 'treasury.cash-in') {
          r = await call(c.company, 'POST', '/treasury/cash-in', { accountId: acct, amount: '1.00', reference: key.slice(0, 20) }, key);
          if (r.ok) { c.ledger.cashIn += 1; c.ledger.okByAccount[acct] = (c.ledger.okByAccount[acct] ?? 0) + 1; }
        } else if (op === 'treasury.cash-out') {
          r = await call(c.company, 'POST', '/treasury/cash-out', { accountId: acct, amount: '1.00', reference: key.slice(0, 20) }, key);
          if (r.ok) { c.ledger.cashOut += 1; c.ledger.okByAccount[acct] = (c.ledger.okByAccount[acct] ?? 0) - 1; }
        } else if (op === 'read.treasury-accounts') {
          r = await call(c.company, 'GET', '/treasury/accounts');
        } else {
          r = await call(c.company, 'GET', `/inventory/reports/movements?warehouseId=${c.warehouseId}`);
        }
        return { op, r };
      };

      // ---------- resource sampling ----------
      const samples: Array<Record<string, number>> = [];
      let prevCpu = cpus().map((c) => ({ ...c.times }));
      let prevProc = process.cpuUsage();
      let prevT = Date.now();
      let tick = 0;
      const sampleOnce = async () => {
        tick += 1;
        const now = cpus().map((c) => ({ ...c.times }));
        let idle = 0; let total = 0;
        now.forEach((t, i) => { const p = prevCpu[i]; const d = (t.user - p.user) + (t.nice - p.nice) + (t.sys - p.sys) + (t.irq - p.irq) + (t.idle - p.idle); total += d; idle += t.idle - p.idle; });
        prevCpu = now;
        const pu = process.cpuUsage(prevProc); prevProc = process.cpuUsage();
        const dt = (Date.now() - prevT) / 1000; prevT = Date.now();
        const row: Record<string, number> = { tSec: tick * 2, systemCpuPct: total ? Number((100 * (1 - idle / total)).toFixed(1)) : 0, nodeCpuPctOfOneCore: Number((100 * (pu.user + pu.system) / 1e6 / dt).toFixed(1)), nodeRssMB: Math.round(process.memoryUsage().rss / 2 ** 20) };
        if (tick % 3 === 0) {
          const r = spawnSync('powershell', ['-NoProfile', '-Command', "(Get-Process postgres -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum).Sum"], { encoding: 'utf8', timeout: 5000 });
          row.postgresRssMB = Math.round(Number((r.stdout || '0').trim() || 0) / 2 ** 20);
        }
        try { row.dbConnections = (await dsA.query('SELECT count(*)::int AS n FROM pg_stat_activity'))[0].n; } catch { /* ignore */ }
        samples.push(row);
      };
      const sampler = setInterval(() => { void sampleOnce(); }, 2000);

      // ---------- phases ----------
      const phaseResults: Array<Record<string, unknown>> = [];
      const wide = await widePool(e, 4); void wide;
      const runStep = async (phase: string, kind: 'distributed' | 'hot', users: number, seconds: number, windowSeconds?: number) => {
        const lat: Record<string, number[]> = {}; const status: Record<string, number> = {}; let okCount = 0; let total = 0;
        const windows: Array<{ t: number; p95: number; n: number }> = [];
        let cur: number[] = []; let winStart = Date.now();
        const end = Date.now() + seconds * 1000;
        const t0 = Date.now();
        const cpuStart = samples.length;
        const worker = async () => {
          while (Date.now() < end) {
            const { op, r } = await runOp(kind);
            total += 1; if (r.ok) okCount += 1;
            (lat[op] ??= []).push(r.ms); status[String(r.status)] = (status[String(r.status)] ?? 0) + 1;
            if (windowSeconds) { cur.push(r.ms); if (Date.now() - winStart >= windowSeconds * 1000) { cur.sort((a, b) => a - b); windows.push({ t: Math.round((Date.now() - t0) / 1000), p95: Math.round(pct(cur, 95)), n: cur.length }); cur = []; winStart = Date.now(); } }
          }
        };
        await Promise.all(Array.from({ length: users }, worker));
        const wall = (Date.now() - t0) / 1000;
        const all = Object.values(lat).flat().sort((a, b) => a - b);
        const perOp = Object.fromEntries(Object.entries(lat).map(([op, v]) => { v.sort((a, b) => a - b); return [op, { n: v.length, p50: Math.round(pct(v, 50)), p95: Math.round(pct(v, 95)), p99: Math.round(pct(v, 99)) }]; }));
        const slice = samples.slice(cpuStart);
        const maxOf = (k: string) => Math.max(0, ...slice.map((s) => s[k] ?? 0));
        const avgOf = (k: string) => { const v = slice.map((s) => s[k]).filter((x) => x !== undefined); return v.length ? Number((v.reduce((a, b) => a + b, 0) / v.length).toFixed(1)) : 0; };
        phaseResults.push({ phase, kind, virtualUsers: users, seconds: Number(wall.toFixed(1)), requests: total, success2xx: okCount, nonSuccess: total - okCount, statusCodes: status, requestsPerSec: Number((total / wall).toFixed(1)), p50: Math.round(pct(all, 50)), p95: Math.round(pct(all, 95)), p99: Math.round(pct(all, 99)), perOp, windows, resources: { systemCpuAvgPct: avgOf('systemCpuPct'), systemCpuMaxPct: maxOf('systemCpuPct'), nodeRssMaxMB: maxOf('nodeRssMB'), postgresRssMaxMB: maxOf('postgresRssMB'), dbConnectionsMax: maxOf('dbConnections') } });
      };
      for (const ph of PROFILE.phases as Array<{ name: string; kind: 'distributed' | 'hot'; virtualUsers: number[]; secondsEach: number; windowSeconds?: number }>) {
        for (const users of ph.virtualUsers) await runStep(ph.name, ph.kind, users, Math.max(3, Math.round(ph.secondsEach * SCALE)), ph.windowSeconds);
        await e.events.dispatchAfterCommit(dsA.manager); // keep the outbox from growing unbounded between phases (the app does this per request too)
      }
      clearInterval(sampler);

      // ---------- idempotency-at-HTTP probe: the same key sent 3x concurrently -> exactly one effect ----------
      const probeKeys = Array.from({ length: 15 }, () => randomUUID());
      const probeRes = await Promise.all(probeKeys.flatMap((k, i) => [0, 1, 2].map(() => (i % 2 === 0
        ? call('A', 'POST', '/payments/on-account', { customerId: ctxs.A.customerId, amount: '1.00', method: 'bank_transfer', treasuryAccountId: ctxs.A.accounts[2], reference: `idem-${i}` }, k)
        : call('A', 'POST', '/treasury/cash-in', { accountId: ctxs.A.accounts[3], amount: '1.00', reference: `idem-${i}` }, k)))));
      const probeOk = probeRes.filter((r) => r.ok).length;
      // each key => exactly one stored effect (payment or treasury leg) => count rows by reference
      const idemRows = (await dsA.query(`SELECT (SELECT count(*)::int FROM customer_payments WHERE reference LIKE 'idem-%') + (SELECT count(*)::int FROM treasury_transactions WHERE reference LIKE 'idem-%') AS n`))[0].n as number;
      ctxs.A.ledger.payments += probeKeys.filter((_, i) => i % 2 === 0).length; ctxs.A.ledger.okByAccount[ctxs.A.accounts[2]] = (ctxs.A.ledger.okByAccount[ctxs.A.accounts[2]] ?? 0) + probeKeys.filter((_, i) => i % 2 === 0).length;
      ctxs.A.ledger.cashIn += probeKeys.filter((_, i) => i % 2 === 1).length; ctxs.A.ledger.okByAccount[ctxs.A.accounts[3]] = (ctxs.A.ledger.okByAccount[ctxs.A.accounts[3]] ?? 0) + probeKeys.filter((_, i) => i % 2 === 1).length;
      const idemOk = idemRows === probeKeys.length;

      // ---------- drain the outbox completely, then the integrity oracle ----------
      let drained = 0;
      for (const ds of [dsA, dsB]) for (let i = 0; i < 2000; i += 1) { const d = await e.events.dispatchAfterCommit(ds.manager); drained += d.dispatched; if (d.dispatched === 0) break; }
      const oracle: Record<string, unknown> = { drainedEvents: drained, idempotencyProbe: { keys: probeKeys.length, httpOk: probeOk, storedEffects: idemRows, ok: idemOk } };
      let oracleOk = idemOk;
      for (const c of [ctxs.A, ctxs.B]) {
        const balErrors: string[] = [];
        for (const a of c.accounts) {
          const bal = Number(await e.treasury.getAccountBalance(a, c.ds.manager));
          const expected = FUND + (c.ledger.okByAccount[a] ?? 0);
          if (bal !== expected) balErrors.push(`${a.slice(0, 8)}: ${bal} != ${expected}`);
        }
        const payRows = (await c.ds.query(`SELECT count(*)::int AS n FROM customer_payments`))[0].n;
        const onHandUnits = Number((await c.ds.query(`SELECT coalesce(sum(quantity),0)::int AS n FROM stock_movements`))[0].n);
        const unpostedEvents = (await c.ds.query(`SELECT count(*)::int AS n FROM accounting_financial_events WHERE status <> 'POSTED'`))[0].n;
        const unbalanced = (await c.ds.query(`SELECT count(*)::int AS n FROM (SELECT "journalEntryId" FROM accounting_journal_lines GROUP BY 1 HAVING sum("debitBase") <> sum("creditBase")) x`))[0].n;
        const chain = await e.audit.verifyCompanyChain(c.ds.manager);
        const neg = (await c.ds.query(`SELECT count(*)::int AS n FROM (SELECT 1 FROM stock_movements GROUP BY "warehouseId","productId" HAVING sum(quantity) < 0) x`))[0].n;
        const ok = balErrors.length === 0 && payRows === c.ledger.payments && onHandUnits === c.ledger.receiptUnits && unpostedEvents === 0 && unbalanced === 0 && chain.valid && neg === 0;
        oracle[`company${c.company}`] = { balErrors, payRows, expectedPayments: c.ledger.payments, onHandUnits, expectedReceiptUnits: c.ledger.receiptUnits, unpostedEvents, unbalancedJournals: unbalanced, auditChainValid: chain.valid, negativeStockPairs: neg, ok };
        if (!ok) oracleOk = false;
      }
      const hardware = { cpuModel: cpus()[0]?.model, logicalCpus: cpus().length, totalMemGB: Number((totalmem() / 2 ** 30).toFixed(1)), node: process.version, profile: 'tools/testing/capacity-profile.json', scale: SCALE, note: 'load generator + application + PostgreSQL share one machine; fsync=off, autovacuum=off; local only' };
      record(e, 'T-16-capacity-http.json', { hardware, profile: PROFILE, phases: phaseResults, oracle });
      record(e, 'T-16-resource-samples.json', samples);
      result(e, 'T-16-integrity-oracle', oracleOk ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(oracle).slice(0, 700));
      result(e, 'T-16-measurements-recorded', 'PASS', `phases=${phaseResults.length}; capacity NOT classified (targets unapproved)`);

      await auditProbe(e, 'final');
      await reconcileAndRecord(e, { nonGlTreasury: FUND * NACC, notes: [`${NACC} x ${FUND}.00 opening funding cash-ins are deliberately non-emitting (Company A); Company B verified by the oracle above`] });
      void COMPANY_TAGS; void negativeStockPairs;
      await finishBiz(e);
      expect(e.results.filter((r) => r.status === 'FAIL' || r.status === 'STOP')).toEqual([]);
    } catch (err) {
      failure = err;
      throw err;
    }
  });
});
