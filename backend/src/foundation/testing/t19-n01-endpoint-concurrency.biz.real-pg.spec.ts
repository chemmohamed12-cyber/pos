import { randomUUID } from 'crypto';
import { BizEnv, abortBiz, finishBiz, record, result, seedProduct, setUpBiz, widePool } from './biz-support';
import { NumberingService } from '../numbering/numbering.service';
import { AuthorizationService } from '../authorization/authorization.service';
import { Role } from '../authorization/role.entity';
import { UserRole } from '../authorization/user-role.entity';
import { AuditService } from '../audit/audit.service';
import { CustomersService } from '../../domains/crm/application/customers.service';
import { SupplierService } from '../../domains/procurement/application/supplier.service';
import { PriceListsService } from '../../domains/commerce/application/price-lists.service';
import { ProductsService } from '../../domains/commerce/application/products.service';
import { SalesService } from '../../domains/sales/application/sales.service';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { CustomersController } from '../../domains/crm/interface/customers.controller';
import { JwtAuthGuard } from '../authentication/jwt-auth.guard';
import { CompanyContextGuard } from '../company/company-context.guard';
import { AllExceptionsFilter } from '../error-contract/all-exceptions.filter';
import { ExcelService } from '../excel/excel.service';
import { PermissionService } from '../permission/permission.service';
import { RolePermission } from '../permission/role-permission.entity';
import { AuthorizationContextService } from '../authorization/authorization-context.service';
import { AccessScopeService } from '../scope/access-scope.service';

/**
 * T-19 — N-01 PER-ENDPOINT CONCURRENCY (regression test for the numbering/process-engine remediation; informational, outside the frozen T-xx set).
 * Each case drives the service method EXACTLY as its controller does — with `req.companyContext.dataSource.manager`, i.e. a plain manager with NO open
 * transaction — from many concurrent callers, and checks the user-visible guarantee: every request succeeds and receives a DISTINCT, persisted document code.
 * Paths covered (all call `NumberingService.getNextNumber(type, manager)`): customer create, supplier create, price-list create, sales-rep profile create.
 * Control: the same calls inside manager.transaction. Run BEFORE the fix these cases fail (duplicate numbers → unique violations / HTTP 500 / collision-skipping);
 * AFTER the fix they pass. Disposable databases `daii_test_biz_t19_*` only.
 */
