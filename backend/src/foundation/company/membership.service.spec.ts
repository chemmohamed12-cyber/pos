import { Repository } from 'typeorm';
import { MembershipService } from './membership.service';
import { Membership } from './membership.entity';

describe('MembershipService', () => {
  let service: MembershipService;
  const memberships = new Map<string, Membership>();
  let idSeq = 0;

  const repoMock = {
    create: jest.fn((data: Partial<Membership>) => ({ id: `membership-${++idSeq}`, createdAt: new Date(), ...data }) as Membership),
    save: jest.fn(async (m: Membership) => {
      memberships.set(m.id, m);
      return m;
    }),
    findOne: jest.fn(async ({ where }: { where: { userId?: string; companyId?: string } }) =>
      [...memberships.values()].find((m) => (!where.userId || m.userId === where.userId) && (!where.companyId || m.companyId === where.companyId)) ?? null,
    ),
    find: jest.fn(async ({ where }: { where: { companyId: string } }) => [...memberships.values()].filter((m) => m.companyId === where.companyId)),
  };

  beforeEach(() => {
    memberships.clear();
    idSeq = 0;
    jest.clearAllMocks();
    service = new MembershipService(repoMock as unknown as Repository<Membership>);
  });

  it('creates a membership tying a user to a company with a role key', async () => {
    const m = await service.create({ userId: 'user-1', companyId: 'company-1', roleKey: 'sales.manager' });
    expect(m.userId).toBe('user-1');
    expect(m.companyId).toBe('company-1');
    expect(m.roleKey).toBe('sales.manager');
  });

  it('finds a membership by user and company', async () => {
    await service.create({ userId: 'user-1', companyId: 'company-1', roleKey: 'sales.manager' });
    const found = await service.findByUserAndCompany('user-1', 'company-1');
    expect(found?.roleKey).toBe('sales.manager');
  });

  it('does not find a membership for a different company (no cross-company leakage)', async () => {
    await service.create({ userId: 'user-1', companyId: 'company-1', roleKey: 'sales.manager' });
    const found = await service.findByUserAndCompany('user-1', 'company-2');
    expect(found).toBeNull();
  });

  it('lists every membership for a company', async () => {
    await service.create({ userId: 'user-1', companyId: 'company-1', roleKey: 'sales.manager' });
    await service.create({ userId: 'user-2', companyId: 'company-1', roleKey: 'sales.rep' });
    await service.create({ userId: 'user-3', companyId: 'company-2', roleKey: 'hr.manager' });

    const forCompany1 = await service.findByCompany('company-1');
    expect(forCompany1).toHaveLength(2);
  });
});
