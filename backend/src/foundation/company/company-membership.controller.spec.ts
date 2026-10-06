import { UnauthorizedException } from '@nestjs/common';
import { CompanyMembershipController } from './company-membership.controller';
import { CompanyMembershipProvisioningService } from './company-membership-provisioning.service';
import { MembershipService } from './membership.service';
import { PERMISSION_METADATA_KEY } from '../permission/require-permission.decorator';
import { COMPANY_MEMBERS_MANAGE_NODE } from './company-role-seeding';
import { CompanyScopedRequest } from './company-context.guard';

describe('CompanyMembershipController — Multi-Company Membership HTTP Management (D2, 2026-09-24)', () => {
  const provisioningMock = { grantMembership: jest.fn(), revokeMembership: jest.fn(), changeMembershipRole: jest.fn() };
  const membershipsMock = { findByCompany: jest.fn() };
  let controller: CompanyMembershipController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new CompanyMembershipController(
      provisioningMock as unknown as CompanyMembershipProvisioningService,
      membershipsMock as unknown as MembershipService,
    );
  });

  it('requires editable access on the exact core.company.members.manage node — the §3.1 verified node, never a wildcard', () => {
    const metadata = Reflect.getMetadata(PERMISSION_METADATA_KEY, CompanyMembershipController);
    expect(metadata).toEqual({ nodeKey: COMPANY_MEMBERS_MANAGE_NODE, access: 'editable' });
  });

  function fakeRequest(companyId = 'company-A'): CompanyScopedRequest {
    return {
      user: { id: 'actor-1', email: 'a@b.com', companyId },
      companyContext: { companyId, dataSource: {} as never },
    } as unknown as CompanyScopedRequest;
  }

  it('grant: derives the Company EXCLUSIVELY from req.companyContext, never from any client-suppliable field', async () => {
    provisioningMock.grantMembership.mockResolvedValue({ id: 'm-1' });
    await controller.grant(fakeRequest('company-A'), { userId: 'user-2', roleKey: 'accountant' });
    expect(provisioningMock.grantMembership).toHaveBeenCalledWith('actor-1', 'user-2', 'company-A', 'accountant');
  });

  it('revoke: delegates with the request-derived companyId and the actor', async () => {
    await controller.revoke(fakeRequest('company-A'), 'user-2');
    expect(provisioningMock.revokeMembership).toHaveBeenCalledWith('actor-1', 'user-2', 'company-A');
  });

  it('changeRole: delegates to the dedicated primitive (D4), never revoke+grant', async () => {
    provisioningMock.changeMembershipRole.mockResolvedValue({ id: 'm-1', roleKey: 'hr.manager' });
    await controller.changeRole(fakeRequest('company-A'), 'user-2', { roleKey: 'hr.manager' });
    expect(provisioningMock.changeMembershipRole).toHaveBeenCalledWith('actor-1', 'user-2', 'company-A', 'hr.manager');
    expect(provisioningMock.revokeMembership).not.toHaveBeenCalled();
    expect(provisioningMock.grantMembership).not.toHaveBeenCalled();
  });

  it('list: reads the Company scope from the request, not a param', async () => {
    membershipsMock.findByCompany.mockResolvedValue([]);
    await controller.list(fakeRequest('company-A'));
    expect(membershipsMock.findByCompany).toHaveBeenCalledWith('company-A');
  });

  it('rejects every action when companyContext is missing (CompanyContextGuard did not run/pass) rather than falling back to any default', async () => {
    const request = { user: { id: 'actor-1', email: 'a@b.com' } } as unknown as CompanyScopedRequest;
    await expect(controller.grant(request, { userId: 'user-2', roleKey: 'accountant' })).rejects.toThrow(UnauthorizedException);
    await expect(controller.revoke(request, 'user-2')).rejects.toThrow(UnauthorizedException);
    await expect(controller.changeRole(request, 'user-2', { roleKey: 'accountant' })).rejects.toThrow(UnauthorizedException);
    await expect(controller.list(request)).rejects.toThrow(UnauthorizedException);
  });
});
