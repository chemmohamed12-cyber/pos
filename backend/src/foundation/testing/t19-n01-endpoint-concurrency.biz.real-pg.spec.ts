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
      record(e, 'T-19-summary.json', { rounds, conc, summary });
      await finishBiz(e);
    } catch (err) {
      failure = err;
      throw err;
    }
  });
});
