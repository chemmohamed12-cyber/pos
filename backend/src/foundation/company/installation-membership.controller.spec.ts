import { UnauthorizedException } from '@nestjs/common';
import { InstallationMembershipController } from './installation-membership.controller';
import { CompanyMembershipProvisioningService } from './company-membership-provisioning.service';
import { MembershipService } from './membership.service';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { PLATFORM_PERMISSION_KEY, PlatformGuard } from '../platform/platform.guard';
import { AuthenticatedRequest } from '../authentication/jwt-auth.guard';

describe('InstallationMembershipController — Multi-Company Membership HTTP Management (D2/D3, 2026-09-24)', () => {
  const provisioningMock = { grantMembership: jest.fn(), revokeMembership: jest.fn(), changeMembershipRole: jest.fn() };
  const membershipsMock = { findByCompany: jest.fn() };
  let controller: InstallationMembershipController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new InstallationMembershipController(
      provisioningMock as unknown as CompanyMembershipProvisioningService,
      membershipsMock as unknown as MembershipService,
    );
  });

  it('F4: gated by the PLATFORM guard (control-plane authority only, never CompanyContextGuard) — each route declares its platform.membership.* node', () => {
    expect(Reflect.getMetadata('__guards__', InstallationMembershipController)).toContain(PlatformGuard);
    const node = (name: string) => Reflect.getMetadata(PLATFORM_PERMISSION_KEY, (InstallationMembershipController.prototype as unknown as Record<string, object>)[name]);
    expect(node('list')).toMatchObject({ node: 'platform.membership.view', access: 'read-only' });
    expect(node('grant')).toMatchObject({ node: 'platform.membership.grant', access: 'editable' });
    expect(node('revoke')).toMatchObject({ node: 'platform.membership.revoke', access: 'editable' });
    expect(node('changeRole')).toMatchObject({ node: 'platform.membership.update', access: 'editable' });
    void PATH_METADATA;
    void METHOD_METADATA;
  });

  const fakeRequest = { user: { id: 'installation-admin-1', email: 'admin@platform.test' } } as unknown as AuthenticatedRequest;

  it('grant: takes companyId explicitly from the route, trusted because the caller is a platform admin', async () => {
    provisioningMock.grantMembership.mockResolvedValue({ id: 'm-1' });
    await controller.grant(fakeRequest, 'company-B', { userId: 'user-2', roleKey: 'admin' });
    expect(provisioningMock.grantMembership).toHaveBeenCalledWith('installation-admin-1', 'user-2', 'company-B', 'admin');
  });

  it('revoke: delegates with the explicit companyId route param', async () => {
    await controller.revoke(fakeRequest, 'company-B', 'user-2');
    expect(provisioningMock.revokeMembership).toHaveBeenCalledWith('installation-admin-1', 'user-2', 'company-B');
  });

  it('changeRole: delegates to the dedicated D4 primitive', async () => {
    provisioningMock.changeMembershipRole.mockResolvedValue({ id: 'm-1', roleKey: 'hr.manager' });
    await controller.changeRole(fakeRequest, 'company-B', 'user-2', { roleKey: 'hr.manager' });
    expect(provisioningMock.changeMembershipRole).toHaveBeenCalledWith('installation-admin-1', 'user-2', 'company-B', 'hr.manager');
  });

  it('list: reads the explicit route companyId', async () => {
    membershipsMock.findByCompany.mockResolvedValue([]);
    await controller.list('company-B');
    expect(membershipsMock.findByCompany).toHaveBeenCalledWith('company-B');
  });

  it('rejects mutating actions when there is no authenticated user on the request', async () => {
    const anonymous = {} as AuthenticatedRequest;
    await expect(controller.grant(anonymous, 'company-B', { userId: 'user-2', roleKey: 'admin' })).rejects.toThrow(UnauthorizedException);
    await expect(controller.revoke(anonymous, 'company-B', 'user-2')).rejects.toThrow(UnauthorizedException);
    await expect(controller.changeRole(anonymous, 'company-B', 'user-2', { roleKey: 'admin' })).rejects.toThrow(UnauthorizedException);
  });
});