describe('T-19 — concurrent creates through the numbering-based endpoints (plain manager, as controllers call them)', () => {
  jest.setTimeout(900_000);
  let env: (BizEnv & { warehouseId: string }) | undefined;
  let failure: unknown;
  afterAll(async () => {
    if (env) await abortBiz(env, failure);
  });

  it('every concurrent create succeeds with a distinct code', async () => {
    try {
      env = await setUpBiz('T-19', 'biz_t19');
      const e = env;
      const wide = await widePool(e, 40);
      const inert = {} as never;
      const audit = new AuditService(e.h.controlPlane);
      const numbering = new NumberingService(e.h.controlPlane);
      const authz = new AuthorizationService(e.dsA.getRepository(Role), e.dsA.getRepository(UserRole));
      const limitsStub = { check: async () => ({ allowed: true, max: null }), consume: async () => ({ allowed: true, max: null }) } as never;
      const customers = new CustomersService(e.h.controlPlane, numbering, inert, audit, { publish: async () => undefined } as never, authz, inert, limitsStub);
      const suppliers = new SupplierService(e.h.controlPlane, audit, inert, numbering);
      const products = new ProductsService(e.h.controlPlane, audit, inert);
      const priceLists = new PriceListsService(e.h.controlPlane, numbering, audit, products, { publish: async () => undefined } as never);
      const sales = new SalesService(e.h.controlPlane, numbering, authz, audit);
      await numbering.registerDocumentType('customer', 'CUS', false, e.manager);
      await numbering.registerDocumentType('price_list', 'PL', false, e.manager);
      await numbering.registerDocumentType('sales_rep', 'SR', false, e.manager);
      await e.dsA.query(`INSERT INTO roles (id, key) VALUES ($1,'sales_rep') ON CONFLICT DO NOTHING`, [randomUUID()]);
      void seedProduct;

      const rounds = 8; const conc = 10;
      type Case = { name: string; table: string; codeColumn: string; call: (mgr: import('typeorm').EntityManager, tag: string) => Promise<unknown> };
      const cases: Case[] = [
        { name: 'customer.create', table: 'customers', codeColumn: 'code', call: (m, tag) => customers.createCustomer({ name: `c-${tag}` } as never, e.actor, m) },
        { name: 'supplier.create', table: 'suppliers', codeColumn: 'code', call: (m, tag) => suppliers.create({ legalName: `s-${tag}` } as never, e.actor, m) },
        { name: 'priceList.create', table: 'price_lists', codeColumn: 'code', call: (m, tag) => priceLists.createPriceList(`pl-${tag}`, e.actor, m) },
        {
          name: 'salesRep.create', table: 'sales_rep_profiles', codeColumn: '"salesCode"',
          call: async (m, tag) => {
            const uid = randomUUID();
            await e.dsA.query(`INSERT INTO users (id, "fullName", email) VALUES ($1,$2,$3)`, [uid, `rep-${tag}`, `rep-${tag}-${uid.slice(0, 6)}@t19.local`]);
            return sales.createSalesRepProfile(uid, null, e.actor, m);
          },
        },
      ];
      const summary: Record<string, unknown> = {};
      for (const c of cases) {
        for (const style of ['plain', 'transaction'] as const) {
          const errors: Record<string, number> = {};
          let ok = 0;
          for (let r = 0; r < rounds; r += 1) {
            const settled = await Promise.allSettled(Array.from({ length: conc }, (_, i) => {
              const tag = `${style}-${r}-${i}`;
              return style === 'plain' ? c.call(wide.manager, tag) : wide.manager.transaction((tx) => c.call(tx, tag));
            }));
            for (const s of settled) {
              if (s.status === 'fulfilled') ok += 1;
              else { const rr = s.reason as { code?: string; name?: string; message?: string }; const k = String(rr?.code ?? rr?.name ?? 'error') + (rr?.code ? '' : ':' + String(rr?.message ?? '').slice(0, 70)); errors[k] = (errors[k] ?? 0) + 1; }
            }
          }
          const expected = rounds * conc;
          const stored = (await e.dsA.query(`SELECT count(*)::int AS n, count(DISTINCT ${c.codeColumn})::int AS d FROM ${c.table} WHERE ${c.codeColumn} IS NOT NULL`))[0] as { n: number; d: number };
          summary[`${c.name}/${style}`] = { expected, succeeded: ok, errors, storedRows: stored.n, distinctCodes: stored.d };
          const good = ok === expected && Object.keys(errors).length === 0;
          result(e, `T-19-${c.name}-${style}`, good ? 'PASS' : 'FAIL-DEFECT', JSON.stringify({ succeeded: ok, expected, errors }));
        }
        // distinctness over everything this endpoint stored (plain + transaction runs share one table)
        const dd = (await e.dsA.query(`SELECT count(*)::int AS n, count(DISTINCT ${c.codeColumn})::int AS d FROM ${c.table} WHERE ${c.codeColumn} IS NOT NULL`))[0] as { n: number; d: number };
        result(e, `T-19-${c.name}-codes-distinct`, dd.n === dd.d ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(dd));
      }
      // ---- HTTP level: POST /api/customers through the REAL CustomersController, guards, ValidationPipe and AllExceptionsFilter (auth and Company context are doubles) ----
      {
        const moduleRef = await Test.createTestingModule({
          controllers: [CustomersController],
          providers: [
            { provide: CustomersService, useValue: customers },
            { provide: ExcelService, useValue: {} },
            // the controller's route-level PermissionGuard (other routes) is resolved at module compile time: same real services as T-09/T-16
            { provide: PermissionService, useValue: new PermissionService(e.h.controlPlane.getRepository(RolePermission), authz) },
            { provide: AuthorizationContextService, useValue: new AuthorizationContextService(e.h.controlPlane) },
            { provide: AccessScopeService, useValue: new AccessScopeService(e.h.controlPlane, authz, new AuthorizationContextService(e.h.controlPlane)) },
          ],
        })
          .overrideGuard(JwtAuthGuard).useValue({ canActivate: (ctx: any) => { ctx.switchToHttp().getRequest().user = { id: e.actor, email: 'n01@test.local' }; return true; } })
          .overrideGuard(CompanyContextGuard).useValue({ canActivate: (ctx: any) => { ctx.switchToHttp().getRequest().companyContext = { companyId: e.h.companyAId, dataSource: wide }; return true; } })
          .compile();
        const app = moduleRef.createNestApplication();
        app.setGlobalPrefix('api');
        app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
        app.useGlobalFilters(new AllExceptionsFilter());
        await app.init();
        await app.listen(0, '127.0.0.1');
        try {
          const base = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}/api`;
          const statuses: Record<string, number> = {}; const codes = new Set<string>(); let total = 0;
          for (let r = 0; r < 8; r += 1) {
            const res = await Promise.all(Array.from({ length: 15 }, async (_, i) => {
              const resp = await fetch(`${base}/customers`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: `http-${r}-${i}` }) });
              const body = (await resp.json().catch(() => ({}))) as { code?: string };
              return { status: resp.status, code: body.code };
            }));
            for (const x of res) { total += 1; statuses[x.status] = (statuses[x.status] ?? 0) + 1; if (x.code) codes.add(x.code); }
          }
          record(e, 'T-19-http-customers.json', { total, statuses, distinctCodes: codes.size });
          result(e, 'T-19-http-POST-customers', statuses['201'] === total && codes.size === total ? 'PASS' : 'FAIL-DEFECT', JSON.stringify({ total, statuses, distinctCodes: codes.size }));
        } finally {
          await app.close();
        }
      }

      // ---- N-02 (informational, NOT part of the N-01 remediation): NumberingService.registerDocumentType is a check-then-insert; the FIRST concurrent use of a not-yet-registered
      // document type (e.g. the first supplier created in a Company) races on the unique document type. Lazy callers: SupplierService.create. Measured, not fixed.
      const regStats: Record<string, { roundsWithErrors: number; errors: Record<string, number>; rows: number }> = {};
      for (const style of ['plain', 'transaction'] as const) {
        let bad = 0; const errs: Record<string, number> = {}; let rows = 0;
        for (let r = 0; r < 10; r += 1) {
          const type = `REG_${style}_${r}`.toUpperCase();
          const settled = await Promise.allSettled(Array.from({ length: 10 }, () => (style === 'plain'
            ? numbering.registerDocumentType(type, 'RG', false, wide.manager)
            : wide.manager.transaction((tx) => numbering.registerDocumentType(type, 'RG', false, tx)))));
          const rejected = settled.filter((s) => s.status === 'rejected') as PromiseRejectedResult[];
          if (rejected.length) bad += 1;
          for (const s of rejected) { const k = String((s.reason as { code?: string; name?: string })?.code ?? (s.reason as Error)?.name ?? 'error'); errs[k] = (errs[k] ?? 0) + 1; }
          rows += Number((await e.dsA.query(`SELECT count(*)::int AS n FROM numbering_sequences WHERE "documentType" = $1`, [type]))[0].n);
        }
        regStats[style] = { roundsWithErrors: bad, errors: errs, rows };
        result(e, `T-19-N02-registerDocumentType-${style}`, bad === 0 && rows === 10 ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(regStats[style]));
      }
      record(e, 'T-19-N02-register-document-type.json', regStats);
      record(e, 'T-19-summary.json', { rounds, conc, summary });
      await finishBiz(e);
    } catch (err) {
      failure = err;
      throw err;
    }
  });
});
