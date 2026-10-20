import { EventBusService } from '../../../foundation/events/event-bus.service';
import { randomUUID } from 'crypto';
import { TreasuryService } from '../application/treasury.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { IdempotencyService } from '../../../foundation/error-contract/idempotency.service';
import { ScopeResolver } from '../../../foundation/scope/scope-resolver.service';
import { AccessScopeService } from '../../../foundation/scope/access-scope.service';
import { ScopeService } from '../../../foundation/scope/scope.service';
import { OrganizationService } from '../../../foundation/organization/organization.service';
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
 * Real-Postgres proof that `treasury.controller.ts`'s reads/writes are
 * genuinely Company-scoped after this retrofit — two real, separately
 * provisioned Company databases, each with its own distinct account type,
 * account, and cash movement, never mocked.
 *
 * This is also the real-Postgres proof for the TWO foundation-level fixes
 * made in the same pass: `OrganizationService` and `IdempotencyService`
 * were both still `@InjectRepository`-based (same class of gap
 * `ScopeService` had before its own fix, §16) — `ScopeResolver`/
 * `IdempotencyService` are constructed for real here (not stubbed),
 * bound to each Company's own connection, to prove the fix actually
 * routes correctly rather than just compiling.
 */
describe('TreasuryController Area 21 retrofit — real-Postgres Company isolation (2026-09-27)', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let service: TreasuryService;
  let idempotency: IdempotencyService;
  const actorUserId = randomUUID();

  const seeded: Record<'A' | 'B', { accountTypeId: string; accountId: string }> = {
    A: { accountTypeId: '', accountId: '' },
    B: { accountTypeId: '', accountId: '' },
  };

  async function seedCompanyData(companyId: string, key: 'A' | 'B', code: string) {
    const ds = await h.connections.getDataSource(companyId);
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [
      actorUserId,
      'Isolation Test Admin',
      `iso-admin-${companyId}@test.local`,
    ]);
    const accountTypeId = randomUUID();
    const accountId = randomUUID();
    await ds.query(`INSERT INTO "treasury_account_types" ("id","code","name") VALUES ($1,$2,$3)`, [
      accountTypeId,
      `TAT-${code}`,
      `${code} Type`,
    ]);
    await ds.query(`INSERT INTO "treasury_accounts" ("id","code","name","accountTypeId","status","glAccountCode") VALUES ($1,$2,$3,$4,'active','1101')`, [
      accountId,
      `TA-${code}`,
      `${code} Account`,
      accountTypeId,
    ]);
    seeded[key] = { accountTypeId, accountId };
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'treasury_isolation', extraCompanyTags: ['sales', 'finance'] });
    await seedCompanyData(h.companyAId, 'A', 'A001');
    await seedCompanyData(h.companyBId, 'B', 'B001');

    const dsA = await h.connections.getDataSource(h.companyAId);
    const audit = new AuditService(h.controlPlane);
    const scopeService = new ScopeService(h.controlPlane, {} as never);
    const organization = new OrganizationService(h.controlPlane);
    const authorization = new AuthorizationService(dsA.getRepository(Role), dsA.getRepository(UserRole));
    const scopeResolver = new ScopeResolver(scopeService, organization, authorization, new AccessScopeService(h.controlPlane, authorization));
    const numbering = new NumberingService(h.controlPlane);
    service = new TreasuryService(h.controlPlane, numbering, audit, scopeResolver, new EventBusService({} as never, h.connections));
    idempotency = new IdempotencyService(h.controlPlane);
  });

  afterAll(async () => {
    await h.teardown();
  });

  it("listAccountTypes via Company A resolves Company A's own account type, plus its own migration-seeded defaults — never Company B's", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const types = await service.listAccountTypes(dsA.manager);
    expect(types.map((t) => t.code)).toContain('TAT-A001');
    expect(types.map((t) => t.code)).not.toContain('TAT-B001');
  });

  it("listAccountTypes via Company B resolves Company B's own account type, plus its own migration-seeded defaults — no leakage of Company A's data", async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    const types = await service.listAccountTypes(dsB.manager);
    expect(types.map((t) => t.code)).toContain('TAT-B001');
    expect(types.map((t) => t.code)).not.toContain('TAT-A001');
  });

  it("cashInDirect writes into the correct Company's own ledger — verified via that Company's own getAccountBalance afterwards", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const dsB = await h.connections.getDataSource(h.companyBId);
    await service.cashInDirect(seeded.A.accountId, '500.00', null, null, null, null, actorUserId, dsA.manager);
    expect(await service.getAccountBalance(seeded.A.accountId, dsA.manager)).toBe('500.00');
    // Company B's own account balance is untouched.
    expect(await service.getAccountBalance(seeded.B.accountId, dsB.manager)).toBe('0.00');
  });

  it("listAccountsWithBalances via Company A resolves Company A's own account, plus its own migration-seeded default — never Company B's, correctly scoped through the real ScopeResolver/OrganizationService chain", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const accounts = await service.listAccountsWithBalances(actorUserId, undefined, dsA.manager);
    expect(accounts.map((a) => a.code)).toContain('TA-A001');
    expect(accounts.map((a) => a.code)).not.toContain('TA-B001');
  });

  it("IdempotencyService: the SAME (scope, key) pair in two different Companies does not collide — each Company gets its own real cash-in leg, proving the foundation fix actually routes per-Company", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const dsB = await h.connections.getDataSource(h.companyBId);
    const sharedKey = 'shared-idempotency-key-across-companies';

    await idempotency.withIdempotency(
      'treasury.cash-in',
      sharedKey,
      () => service.cashInDirect(seeded.A.accountId, '50.00', null, null, null, null, actorUserId, dsA.manager),
      dsA.manager,
    );
    await idempotency.withIdempotency(
      'treasury.cash-in',
      sharedKey,
      () => service.cashInDirect(seeded.B.accountId, '75.00', null, null, null, null, actorUserId, dsB.manager),
      dsB.manager,
    );

    // Each Company's own cash-in actually ran (neither was treated as a replay of the other's) —
    // Company A's balance now reflects its earlier 500.00 + this 50.00 = 550.00.
    expect(await service.getAccountBalance(seeded.A.accountId, dsA.manager)).toBe('550.00');
    expect(await service.getAccountBalance(seeded.B.accountId, dsB.manager)).toBe('75.00');
  });

  it("Test F — resolving Company A's treasury data never even requests Company B's DataSource", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      await service.listAccountTypes(dsA.manager);
      await service.getAccountBalance(seeded.A.accountId, dsA.manager);
      await service.listAccountsWithBalances(actorUserId, undefined, dsA.manager);
    });
  });
});
