import { randomUUID } from 'crypto';
import { SalesOrdersService } from '../application/sales-orders.service';
import { AuthorizationService } from '../../../foundation/authorization/authorization.service';
import { Role } from '../../../foundation/authorization/role.entity';
import { UserRole } from '../../../foundation/authorization/user-role.entity';
import {
  setUpTwoCompanyHarness,
  TwoCompanyHarness,
  assertDataSourceNeverRequestedFor,
} from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Area 21 Operational Company Scoping Retrofit (2026-09-27, CTO-authorized).
 * Real-Postgres reproduction + fix-proof for the exact bug Frontend found
 * live (a new Company's Dashboard/Sales showed the legacy Company's
 * "245.00 / 2 Sales Orders" figures) — `SalesOrdersService.listOrders`,
 * confirmed BEFORE this retrofit to always read the ambient/Platform
 * DataSource regardless of which Company was selected. Exercises the
 * SERVICE directly (the exact unit `sales-orders.controller.ts` now
 * threads `req.companyContext.dataSource.manager` into) against two real,
 * separately-provisioned Company databases with genuinely distinct data —
 * not mocked, not a synthetic in-memory DataSource.
 *
 * Only `AuthorizationService` is constructed for real — it is the only
 * one of `SalesOrdersService`'s 10 dependencies `listOrders` actually
 * calls (`getRoleKeysForUser`); the other 9 are never touched by this
 * method and are passed as inert stand-ins, the same "construct only
 * what the code path under test actually needs" precedent this codebase
 * already uses (`database-provisioning.service.spec.ts`).
 *
 * Minimal fixture, deliberately: `listOrders` only needs `sales_orders` +
 * its FK targets (`customers`, `users`) to exist — it never touches
 * pricing/inventory/process-engine, so this test does not construct a
 * full order via `createOrder` (that pipeline's own correctness is
 * unchanged by this retrofit and already covered elsewhere). Each
 * Company's `sales_orders`/`customers`/`users` rows are inserted directly,
 * with distinct `orderNumber`s per Company, so a genuine cross-Company
 * leak would be immediately visible as "the wrong order number showed up."
 */
describe('SalesOrdersController Area 21 retrofit — real-Postgres Company isolation (2026-09-27)', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let service: SalesOrdersService;
  const actorUserId = randomUUID();

  async function seedOrder(companyId: string, orderNumber: string, customerName: string) {
    const ds = await h.connections.getDataSource(companyId);
    const customerId = randomUUID();
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [
      actorUserId,
      'Isolation Test Rep',
      `iso-rep-${companyId}@test.local`,
    ]);
    await ds.query(`INSERT INTO "customers" ("id","code","name") VALUES ($1,$2,$3)`, [customerId, `CUST-${orderNumber}`, customerName]);
    await ds.query(`INSERT INTO "sales_orders" ("id","orderNumber","customerId","salesRepUserId","totalAmount") VALUES ($1,$2,$3,$4,$5)`, [
      randomUUID(),
      orderNumber,
      customerId,
      actorUserId,
      '245.00',
    ]);
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'so_isolation', extraCompanyTags: ['sales'] });
    await seedOrder(h.companyAId, 'SO-COMPANY-A-0001', 'Company A Customer');
    await seedOrder(h.companyBId, 'SO-COMPANY-B-0001', 'Company B Customer');

    const dsA = await h.connections.getDataSource(h.companyAId);
    const authorization = new AuthorizationService(dsA.getRepository(Role), dsA.getRepository(UserRole));
    const inert = {} as never;
    service = new SalesOrdersService(inert, inert, inert, inert, authorization, inert, inert, inert, inert, inert, inert);
  });

  afterAll(async () => {
    await h.teardown();
  });

  it("listOrders via Company A resolves only Company A's real order", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const orders = await service.listOrders(actorUserId, dsA.manager);
    expect(orders.map((o) => o.orderNumber)).toEqual(['SO-COMPANY-A-0001']);
  });

  it("listOrders via Company B resolves only Company B's real order — no leakage of Company A's data", async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    const orders = await service.listOrders(actorUserId, dsB.manager);
    expect(orders.map((o) => o.orderNumber)).toEqual(['SO-COMPANY-B-0001']);
  });

  it("Test F — resolving Company A's orders never even requests Company B's DataSource", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      await service.listOrders(actorUserId, dsA.manager);
    });
  });
});
