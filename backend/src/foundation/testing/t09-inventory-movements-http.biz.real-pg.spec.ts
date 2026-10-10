import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BizEnv, COMPANY_TAGS, FINGERPRINT_TABLES, abortBiz, auditProbe, finishBiz, fp, fpDiff, negativeStockPairs, onHand, receive, record, result, seedBase, seedProduct, setUpBiz } from './biz-support';
import { reconcileAndRecord } from './biz-reconcile';
import { InventoryService } from '../../domains/inventory-warehouse/application/inventory.service';
import { InventoryController } from '../../domains/inventory-warehouse/interface/inventory.controller';
import { JwtAuthGuard } from '../authentication/jwt-auth.guard';
import { CompanyContextGuard } from '../company/company-context.guard';
import { AllExceptionsFilter } from '../error-contract/all-exceptions.filter';
import { ExcelService } from '../excel/excel.service';
import { SALES_PRODUCTS_CONTRACT } from '../module-registry/contracts/sales.contract';
import { AccessScopeService } from '../scope/access-scope.service';
import { AuthorizationContextService } from '../authorization/authorization-context.service';
import { AuthorizationService } from '../authorization/authorization.service';
import { PermissionService } from '../permission/permission.service';
import { RolePermission } from '../permission/role-permission.entity';
import { Role } from '../authorization/role.entity';
import { UserRole } from '../authorization/user-role.entity';
import { ProductsService } from '../../domains/commerce/application/products.service';
import { AuditService } from '../audit/audit.service';

/* eslint-disable @typescript-eslint/no-require-imports */
const request = require('supertest');

/**
 * T-09 (F-INV-001) — FROZEN in docs/decisions/test-program/F-INV-001-FINAL-CONTRACT-AND-T09-CRITERIA-2026-10-10.md §4 (cases E1–E14).
 * HTTP through the REAL controller, the REAL PermissionGuard, WarehouseScopeGuard, RequireModuleGuard (no entitlement resolver => open),
 * ValidationPipe and AllExceptionsFilter, the REAL InventoryService and a REAL PostgreSQL (disposable `daii_test_biz_t09_*`). Only authentication and
 * Company-context resolution are test doubles (they inject `req.user` and the Company DataSource chosen by headers) — that is the boundary under test elsewhere.
 * The expectations are the FROZEN TARGET contract: against today's code E3–E8 are expected to be reported as FAIL-DEFECT (the defect proof), never PASS,
 * and never rewritten to match what the code does. Product code is NOT changed by this test.
 */
