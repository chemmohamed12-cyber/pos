jest.mock('./membership-role-provisioning', () => ({
  provisionUserRoleForMembership: jest.fn(),
  deprovisionUserRoleForMembership: jest.fn(),
}));

import { NotFoundException } from '@nestjs/common';
import { CompanyMembershipProvisioningService, LastAdminError } from './company-membership-provisioning.service';
import { MembershipService } from './membership.service';
import { CompanyConnectionManagerService } from '../database-registry/company-connection-manager.service';
import { MembershipOperationService } from './membership-operation.service';
import { UsersService } from '../identity/users.service';
import { AuditService } from '../audit/audit.service';
import { Membership } from './membership.entity';
import { MembershipOperation } from './membership-operation.entity';
import { provisionUserRoleForMembership, deprovisionUserRoleForMembership } from './membership-role-provisioning';

/**
 * Multi-Company Membership HTTP Management + Area 20 (2026-09-24,
 * D1/D4/D5/D6/D9). The Company-DB provisioning MECHANICS are already
 * proven in `membership-role-provisioning.spec.ts` — this file tests only
 * the orchestration this service adds: user existence (D1), the
 * last-Administrator invariant (D9), durable operation tracking (D5),
 * audit (D6), and role-change as its own primitive (D4).
 */
describe('CompanyMembershipProvisioningService — Multi-Company D1/D4/D5/D6/D9 (2026-09-24)', () => {
  let service: CompanyMembershipProvisioningService;
  const membershipsMock = { create: jest.fn(), findByUserAndCompany: jest.fn(), findByCompany: jest.fn(), revoke: jest.fn(), updateRole: jest.fn() };
  const connectionsMock = { getDataSource: jest.fn() };
  const operationsMock = { start: jest.fn(), markApplying: jest.fn(), markCompleted: jest.fn(), markFailed: jest.fn() };
  const usersMock = { findById: jest.fn() };
  const auditMock = { record: jest.fn() };
  const fakeManager = { tag: 'company-a-manager' };
  const fakeDataSource = { tag: 'company-a-datasource', transaction: jest.fn((cb: (manager: unknown) => Promise<unknown>) => cb(fakeManager)) };
  const fakeOperation = { id: 'op-1', correlationId: 'corr-1' } as MembershipOperation;

  beforeEach(() => {
    jest.clearAllMocks();
    connectionsMock.getDataSource.mockResolvedValue(fakeDataSource);
    operationsMock.start.mockResolvedValue(fakeOperation);
    usersMock.findById.mockResolvedValue({ id: 'user-1', email: 'a@b.com', status: 'active' });
    service = new CompanyMembershipProvisioningService(
      membershipsMock as unknown as MembershipService,
      connectionsMock as unknown as CompanyConnectionManagerService,
      operationsMock as unknown as MembershipOperationService,
      usersMock as unknown as UsersService,
      auditMock as unknown as AuditService,
    );
  });

  describe('grantMembership — D1, D5, D6', () => {
    it('verifies the User exists BEFORE creating any Membership row', async () => {
      usersMock.findById.mockRejectedValueOnce(new NotFoundException('no such user'));
      await expect(service.grantMembership(null, 'ghost-user', 'company-1', 'accountant')).rejects.toThrow(NotFoundException);
      expect(membershipsMock.create).not.toHaveBeenCalled();
    });

    it('success path: creates Membership, provisions the Company-DB role, marks the operation COMPLETED, records a success audit', async () => {
      const membership = { id: 'm-1', userId: 'user-1', companyId: 'company-1', roleKey: 'accountant' } as Membership;
      membershipsMock.create.mockResolvedValue(membership);

      const result = await service.grantMembership('actor-1', 'user-1', 'company-1', 'accountant');

      expect(result).toBe(membership);
      expect(operationsMock.start).toHaveBeenCalledWith('user-1', 'company-1', 'grant', null, 'accountant');
      expect(operationsMock.markApplying).toHaveBeenCalledWith('op-1');
      expect(provisionUserRoleForMembership).toHaveBeenCalledWith(fakeDataSource, 'user-1', 'accountant');
      expect(operationsMock.markCompleted).toHaveBeenCalledWith('op-1');
      expect(auditMock.record).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: 'actor-1', action: 'company.membership.granted', result: 'success' }));
    });

    it('failure path: Company-DB provisioning failure marks the operation FAILED, records a failure audit, and re-throws', async () => {
      membershipsMock.create.mockResolvedValue({ id: 'm-1', userId: 'user-1', companyId: 'company-1', roleKey: 'accountant' } as Membership);
      (provisionUserRoleForMembership as jest.Mock).mockRejectedValueOnce(new Error('role not seeded'));

      await expect(service.grantMembership('actor-1', 'user-1', 'company-1', 'accountant')).rejects.toThrow('role not seeded');

      expect(operationsMock.markFailed).toHaveBeenCalledWith('op-1', 'role not seeded');
      expect(auditMock.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'company.membership.granted', result: 'failure' }));
    });
  });

  describe('revokeMembership — D9, D5, D6', () => {
    it('is a no-op when there is no Membership to revoke', async () => {
      membershipsMock.findByUserAndCompany.mockResolvedValue(null);
      await service.revokeMembership('actor-1', 'user-1', 'company-1');
      expect(membershipsMock.revoke).not.toHaveBeenCalled();
    });

    it('D9: rejects revoking the last admin — no Platform-DB or Company-DB write occurs', async () => {
      membershipsMock.findByUserAndCompany.mockResolvedValue({ id: 'm-1', userId: 'user-1', companyId: 'company-1', roleKey: 'admin' } as Membership);
      membershipsMock.findByCompany.mockResolvedValue([{ userId: 'user-1', roleKey: 'admin' }]);

      await expect(service.revokeMembership('actor-1', 'user-1', 'company-1')).rejects.toThrow(LastAdminError);

      expect(membershipsMock.revoke).not.toHaveBeenCalled();
      expect(deprovisionUserRoleForMembership).not.toHaveBeenCalled();
    });

    it('allows revoking an admin when another admin remains', async () => {
      membershipsMock.findByUserAndCompany.mockResolvedValue({ id: 'm-1', userId: 'user-1', companyId: 'company-1', roleKey: 'admin' } as Membership);
      membershipsMock.findByCompany.mockResolvedValue([
        { userId: 'user-1', roleKey: 'admin' },
        { userId: 'user-2', roleKey: 'admin' },
      ]);

      await service.revokeMembership('actor-1', 'user-1', 'company-1');

      expect(membershipsMock.revoke).toHaveBeenCalledWith('user-1', 'company-1');
      expect(operationsMock.markCompleted).toHaveBeenCalledWith('op-1');
    });

    it('does NOT re-throw when the Company-DB deprovision step fails — access is already revoked on the Platform side', async () => {
      membershipsMock.findByUserAndCompany.mockResolvedValue({ id: 'm-1', userId: 'user-1', companyId: 'company-1', roleKey: 'accountant' } as Membership);
      (deprovisionUserRoleForMembership as jest.Mock).mockRejectedValueOnce(new Error('company db unreachable'));

      await expect(service.revokeMembership('actor-1', 'user-1', 'company-1')).resolves.toBeUndefined();

      expect(membershipsMock.revoke).toHaveBeenCalledWith('user-1', 'company-1'); // Platform-DB write still happened
      expect(operationsMock.markFailed).toHaveBeenCalledWith('op-1', 'company db unreachable');
      expect(auditMock.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'company.membership.revoked', result: 'failure' }));
    });
  });

  describe('changeMembershipRole — D4, D9, D5, D6', () => {
    it('throws NotFoundException when there is no existing Membership', async () => {
      membershipsMock.findByUserAndCompany.mockResolvedValue(null);
      await expect(service.changeMembershipRole('actor-1', 'user-1', 'company-1', 'admin')).rejects.toThrow(NotFoundException);
    });

    it('is an idempotent no-op when the new role equals the current one', async () => {
      const membership = { id: 'm-1', userId: 'user-1', companyId: 'company-1', roleKey: 'accountant' } as Membership;
      membershipsMock.findByUserAndCompany.mockResolvedValue(membership);

      const result = await service.changeMembershipRole('actor-1', 'user-1', 'company-1', 'accountant');

      expect(result).toBe(membership);
      expect(operationsMock.start).not.toHaveBeenCalled();
      expect(membershipsMock.updateRole).not.toHaveBeenCalled();
    });

    it('D9: rejects changing the last admin away from admin', async () => {
      membershipsMock.findByUserAndCompany.mockResolvedValue({ id: 'm-1', userId: 'user-1', companyId: 'company-1', roleKey: 'admin' } as Membership);
      membershipsMock.findByCompany.mockResolvedValue([{ userId: 'user-1', roleKey: 'admin' }]);

      await expect(service.changeMembershipRole('actor-1', 'user-1', 'company-1', 'accountant')).rejects.toThrow(LastAdminError);
      expect(membershipsMock.updateRole).not.toHaveBeenCalled();
    });

    it('never composes revoke+grant — calls deprovision(old) then provision(new) as one operation, both against the same DataSource', async () => {
      membershipsMock.findByUserAndCompany.mockResolvedValue({ id: 'm-1', userId: 'user-1', companyId: 'company-1', roleKey: 'accountant' } as Membership);
      membershipsMock.updateRole.mockResolvedValue({ id: 'm-1', userId: 'user-1', companyId: 'company-1', roleKey: 'hr.manager' } as Membership);

      const result = await service.changeMembershipRole('actor-1', 'user-1', 'company-1', 'hr.manager');

      expect(operationsMock.start).toHaveBeenCalledWith('user-1', 'company-1', 'role_change', 'accountant', 'hr.manager');
      expect(deprovisionUserRoleForMembership).toHaveBeenCalledWith(fakeManager, 'user-1', 'accountant');
      expect(provisionUserRoleForMembership).toHaveBeenCalledWith(fakeManager, 'user-1', 'hr.manager');
      expect(operationsMock.markCompleted).toHaveBeenCalledWith('op-1');
      expect(result.roleKey).toBe('hr.manager');
    });

    it('failure path re-throws and marks the operation FAILED', async () => {
      membershipsMock.findByUserAndCompany.mockResolvedValue({ id: 'm-1', userId: 'user-1', companyId: 'company-1', roleKey: 'accountant' } as Membership);
      membershipsMock.updateRole.mockResolvedValue({ id: 'm-1', userId: 'user-1', companyId: 'company-1', roleKey: 'hr.manager' } as Membership);
      (provisionUserRoleForMembership as jest.Mock).mockRejectedValueOnce(new Error('role not seeded'));

      await expect(service.changeMembershipRole('actor-1', 'user-1', 'company-1', 'hr.manager')).rejects.toThrow('role not seeded');
      expect(operationsMock.markFailed).toHaveBeenCalledWith('op-1', 'role not seeded');
    });
  });

  describe('D9 controlled admin transfer (Track A closure gate, point 2 — 2026-09-24)', () => {
    it('A (last admin) transfers adminship to B, then is demoted — succeeds, and the Company is never left with zero admins', async () => {
      const companyId = 'company-1';
      const memberships = new Map<string, { id: string; userId: string; companyId: string; roleKey: string }>([
        ['A', { id: 'm-A', userId: 'A', companyId, roleKey: 'admin' }],
      ]);

      membershipsMock.findByCompany.mockImplementation(async () => [...memberships.values()]);
      membershipsMock.findByUserAndCompany.mockImplementation(async (userId: string) => memberships.get(userId) ?? null);
      membershipsMock.create.mockImplementation(async (data: { userId: string; companyId: string; roleKey: string }) => {
        const row = { id: `m-${data.userId}`, ...data };
        memberships.set(data.userId, row);
        return row;
      });
      membershipsMock.updateRole.mockImplementation(async (userId: string, _companyId: string, roleKey: string) => {
        const updated = { ...memberships.get(userId)!, roleKey };
        memberships.set(userId, updated);
        return updated;
      });

      // Step 1: grant B admin — Company now has TWO admins.
      await service.grantMembership('actor', 'B', companyId, 'admin');
      expect([...memberships.values()].filter((m) => m.roleKey === 'admin')).toHaveLength(2);

      // Step 2: demote A — must succeed now that B covers the invariant.
      await expect(service.changeMembershipRole('actor', 'A', companyId, 'accountant')).resolves.toBeDefined();

      const admins = [...memberships.values()].filter((m) => m.roleKey === 'admin');
      expect(admins).toEqual([expect.objectContaining({ userId: 'B', roleKey: 'admin' })]);
      expect(admins.length).toBeGreaterThanOrEqual(1); // at every observed point after the sequence — never zero
    });

    it('demoting A BEFORE granting B admin is still rejected — D9 is not bypassable by reordering the same two calls', async () => {
      const companyId = 'company-1';
      membershipsMock.findByUserAndCompany.mockResolvedValue({ id: 'm-A', userId: 'A', companyId, roleKey: 'admin' });
      membershipsMock.findByCompany.mockResolvedValue([{ userId: 'A', roleKey: 'admin' }]); // B not yet granted

      await expect(service.changeMembershipRole('actor', 'A', companyId, 'accountant')).rejects.toThrow(LastAdminError);
      expect(membershipsMock.updateRole).not.toHaveBeenCalled();
    });
  });
});
