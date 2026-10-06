import { EntityManager } from 'typeorm';
import { PermissionService } from './permission.service';
import { AuthorizationService } from '../authorization/authorization.service';
import { RolePermission } from './role-permission.entity';

const AMBIENT_TOUCHED = 'AMBIENT REPOSITORY TOUCHED — must use the supplied Company manager';

describe('PermissionService — Multi-Company Area 6 (manager? threading, no ambient fallback)', () => {
  let service: PermissionService;
  const authorizationMock = { getRoleKeysForUser: jest.fn(), getRoleIdsForKeys: jest.fn() };
  const ambientRolePermissionRepo = {
    find: jest.fn(() => {
      throw new Error(AMBIENT_TOUCHED);
    }),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    authorizationMock.getRoleKeysForUser.mockResolvedValue(['accountant']);
    authorizationMock.getRoleIdsForKeys.mockResolvedValue(['role-1']);
    service = new PermissionService(ambientRolePermissionRepo as never, authorizationMock as unknown as AuthorizationService);
  });

  it('resolve forwards the manager into AuthorizationService and routes RolePermission lookup through it, never the ambient repo', async () => {
    const manager = {
      getRepository: jest.fn(() => ({
        find: jest.fn(async () => [{ roleId: 'role-1', nodeKey: 'accounting', access: 'editable' }]),
      })),
    } as unknown as EntityManager;

    const result = await service.resolve('user-1', 'accounting.journal', manager);

    expect(authorizationMock.getRoleKeysForUser).toHaveBeenCalledWith('user-1', manager);
    expect(authorizationMock.getRoleIdsForKeys).toHaveBeenCalledWith(['accountant'], manager);
    expect(manager.getRepository).toHaveBeenCalledWith(RolePermission);
    expect(result).toBe('editable');
  });

  it('resolve without a manager DOES use the ambient repo (poisoned here, so it throws)', async () => {
    await expect(service.resolve('user-1', 'accounting.journal')).rejects.toThrow(AMBIENT_TOUCHED);
  });

  it('hasAtLeast forwards the manager through resolve', async () => {
    const manager = {
      getRepository: jest.fn(() => ({
        find: jest.fn(async () => [{ roleId: 'role-1', nodeKey: 'accounting', access: 'read-only' }]),
      })),
    } as unknown as EntityManager;

    const allowed = await service.hasAtLeast('user-1', 'accounting.journal', 'read-only', manager);
    expect(allowed).toBe(true);
  });
});
