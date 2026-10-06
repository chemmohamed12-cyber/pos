import { NotFoundException } from '@nestjs/common';
import { SalesService } from '../application/sales.service';
import { AuthorizationService } from '../../../foundation/authorization/authorization.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { Role } from '../../../foundation/authorization/role.entity';
import { UserRole } from '../../../foundation/authorization/user-role.entity';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Area 21 (2026-10-05, CTO-authorized) — real-Postgres Company isolation for `sales.controller.ts` (`sales/reps`, Matrix §38).
 * The blocker was the platform-level `assignRole`; under the authorized "Company-level authorization" the grant now lands in
 * the Company's own `user_roles`. A Sales Rep profile and its `sales_rep` role exist only in the Company that created them.
 */
describe('SalesController (sales/reps) Area 21 retrofit — real-Postgres Company isolation', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let sales: SalesService;
  let authorization: AuthorizationService;
  let repA = '';
  let repB = '';

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'sales_reps_isolation', extraCompanyTags: ['sales'] });
    const dsA = await h.connections.getDataSource(h.companyAId);
    authorization = new AuthorizationService(dsA.getRepository(Role), dsA.getRepository(UserRole)); // fallback-only: every call below supplies a manager
    sales = new SalesService(h.controlPlane, new NumberingService(h.controlPlane), authorization, new AuditService(h.controlPlane));
    repA = (await h.createUserWithAdminRoleIn('Rep A', h.companyAId)).id;
    repB = (await h.createUserWithAdminRoleIn('Rep B', h.companyBId)).id;
  });

  afterAll(async () => {
    await h.teardown();
  });

  const mgr = async (id: string) => (await h.connections.getDataSource(id)).manager;

  it('a Sales Rep profile and its role are created in the Company\'s own database only', async () => {
    const mA = await mgr(h.companyAId);
    const mB = await mgr(h.companyBId);
    const profile = await sales.createSalesRepProfile(repA, 'Cairo', repA, mA);
    expect(profile.salesCode).toMatch(/^REP/);
    expect(await sales.isSalesRep(repA, mA)).toBe(true);
    expect(await authorization.getUserIdsForRole('sales_rep', mA)).toEqual([repA]);
    expect(await authorization.getUserIdsForRole('sales_rep', mB)).toEqual([]);
    await expect(sales.getSalesRepProfile(repA, mB)).rejects.toBeInstanceOf(NotFoundException);
    expect(await sales.isSalesRep(repB, mB)).toBe(false);
  });

  it('the same person can be a Sales Rep in one Company without becoming one in another; a duplicate is rejected per Company', async () => {
    const mA = await mgr(h.companyAId);
    const mB = await mgr(h.companyBId);
    await expect(sales.createSalesRepProfile(repA, null, repA, mA)).rejects.toThrow(/already has a Sales Rep profile/);
    await sales.createSalesRepProfile(repB, 'Giza', repB, mB);
    expect((await sales.getSalesRepProfile(repB, mB)).territory).toBe('Giza');
    expect(await authorization.getUserIdsForRole('sales_rep', mB)).toEqual([repB]);
    await authorization.revokeRole(repB, 'sales_rep', mB);
    expect(await sales.isSalesRep(repB, mB)).toBe(false);
    expect(await sales.isSalesRep(repA, mA)).toBe(true); // A untouched
  });

  it('Test F — a Company database holds no User rows (ADR-073) and the profile write still works; the platform catalog was never written', async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    expect((await dsA.query(`SELECT count(*)::int n FROM users`))[0].n).toBe(0);
    const dsB = await h.connections.getDataSource(h.companyBId);
    expect((await dsB.query(`SELECT count(*)::int n FROM sales_rep_profiles`))[0].n).toBe(1);
    const amb = await h.controlPlane.query(`SELECT to_regclass('public.sales_rep_profiles') AS t`);
    expect(amb[0].t).toBeNull();
  });
});
