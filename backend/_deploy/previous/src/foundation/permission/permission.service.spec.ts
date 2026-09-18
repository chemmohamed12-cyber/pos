import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { PermissionService } from './permission.service';
import { RolePermission } from './role-permission.entity';
import { AuthorizationService } from '../authorization/authorization.service';

/**
 * The invariants that matter per CTO Execution Policy §5: deny-by-default,
 * ancestor-walk resolution (most-specific wins), and additive-across-roles
 * (most-permissive union).
 */
describe('PermissionService', () => {
  let service: PermissionService;
  const rows: RolePermission[] = [
    { id: '1', roleId: 'role-rep', nodeKey: 'sales_orders', access: 'read-only', createdAt: new Date() },
    { id: '2', roleId: 'role-supervisor', nodeKey: 'sales_orders.approve', access: 'editable', createdAt: new Date() },
  ];

  const rolePermissionRepoMock = {
    find: jest.fn(async ({ where }: { where: { roleId: { value: string[] }; nodeKey: { value: string[] } } }) => {
      const roleIds = where.roleId.value;
      const nodeKeys = where.nodeKey.value;
      return rows.filter((r) => roleIds.includes(r.roleId) && nodeKeys.includes(r.nodeKey));
    }),
  };

  const authorizationMock = {
    getRoleKeysForUser: jest.fn(async (userId: string) => {
      if (userId === 'rep-only') return ['sales_rep'];
      if (userId === 'supervisor') return ['sales_supervisor'];
      if (userId === 'both') return ['sales_rep', 'sales_supervisor'];
      return [];
    }),
    getRoleIdsForKeys: jest.fn(async (keys: string[]) => {
      const map: Record<string, string> = { sales_rep: 'role-rep', sales_supervisor: 'role-supervisor' };
      return keys.map((k) => map[k]).filter(Boolean);
    }),
  };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        PermissionService,
        { provide: getRepositoryToken(RolePermission), useValue: rolePermissionRepoMock },
        { provide: AuthorizationService, useValue: authorizationMock },
      ],
    }).compile();
    service = moduleRef.get(PermissionService);
  });

  it('denies by default when nothing is configured for the user\'s roles', async () => {
    expect(await service.resolve('rep-only', 'inventory.warehouses')).toBe('hidden');
  });

  it('denies by default for a user with no roles at all', async () => {
    expect(await service.resolve('nobody', 'sales_orders')).toBe('hidden');
  });

  it('resolves the exact node for a role that has it configured', async () => {
    expect(await service.resolve('rep-only', 'sales_orders')).toBe('read-only');
  });

  it('walks up to a parent node when the child is not explicitly configured', async () => {
    // sales_rep only has "sales_orders" (read-only) configured, not "sales_orders.approve"
    expect(await service.resolve('rep-only', 'sales_orders.approve')).toBe('read-only');
  });

  it('prefers the more specific child node over the parent for the role that has it', async () => {
    expect(await service.resolve('supervisor', 'sales_orders.approve')).toBe('editable');
  });

  it('takes the most permissive result across a user\'s multiple roles', async () => {
    // "both" holds sales_rep (read-only on sales_orders) and sales_supervisor (editable on sales_orders.approve)
    expect(await service.resolve('both', 'sales_orders.approve')).toBe('editable');
  });

  it('hasAtLeast correctly gates on the required access level', async () => {
    expect(await service.hasAtLeast('rep-only', 'sales_orders', 'editable')).toBe(false);
    expect(await service.hasAtLeast('rep-only', 'sales_orders', 'read-only')).toBe(true);
  });
});
