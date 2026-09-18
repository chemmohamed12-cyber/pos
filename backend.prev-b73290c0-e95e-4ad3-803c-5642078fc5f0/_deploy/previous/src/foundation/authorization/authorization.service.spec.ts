import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { AuthorizationService } from './authorization.service';
import { Role } from './role.entity';
import { UserRole } from './user-role.entity';

/**
 * Main paths per CTO Execution Policy §5: assign, idempotent re-assign,
 * revoke, multi-role resolution, and the one invariant that matters
 * (assigning a non-existent role is rejected, not silently accepted).
 */
describe('AuthorizationService', () => {
  let service: AuthorizationService;
  const roles = [
    { id: 'role-admin', key: 'admin', createdAt: new Date() },
    { id: 'role-rep', key: 'sales_rep', createdAt: new Date() },
  ];
  const assignments: UserRole[] = [];

  const roleRepoMock = {
    findOne: jest.fn(async ({ where }: { where: { key: string } }) => roles.find((r) => r.key === where.key) ?? null),
    find: jest.fn(async ({ where }: { where: { id: { value: string[] } } }) => {
      const ids = where.id.value;
      return roles.filter((r) => ids.includes(r.id));
    }),
  };

  const userRoleRepoMock = {
    findOne: jest.fn(async ({ where }: { where: { userId: string; roleId: string } }) =>
      assignments.find((a) => a.userId === where.userId && a.roleId === where.roleId) ?? null,
    ),
    find: jest.fn(async ({ where }: { where: { userId: string } }) =>
      assignments.filter((a) => a.userId === where.userId),
    ),
    create: jest.fn((data: Partial<UserRole>) => ({ id: `ur-${assignments.length + 1}`, ...data }) as UserRole),
    save: jest.fn(async (a: UserRole) => {
      assignments.push(a);
      return a;
    }),
    delete: jest.fn(async ({ userId, roleId }: { userId: string; roleId: string }) => {
      const idx = assignments.findIndex((a) => a.userId === userId && a.roleId === roleId);
      if (idx >= 0) assignments.splice(idx, 1);
    }),
  };

  beforeEach(async () => {
    assignments.length = 0;
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthorizationService,
        { provide: getRepositoryToken(Role), useValue: roleRepoMock },
        { provide: getRepositoryToken(UserRole), useValue: userRoleRepoMock },
      ],
    }).compile();
    service = moduleRef.get(AuthorizationService);
  });

  it('assigns a role and resolves it back', async () => {
    await service.assignRole('user-1', 'sales_rep');
    expect(await service.hasRole('user-1', 'sales_rep')).toBe(true);
    expect(await service.getRoleKeysForUser('user-1')).toEqual(['sales_rep']);
  });

  it('is idempotent when assigning the same role twice', async () => {
    await service.assignRole('user-1', 'sales_rep');
    await service.assignRole('user-1', 'sales_rep');
    expect(assignments.length).toBe(1);
  });

  it('rejects assigning a role that does not exist', async () => {
    await expect(service.assignRole('user-1', 'nonexistent_role')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('supports multiple roles for one user', async () => {
    await service.assignRole('user-1', 'admin');
    await service.assignRole('user-1', 'sales_rep');
    const keys = await service.getRoleKeysForUser('user-1');
    expect(keys.sort()).toEqual(['admin', 'sales_rep']);
  });

  it('revokes a role', async () => {
    await service.assignRole('user-1', 'sales_rep');
    await service.revokeRole('user-1', 'sales_rep');
    expect(await service.hasRole('user-1', 'sales_rep')).toBe(false);
  });
});