describe('T-09 — POST /api/inventory/movements: frozen contract (F-INV-001)', () => {
  jest.setTimeout(900_000);
  let env: (BizEnv & { warehouseId: string }) | undefined;
  let app: INestApplication | undefined;
  let failure: unknown;
  afterAll(async () => {
    if (app) await app.close();
    if (env) await abortBiz(env, failure);
  });

  it('E1–E14', async () => {
    try {
      env = await setUpBiz('T-09', 'biz_t09', { tags: COMPANY_TAGS, roleModuleCodes: ['sales', 'inventory'] });
      const e = env;
      const { h, dsA, actor } = e;
      const dsB = await h.connections.getDataSource(h.companyBId);
      const W1 = e.warehouseId;

      // ---------- fixture: org units, two warehouses, users, roles, stock ----------
      const root = randomUUID(); const u1 = randomUUID(); const u2 = randomUUID();
      await dsA.query(`INSERT INTO org_units (id, type, name, "parentId") VALUES ($1,'company','Root',NULL), ($2,'branch','U1',$1), ($3,'branch','U2',$1)`, [root, u1, u2]);
      const W2 = randomUUID();
      await dsA.query(`INSERT INTO warehouses (id, code, name, status, kind) VALUES ($1,'WH-A2','A2 Warehouse','active','main')`, [W2]);
      await dsA.query(`UPDATE warehouses SET "orgUnitId" = $1 WHERE id = $2`, [u1, W1]);
      await dsA.query(`UPDATE warehouses SET "orgUnitId" = $1 WHERE id = $2`, [u2, W2]);
      const P = await seedProduct(dsA, 'T09-P1');
      await receive(e, W1, P, 5);

      const mkUser = async (ds: typeof dsA, name: string) => {
        const id = randomUUID();
        await ds.query(`INSERT INTO users (id, "fullName", email) VALUES ($1,$2,$3)`, [id, name, `${name.toLowerCase()}-${id.slice(0, 6)}@t09.local`]);
        return id;
      };
      const A1 = await mkUser(dsA, 'A1'); const A2 = await mkUser(dsA, 'A2'); const A0 = await mkUser(dsA, 'A0');
      await seedBase(dsB, actor, 'B1'); // Company B admin = the acting id there
      const B1 = actor;
      const roleRow = async (key: string) => {
        await dsA.query(`INSERT INTO roles (id, key) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [randomUUID(), key]);
        return (await dsA.query(`SELECT id FROM roles WHERE key = $1`, [key]))[0].id as string;
      };
      const ww = await roleRow('warehouse_worker');
      const hadPermission = (await dsA.query(`SELECT count(*)::int AS n FROM role_permissions WHERE "roleId" = $1 AND "nodeKey" = 'inventory.movement.create'`, [ww]))[0].n;
      if (!hadPermission) await dsA.query(`INSERT INTO role_permissions (id, "roleId", "nodeKey", access) VALUES ($1,$2,'inventory.movement.create','editable')`, [randomUUID(), ww]);
      record(e, 'T-09-fixture.json', { warehouseWorkerHasMovementCreateByDefaultInFreshCompany: hadPermission > 0, note: 'if false, the fixture grants it so the frozen scenario (A1 holds the permission) can run; the default is itself a finding' });
      for (const u of [A1, A2]) await dsA.query(`INSERT INTO user_roles (id, "userId", "roleId") VALUES ($1,$2,$3)`, [randomUUID(), u, ww]);
      await dsA.query(`INSERT INTO access_scopes (id, "userId", "orgUnitId", "includeDescendants", "createdBy") VALUES ($1,$2,$3,false,$4), ($5,$6,$7,false,$4)`, [randomUUID(), A1, u1, actor, randomUUID(), A2, u2]);
      // B1 already holds the 'admin' role in Company B via seedBase

      // ---------- the application: real controller + real guards; auth & company context are doubles ----------
      const authorization = new AuthorizationService(dsA.getRepository(Role), dsA.getRepository(UserRole));
      const contexts = new AuthorizationContextService(h.controlPlane);
      const permission = new PermissionService(h.controlPlane.getRepository(RolePermission), authorization);
      const scopes = new AccessScopeService(h.controlPlane, authorization, contexts);
      const products = new ProductsService(h.controlPlane, new AuditService(h.controlPlane), {} as never);
      const moduleRef = await Test.createTestingModule({
        controllers: [InventoryController],
        providers: [
          { provide: InventoryService, useValue: e.inventory },
          { provide: ExcelService, useValue: {} },
          { provide: SALES_PRODUCTS_CONTRACT, useValue: products },
          { provide: AccessScopeService, useValue: scopes },
          { provide: PermissionService, useValue: permission },
          { provide: AuthorizationContextService, useValue: contexts },
        ],
      })
        .overrideGuard(JwtAuthGuard).useValue({
          canActivate: (ctx: any) => {
            const req = ctx.switchToHttp().getRequest();
            const uid = req.headers['x-test-user'];
            if (!uid) return false;
            req.user = { id: uid, email: `${uid}@t09.local` };
            return true;
          },
        })
        .overrideGuard(CompanyContextGuard).useValue({
          canActivate: (ctx: any) => {
            const req = ctx.switchToHttp().getRequest();
            const company = req.headers['x-test-company'] === 'B' ? { id: h.companyBId, ds: dsB } : { id: h.companyAId, ds: dsA };
            req.companyContext = { companyId: company.id, dataSource: company.ds };
            return true;
          },
        })
        .compile();
      app = moduleRef.createNestApplication();
      app.setGlobalPrefix('api');
      app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
      app.useGlobalFilters(new AllExceptionsFilter());
      await app.init();
      const http = app.getHttpServer();
      const post = (user: string, body: unknown, company: 'A' | 'B' = 'A') => request(http).post('/api/inventory/movements').set('x-test-user', user).set('x-test-company', company).send(body as object);

      const evidence = require('../../../tools/testing/biz-evidence');
      const fpAB = async () => ({ A: await fp(e), B: await evidence.fingerprint(dsB, FINGERPRINT_TABLES) });

      const refused = async (id: string, user: string, body: unknown, accepted: number[], company: 'A' | 'B' = 'A') => {
        const before = await fpAB();
        const res = await post(user, body, company);
        const after = await fpAB();
        const diffA = fpDiff(before.A, after.A); const diffB = fpDiff(before.B, after.B);
        const noTrace = diffA.length === 0 && diffB.length === 0;
        const statusOk = accepted.includes(res.status);
        record(e, `T-09-${id}.json`, { request: body, user, status: res.status, body: res.body, fingerprintDiffA: diffA, fingerprintDiffB: diffB });
        // PASS only when the contract holds: refused with an accepted status AND no trace. A 2xx that changed data against the frozen contract is FAIL-DEFECT (the defect proof).
        result(e, id, statusOk && noTrace ? 'PASS' : 'FAIL-DEFECT', JSON.stringify({ status: res.status, traceTables: [...diffA, ...diffB].map((d) => d.table) }));
      };
      const base = { warehouseId: W1, productId: P };

      // E1: valid receipt
      const e1Before = await onHand(e, W1, P);
      const r1 = await post(A1, { ...base, quantity: 3, movementType: 'receipt', unitCostBase: '4.00', reasonCode: 'FOUND_STOCK' });
      record(e, 'T-09-E1.json', { status: r1.status, body: r1.body });
      result(e, 'E1', r1.status === 201 && (await onHand(e, W1, P)) === e1Before + 3 ? 'PASS' : 'FAIL', JSON.stringify({ status: r1.status }));

      // E2: invalid receipts (no cost / no reason / qty 0 / qty -1 / unknown reason)
      for (const [i, body] of [
        { ...base, quantity: 3, movementType: 'receipt', reasonCode: 'FOUND_STOCK' }, { ...base, quantity: 3, movementType: 'receipt', unitCostBase: '4.00' },
        { ...base, quantity: 0, movementType: 'receipt', unitCostBase: '4.00', reasonCode: 'FOUND_STOCK' }, { ...base, quantity: -1, movementType: 'receipt', unitCostBase: '4.00', reasonCode: 'FOUND_STOCK' },
      ].entries()) await refused(`E2-${i + 1}`, A1, body, [400, 409, 422]);

      // E3–E8: movement types that the frozen contract CLOSES (expected 410 and no trace)
      const onHandNow = await onHand(e, W1, P);
      await refused('E3', A1, { ...base, quantity: -(onHandNow + 1), movementType: 'dispatch' }, [410]);
      await refused('E4', A1, { ...base, quantity: -2, movementType: 'dispatch' }, [410]);
      await refused('E5', A1, { ...base, quantity: 4, movementType: 'dispatch' }, [410]);
      await refused('E6-1', A1, { ...base, quantity: 2, movementType: 'adjustment' }, [410]);
      await refused('E6-2', A1, { ...base, quantity: -2, movementType: 'adjustment' }, [410]);
      await refused('E6-3', A1, { ...base, quantity: -9, movementType: 'adjustment' }, [410]);
      await refused('E7-1', A1, { ...base, quantity: -2, movementType: 'transfer_out' }, [410]);
      await refused('E7-2', A1, { ...base, quantity: 2, movementType: 'transfer_in' }, [410]);
      await refused('E8-1', A1, { ...base, quantity: 1, movementType: 'return' }, [410]);
      await refused('E8-2', A1, { ...base, quantity: -1, movementType: 'return' }, [410]);

      // E9: malformed quantities
      await refused('E9-1', A1, { ...base, quantity: 0, movementType: 'dispatch' }, [400, 410]);
      await refused('E9-2', A1, { ...base, quantity: 1.5, movementType: 'dispatch' }, [400]);
      await refused('E9-3', A1, { ...base, quantity: 'abc', movementType: 'dispatch' }, [400]);
      // E10: unknown warehouse / product
      await refused('E10-1', A1, { ...base, warehouseId: randomUUID(), quantity: 1, movementType: 'receipt', unitCostBase: '4.00', reasonCode: 'FOUND_STOCK' }, [404]);
      await refused('E10-2', A1, { ...base, productId: randomUUID(), quantity: 1, movementType: 'receipt', unitCostBase: '4.00', reasonCode: 'FOUND_STOCK' }, [404, 400]);
      // E11: A2 (scoped to W2) on W1
      await refused('E11', A2, { ...base, quantity: 1, movementType: 'receipt', unitCostBase: '4.00', reasonCode: 'FOUND_STOCK' }, [404]);
      // E12: A0 has no permission
      await refused('E12', A0, { ...base, quantity: 1, movementType: 'receipt', unitCostBase: '4.00', reasonCode: 'FOUND_STOCK' }, [404]);
      // E13: B1 (Company B) addressing Company A's identifiers
      await refused('E13', B1, { ...base, quantity: 1, movementType: 'receipt', unitCostBase: '4.00', reasonCode: 'FOUND_STOCK' }, [404, 400], 'B');
      // E14: positive control after all refusals
      const before14 = await onHand(e, W1, P);
      const r14 = await post(A1, { ...base, quantity: 2, movementType: 'receipt', unitCostBase: '4.00', reasonCode: 'FOUND_STOCK' });
      result(e, 'E14', r14.status === 201 && (await onHand(e, W1, P)) === before14 + 2 ? 'PASS' : 'FAIL', JSON.stringify({ status: r14.status }));

      // global: record how many closed-type attempts changed the ledger (the defect measurement) and the resulting balances
      const neg = await negativeStockPairs(e);
      record(e, 'T-09-final-state.json', { negativeStockPairs: neg, onHand: await onHand(e, W1, P) });
      result(e, 'observation-negative-stock-after-run', neg === 0 ? 'PASS' : 'FAIL-DEFECT', `pairs with negative on-hand after the closed-type attempts: ${neg} (a defect measurement, not a harness fault)`);
      await auditProbe(e, 'final');
      await reconcileAndRecord(e, { explainedPairs: [], notes: ['T-09 against today\'s code may legitimately leave ledger/valuation divergence created by the defect itself; any R failure here is reported as a finding with the E-case that caused it'] });
      await finishBiz(e);
      const hard = e.results.filter((r) => r.status === 'FAIL' || r.status === 'STOP');
      expect(hard).toEqual([]);
    } catch (err) {
      failure = err;
      throw err;
    }
  });
});
