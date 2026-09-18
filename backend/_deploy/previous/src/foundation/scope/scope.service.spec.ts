import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { ScopeService } from './scope.service';
import { ScopeAssignment } from './scope-assignment.entity';
import { AuthorizationService } from '../authorization/authorization.service';

/**
 * Security-critical invariants per CTO Execution Policy §5: deny-by-default,
 * scope filtering never leaks unassigned IDs, 404-not-403 anti-enumeration,
 * and the admin unrestricted-scope override.
 */
describe('ScopeService', () => {
  let service: ScopeService;
  const rows: ScopeAssignment[] = [];

  const assignmentRepoMock = {
    findOne: jest.fn(
      async ({ where }: { where: { userId: string; resourceType: string; resourceId: string } }) =>
        rows.find(
          (r) => r.userId === where.userId && r.resourceType === where.resourceType && r.resourceId === where.resourceId,
        ) ?? null,
    ),
    find: jest.fn(async ({ where }: { where: { userId: string; resourceType: string } }) =>
      rows.filter((r) => r.userId === where.userId && r.resourceType === where.resourceType),
    ),
    create: jest.fn((data: Partial<ScopeAssignment>) => ({ id: `sa-${rows.length + 1}`, ...data }) as ScopeAssignment),
    save: jest.fn(async (a: ScopeAssignment) => {
      rows.push(a);
      return a;
    }),
    delete: jest.fn(async ({ userId, resourceType, resourceId }: Partial<ScopeAssignment>) => {
      const idx = rows.findIndex(
        (r) => r.userId === userId && r.resourceType === resourceType && r.resourceId === resourceId,
      );
      if (idx >= 0) rows.splice(idx, 1);
    }),
    count: jest.fn(async () => 0),
  };

  const authorizationMock = {
    getRoleKeysForUser: jest.fn(async (userId: string) => (userId === 'admin-user' ? ['admin'] : ['sales_rep'])),
  };

  beforeEach(async () => {
    rows.length = 0;
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        ScopeService,
        { provide: getRepositoryToken(ScopeAssignment), useValue: assignmentRepoMock },
        { provide: AuthorizationService, useValue: authorizationMock },
      ],
    }).compile();
    service = moduleRef.get(ScopeService);
  });

  it('denies access to an unassigned resource with 404 (never 403)', async () => {
    await expect(service.assertAccess('rep-1', 'customer', 'cust-99')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('allows access once assigned', async () => {
    await service.assign('rep-1', 'customer', 'cust-1');
    await expect(service.assertAccess('rep-1', 'customer', 'cust-1')).resolves.toBeUndefined();
  });

  it('filterAllowed never returns an ID the user is not scoped to', async () => {
    await service.assign('rep-1', 'customer', 'cust-1');
    const filtered = await service.filterAllowed('rep-1', 'customer', ['cust-1', 'cust-2', 'cust-3']);
    expect(filtered).toEqual(['cust-1']);
  });

  it('gives admin unrestricted scope without any explicit assignment', async () => {
    const filtered = await service.filterAllowed('admin-user', 'customer', ['cust-1', 'cust-2']);
    expect(filtered).toEqual(['cust-1', 'cust-2']);
    await expect(service.assertAccess('admin-user', 'customer', 'anything')).resolves.toBeUndefined();
  });

  it('is idempotent when assigning the same resource twice', async () => {
    await service.assign('rep-1', 'customer', 'cust-1');
    await service.assign('rep-1', 'customer', 'cust-1');
    expect(rows.length).toBe(1);
  });

  it('unassign removes access', async () => {
    await service.assign('rep-1', 'customer', 'cust-1');
    await service.unassign('rep-1', 'customer', 'cust-1');
    await expect(service.assertAccess('rep-1', 'customer', 'cust-1')).rejects.toBeInstanceOf(NotFoundException);
  });
});
