import { randomUUID } from 'crypto';
import { CustomersService } from '../application/customers.service';
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
 * Real-Postgres proof that `customers.controller.ts`'s reads are genuinely
 * Company-scoped after this retrofit — two real, separately provisioned
 * Company databases, each with its own distinct customer and primary-rep
 * assignment, never mocked.
 *
 * The test actor is seeded with the `admin` role directly in EACH
 * Company's own `roles`/`user_roles` tables (REVIEWER_ROLES bypass), so
 * `listCustomers`/`getCustomer` skip `ScopeService` entirely — only
 * `AuthorizationService.getRoleKeysForUser(userId, manager)` is exercised
 * for real, the same "construct only what the code path under test
 * actually needs" precedent as `sales-orders.company-isolation.spec.ts`.
 */
describe('CustomersController Area 21 retrofit — real-Postgres Company isolation (2026-09-27)', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let service: CustomersService;
  const actorUserId = randomUUID();

  async function seedCompanyData(companyId: string, key: 'A' | 'B', customerName: string) {
    const ds = await h.connections.getDataSource(companyId);
    const customerId = randomUUID();

    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [
      actorUserId,
      'Isolation Test Admin',
      `iso-admin-${companyId}@test.local`,
    ]);

    const roleId = randomUUID();
    await ds.query(`INSERT INTO "roles" ("id","key") VALUES ($1,'admin') ON CONFLICT DO NOTHING`, [roleId]);
    const role: Array<{ id: string }> = await ds.query(`SELECT id FROM "roles" WHERE "key" = 'admin'`);
    await ds.query(`INSERT INTO "user_roles" ("id","userId","roleId") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [
      randomUUID(),
      actorUserId,
      role[0].id,
    ]);

    await ds.query(`INSERT INTO "customers" ("id","code","name") VALUES ($1,$2,$3)`, [customerId, `CUST-${key}-001`, customerName]);
    await ds.query(
      `INSERT INTO "customer_assignments" ("id","customerId","salesRepUserId","assignmentType","status") VALUES ($1,$2,$3,'primary','active')`,
      [randomUUID(), customerId, actorUserId],
    );
    return customerId;
  }

  const customerIds: Record<'A' | 'B', string> = { A: '', B: '' };

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'customers_isolation', extraCompanyTags: ['sales', 'finance'] });
    customerIds.A = await seedCompanyData(h.companyAId, 'A', 'Company A Customer');
    customerIds.B = await seedCompanyData(h.companyBId, 'B', 'Company B Customer');

    const dsA = await h.connections.getDataSource(h.companyAId);
    const authorization = new AuthorizationService(dsA.getRepository(Role), dsA.getRepository(UserRole));
    const inert = {} as never;
    service = new CustomersService(inert, inert, inert, inert, inert, authorization, inert, inert);
  });

  afterAll(async () => {
    await h.teardown();
  });

  it("listCustomers via Company A resolves only Company A's real customer", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const customers = await service.listCustomers(actorUserId, dsA.manager);
    expect(customers.map((c) => c.code)).toEqual(['CUST-A-001']);
  });

  it("listCustomers via Company B resolves only Company B's real customer — no leakage of Company A's data", async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    const customers = await service.listCustomers(actorUserId, dsB.manager);
    expect(customers.map((c) => c.code)).toEqual(['CUST-B-001']);
  });

  it("getCustomer for Company A's own customer id succeeds via Company A's manager", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const customer = await service.getCustomer(customerIds.A, actorUserId, dsA.manager);
    expect(customer.code).toBe('CUST-A-001');
  });

  it("getCustomer for Company A's customer id 404s via Company B's manager — the row genuinely does not exist in Company B's own database", async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    await expect(service.getCustomer(customerIds.A, actorUserId, dsB.manager)).rejects.toThrow();
  });

  it("getPrimaryRepNamesByCustomerId resolves each Company's own assignment via the manager-threaded raw-SQL join — never the other Company's", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const dsB = await h.connections.getDataSource(h.companyBId);
    const namesA = await service.getPrimaryRepNamesByCustomerId([customerIds.A], dsA.manager);
    expect(namesA.get(customerIds.A)).toBe('Isolation Test Admin');
    const namesB = await service.getPrimaryRepNamesByCustomerId([customerIds.B], dsB.manager);
    expect(namesB.get(customerIds.B)).toBe('Isolation Test Admin');
  });

  it("Test F — resolving Company A's customers never even requests Company B's DataSource", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      await service.listCustomers(actorUserId, dsA.manager);
      await service.getCustomer(customerIds.A, actorUserId, dsA.manager);
    });
  });
});
