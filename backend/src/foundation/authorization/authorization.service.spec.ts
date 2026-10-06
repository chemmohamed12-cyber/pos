import { AuthorizationService } from './authorization.service';
import { Role } from './role.entity';
import { UserRole } from './user-role.entity';

/** Multi-Company Area 6 (2026-09-23, Model B decision) — proves `manager?` really routes to a different connection, not a cosmetic parameter. */
const AMBIENT_TOUCHED = 'AMBIENT REPOSITORY TOUCHED — must use the supplied Company manager';

function poisonedRepo() {
  return {
    find: jest.fn(() => {
      throw new Error(AMBIENT_TOUCHED);
    }),
    findOne: jest.fn(() => {
      throw new Error(AMBIENT_TOUCHED);
    }),
  };
}

function fakeCompanyRepos() {
  const roles = new Map<string, Role>([['role-1', { id: 'role-1', key: 'accountant', createdAt: new Date() } as Role]]);
  const userRoles = new Map<string, UserRole>([['ur-1', { id: 'ur-1', userId: 'user-1', roleId: 'role-1', assignedAt: new Date() } as UserRole]]);
  const roleRepo = {
    // Simplified: the fixture has exactly one Role, so `find` just returns it regardless of the
    // `In(...)` FindOperator's internal shape — this test proves WHICH repo/manager is used, not
    // TypeORM's own `In()` query-building, which is exercised for real by the poisoned-ambient case.
    find: jest.fn(async () => [...roles.values()]),
    findOne: jest.fn(async ({ where }: { where: { key: string } }) => [...roles.values()].find((r) => r.key === where.key) ?? null),
  };
  const userRoleRepo = {
    find: jest.fn(async ({ where }: { where: { userId: string } }) => [...userRoles.values()].filter((ur) => ur.userId === where.userId)),
  };
  return { roleRepo, userRoleRepo };
}

describe('AuthorizationService — Multi-Company Area 6 (manager? threading, no ambient fallback)', () => {
  let service: AuthorizationService;
  let manager: { getRepository: jest.Mock };

  beforeEach(() => {
    const { roleRepo, userRoleRepo } = fakeCompanyRepos();
    manager = {
      getRepository: jest.fn((entity: unknown) => (entity === Role ? roleRepo : userRoleRepo)),
    };
    service = new AuthorizationService(poisonedRepo() as never, poisonedRepo() as never);
  });

  it('getRoleKeysForUser routes entirely through the supplied manager, never the ambient (poisoned) repos', async () => {
    const keys = await service.getRoleKeysForUser('user-1', manager as never);
    expect(keys).toEqual(['accountant']);
    expect(manager.getRepository).toHaveBeenCalledWith(UserRole);
    expect(manager.getRepository).toHaveBeenCalledWith(Role);
  });

  it('getRoleKeysForUser without a manager DOES use the ambient repos (and here they are poisoned, so it throws — proving the default path is real, not skipped)', async () => {
    await expect(service.getRoleKeysForUser('user-1')).rejects.toThrow(AMBIENT_TOUCHED);
  });

  it('getRoleIdsForKeys routes through the supplied manager', async () => {
    const ids = await service.getRoleIdsForKeys(['accountant'], manager as never);
    expect(ids).toEqual(['role-1']);
    expect(manager.getRepository).toHaveBeenCalledWith(Role);
  });
});
