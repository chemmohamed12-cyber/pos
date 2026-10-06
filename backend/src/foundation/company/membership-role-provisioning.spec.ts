import { provisionUserRoleForMembership, deprovisionUserRoleForMembership, RoleNotSeededError } from './membership-role-provisioning';
import { Role } from '../authorization/role.entity';
import { UserRole } from '../authorization/user-role.entity';

function fakeCompanyDataSource() {
  const roles = new Map<string, Role>([['role-1', { id: 'role-1', key: 'accountant', createdAt: new Date() } as Role]]);
  const userRoles = new Map<string, UserRole>();
  const roleRepo = {
    findOne: jest.fn(async ({ where }: { where: { key: string } }) => [...roles.values()].find((r) => r.key === where.key) ?? null),
  };
  const userRoleRepo = {
    findOne: jest.fn(async ({ where }: { where: { userId: string; roleId: string } }) =>
      [...userRoles.values()].find((ur) => ur.userId === where.userId && ur.roleId === where.roleId) ?? null,
    ),
    create: jest.fn((data: Partial<UserRole>) => ({ id: `ur-${userRoles.size + 1}`, assignedAt: new Date(), ...data }) as UserRole),
    save: jest.fn(async (row: UserRole) => {
      userRoles.set(row.id, row);
      return row;
    }),
    delete: jest.fn(async ({ userId, roleId }: { userId: string; roleId: string }) => {
      for (const [id, ur] of userRoles) {
        if (ur.userId === userId && ur.roleId === roleId) userRoles.delete(id);
      }
    }),
  };
  const dataSource = {
    getRepository: jest.fn((entity: unknown) => (entity === Role ? roleRepo : userRoleRepo)),
  };
  return { dataSource, userRoles };
}

describe('provisionUserRoleForMembership / deprovisionUserRoleForMembership — Multi-Company Area 6/5 (2026-09-23)', () => {
  it('grants the UserRole in the Company database when the role exists there', async () => {
    const { dataSource, userRoles } = fakeCompanyDataSource();
    await provisionUserRoleForMembership(dataSource as never, 'user-1', 'accountant');
    expect([...userRoles.values()]).toHaveLength(1);
    expect(userRoles.values().next().value).toMatchObject({ userId: 'user-1', roleId: 'role-1' });
  });

  it('is idempotent — granting the same role twice does not duplicate the UserRole row', async () => {
    const { dataSource, userRoles } = fakeCompanyDataSource();
    await provisionUserRoleForMembership(dataSource as never, 'user-1', 'accountant');
    await provisionUserRoleForMembership(dataSource as never, 'user-1', 'accountant');
    expect([...userRoles.values()]).toHaveLength(1);
  });

  it('throws RoleNotSeededError — never silently grants nothing — when the role catalog was not seeded for this Company', async () => {
    const { dataSource } = fakeCompanyDataSource();
    await expect(provisionUserRoleForMembership(dataSource as never, 'user-1', 'no-such-role')).rejects.toThrow(RoleNotSeededError);
  });

  it('deprovision removes the Company-DB UserRole grant', async () => {
    const { dataSource, userRoles } = fakeCompanyDataSource();
    await provisionUserRoleForMembership(dataSource as never, 'user-1', 'accountant');
    expect([...userRoles.values()]).toHaveLength(1);
    await deprovisionUserRoleForMembership(dataSource as never, 'user-1', 'accountant');
    expect([...userRoles.values()]).toHaveLength(0);
  });

  it('deprovision of a never-granted role is a safe no-op', async () => {
    const { dataSource } = fakeCompanyDataSource();
    await expect(deprovisionUserRoleForMembership(dataSource as never, 'user-1', 'accountant')).resolves.toBeUndefined();
  });
});
