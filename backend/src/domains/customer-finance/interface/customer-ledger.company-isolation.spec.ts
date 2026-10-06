import { randomUUID } from 'crypto';
import { CustomerLedgerService } from '../application/customer-ledger.service';
import { CustomersService } from '../../crm/application/customers.service';
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
 * Real-Postgres proof that `customer-ledger.controller.ts`'s reads are
 * genuinely Company-scoped after this retrofit — two real, separately
 * provisioned Company databases, each with its own distinct customer and
 * ledger entry (a different balance), never mocked.
 *
 * `CustomersService` is constructed for real (only `AuthorizationService`/
 * `ScopeService` matter for `listCustomers`'s reviewer-bypass path, both
 * real and bound per-Company via the harness, same precedent as
 * `customers.company-isolation.spec.ts`) since `getBalancesForVisibleCustomers`
 * genuinely calls `customers.listCustomers`. `NumberingService`/
 * `AuditService`/`EventBusService`/`LimitService`/`UsersService` are never
 * invoked by the read-only methods this test exercises and are inert.
 */
describe('CustomerLedgerController Area 21 retrofit — real-Postgres Company isolation (2026-09-27)', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let ledgerService: CustomerLedgerService;
  let customersService: CustomersService;
  const actorUserId = randomUUID();

  const seeded: Record<'A' | 'B', { customerId: string; creditLimit: string; entryAmount: string }> = {
    A: { customerId: '', creditLimit: '1000.00', entryAmount: '250.00' },
    B: { customerId: '', creditLimit: '5000.00', entryAmount: '900.00' },
  };

  async function seedCompanyData(companyId: string, key: 'A' | 'B', customerCode: string) {
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

    await ds.query(`INSERT INTO "customers" ("id","code","name","creditLimit") VALUES ($1,$2,$3,$4)`, [
      customerId,
      customerCode,
      `${customerCode} Customer`,
      seeded[key].creditLimit,
    ]);
    await ds.query(
      `INSERT INTO "customer_ledger_entries" ("id","entryNumber","customerId","entryType","direction","amount","entryDate","createdByUserId")
       VALUES ($1,$2,$3,'sales_invoice','debit',$4,now(),$5)`,
      [randomUUID(), `CLE-${customerCode}`, customerId, seeded[key].entryAmount, actorUserId],
    );

    seeded[key].customerId = customerId;
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'customer_ledger_isolation', extraCompanyTags: ['sales', 'finance'] });
    await seedCompanyData(h.companyAId, 'A', 'CUST-CLE-A');
    await seedCompanyData(h.companyBId, 'B', 'CUST-CLE-B');

    const dsA = await h.connections.getDataSource(h.companyAId);
    const inert = {} as never;
    // `listCustomers`'s REVIEWER_ROLES bypass genuinely calls `AuthorizationService.
    // getRoleKeysForUser` — constructed for real here, same precedent as
    // `sales-orders.company-isolation.spec.ts` (bound to Company A's own repos as a
    // fallback; every call in this test supplies its own manager, which always wins).
    const authorization = new AuthorizationService(dsA.getRepository(Role), dsA.getRepository(UserRole));
    customersService = new CustomersService(h.controlPlane, inert, inert, inert, inert, authorization, inert, inert);
    ledgerService = new CustomerLedgerService(h.controlPlane, inert, inert, customersService);
  });

  afterAll(async () => {
    await h.teardown();
  });

  it("getCreditSummary for Company A's own customer resolves Company A's own balance and credit limit — never Company B's", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const summary = await ledgerService.getCreditSummary(seeded.A.customerId, dsA.manager);
    expect(summary.balance).toBe(seeded.A.entryAmount);
    expect(summary.creditLimit).toBe(seeded.A.creditLimit);
  });

  it("getCreditSummary for Company B's own customer resolves Company B's own balance and credit limit — never Company A's", async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    const summary = await ledgerService.getCreditSummary(seeded.B.customerId, dsB.manager);
    expect(summary.balance).toBe(seeded.B.entryAmount);
    expect(summary.creditLimit).toBe(seeded.B.creditLimit);
  });

  it("listLedger for Company A's own customer resolves only Company A's own ledger entry", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const entries = await ledgerService.listLedger(seeded.A.customerId, undefined, dsA.manager);
    expect(entries).toHaveLength(1);
    expect(entries[0].entryNumber).toBe('CLE-CUST-CLE-A');
  });

  it("getBalancesForVisibleCustomers via Company A resolves only Company A's own customer/balance", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const balances = await ledgerService.getBalancesForVisibleCustomers(actorUserId, dsA.manager);
    expect(balances).toEqual([{ customerId: seeded.A.customerId, balance: seeded.A.entryAmount }]);
  });

  it("Test F — resolving Company A's ledger never even requests Company B's DataSource", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      await ledgerService.getCreditSummary(seeded.A.customerId, dsA.manager);
      await ledgerService.listLedger(seeded.A.customerId, undefined, dsA.manager);
      await ledgerService.getBalancesForVisibleCustomers(actorUserId, dsA.manager);
    });
  });
});
