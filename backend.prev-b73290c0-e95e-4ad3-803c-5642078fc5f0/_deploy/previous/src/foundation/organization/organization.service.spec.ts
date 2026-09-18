import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { OrganizationService } from './organization.service';
import { OrgUnit } from './org-unit.entity';
import { OrgMembership } from './org-membership.entity';

/** Main paths + the tree-walk invariant (descendants/ancestors resolve correctly). */
describe('OrganizationService', () => {
  let service: OrganizationService;
  const units: OrgUnit[] = [];
  const memberships: OrgMembership[] = [];
  let unitSeq = 0;

  const unitRepoMock = {
    findOne: jest.fn(async ({ where }: { where: { id: string } }) => units.find((u) => u.id === where.id) ?? null),
    find: jest.fn(async ({ where }: { where: { parentId: { value: string[] } } }) => {
      const parentIds = where.parentId.value;
      return units.filter((u) => u.parentId && parentIds.includes(u.parentId));
    }),
    create: jest.fn((data: Partial<OrgUnit>) => ({ id: `unit-${++unitSeq}`, ...data }) as OrgUnit),
    save: jest.fn(async (u: OrgUnit) => {
      units.push(u);
      return u;
    }),
  };

  const membershipRepoMock = {
    findOne: jest.fn(
      async ({ where }: { where: { userId: string; orgUnitId: string } }) =>
        memberships.find((m) => m.userId === where.userId && m.orgUnitId === where.orgUnitId) ?? null,
    ),
    find: jest.fn(async ({ where }: { where: { userId?: string; orgUnitId?: string } }) =>
      memberships.filter(
        (m) => (where.userId ? m.userId === where.userId : true) && (where.orgUnitId ? m.orgUnitId === where.orgUnitId : true),
      ),
    ),
    create: jest.fn((data: Partial<OrgMembership>) => ({ id: `mem-${memberships.length + 1}`, ...data }) as OrgMembership),
    save: jest.fn(async (m: OrgMembership) => {
      memberships.push(m);
      return m;
    }),
    delete: jest.fn(async ({ userId, orgUnitId }: Partial<OrgMembership>) => {
      const idx = memberships.findIndex((m) => m.userId === userId && m.orgUnitId === orgUnitId);
      if (idx >= 0) memberships.splice(idx, 1);
    }),
  };

  beforeEach(async () => {
    units.length = 0;
    memberships.length = 0;
    unitSeq = 0;
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        OrganizationService,
        { provide: getRepositoryToken(OrgUnit), useValue: unitRepoMock },
        { provide: getRepositoryToken(OrgMembership), useValue: membershipRepoMock },
      ],
    }).compile();
    service = moduleRef.get(OrganizationService);
  });

  it('creates a root unit and a child unit', async () => {
    const company = await service.createUnit('company', 'Daii HQ');
    const branch = await service.createUnit('branch', 'Cairo Branch', company.id);
    expect(branch.parentId).toBe(company.id);
  });

  it('rejects creating a unit under a nonexistent parent', async () => {
    await expect(service.createUnit('branch', 'Orphan', 'no-such-id')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('resolves descendants across multiple levels', async () => {
    const company = await service.createUnit('company', 'Daii HQ');
    const branch = await service.createUnit('branch', 'Cairo', company.id);
    const team = await service.createUnit('team', 'Sales Team A', branch.id);
    const descendants = await service.getDescendantIds(company.id);
    expect(descendants.sort()).toEqual([branch.id, team.id].sort());
  });

  it('resolves ancestors from a leaf back to the root', async () => {
    const company = await service.createUnit('company', 'Daii HQ');
    const branch = await service.createUnit('branch', 'Cairo', company.id);
    const team = await service.createUnit('team', 'Sales Team A', branch.id);
    const ancestors = await service.getAncestorIds(team.id);
    expect(ancestors).toEqual([branch.id, company.id]);
  });

  it('assigns and resolves membership, idempotently', async () => {
    const company = await service.createUnit('company', 'Daii HQ');
    await service.assignMember('user-1', company.id);
    await service.assignMember('user-1', company.id);
    expect(await service.getUnitIdsForUser('user-1')).toEqual([company.id]);
    expect(await service.getMemberIds(company.id)).toEqual(['user-1']);
  });
});
