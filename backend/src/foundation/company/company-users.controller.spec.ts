/* eslint-disable @typescript-eslint/no-unsafe-function-type -- this spec inspects NestJS controller classes and handler functions generically through reflection metadata */
import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { PERMISSION_METADATA_KEY, RequiredPermission } from '../permission/require-permission.decorator';
import { CompanyUsersController } from './company-users.controller';
import { CompanyInvitationsPublicController } from './company-invitations-public.controller';
import { InstallationMembershipController } from './installation-membership.controller';
import { COMPANY_MEMBERS_MANAGE_NODE } from './company-role-seeding';
import { CompanyRolesController } from './company-roles.controller';
import { COMPANY_ROLES_MANAGE_NODE } from '../permission/company-nodes';

/**
 * F2 wiring guard (the class-level metadata incident documented in `permission.guard.ts` is exactly the kind of regression this prevents):
 *  - every Company Users route is gated by the members-manage node; reads are read-only, every write is editable;
 *  - the Company plane exposes NO route that attaches an existing identity to a Company by a raw user id (the removed pre-F2 `POST /memberships`);
 *  - the public invitation routes exist only under `/invitations` and the only authenticated one carries the JWT guard.
 */
describe('F2 controller wiring', () => {
  const reflector = new Reflector();
  const routes = (ctrl: Function) =>
    Object.getOwnPropertyNames(ctrl.prototype)
      .filter((n) => n !== 'constructor' && typeof (ctrl.prototype as Record<string, unknown>)[n] === 'function' && Reflect.getMetadata(PATH_METADATA, (ctrl.prototype as Record<string, unknown>)[n] as object) !== undefined)
      .map((n) => {
        const handler = (ctrl.prototype as Record<string, unknown>)[n] as object;
        const required = reflector.getAllAndOverride<RequiredPermission>(PERMISSION_METADATA_KEY, [handler as Function, ctrl]);
        return { name: n, method: RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler)], path: Reflect.getMetadata(PATH_METADATA, handler) as string, required };
      });

  it('every /company/users route requires core.company.members.manage; GET = read-only, POST/PUT/PATCH/DELETE = editable', () => {
    const all = routes(CompanyUsersController);
    expect(Reflect.getMetadata(PATH_METADATA, CompanyUsersController)).toBe('company/users');
    expect(all.length).toBeGreaterThanOrEqual(8);
    for (const r of all) {
      expect(r.required?.nodeKey).toBe(COMPANY_MEMBERS_MANAGE_NODE);
      expect(r.required?.access).toBe(r.method === 'GET' ? 'read-only' : 'editable');
    }
  });

  it('there is no Company-plane route that grants membership by a client-supplied user id (no POST at the controller root, no :companyId param)', () => {
    const all = routes(CompanyUsersController);
    expect(all.some((r) => r.method === 'POST' && (r.path === '/' || r.path === ''))).toBe(false);
    expect(all.some((r) => /companyId/i.test(r.path))).toBe(false);
    expect(all.filter((r) => r.method === 'POST').map((r) => r.path)).toEqual(['invitations']);
  });

  it('public invitation routes: preview (GET) and register (POST) are token-only; accept (POST) is JWT-guarded', () => {
    const all = routes(CompanyInvitationsPublicController);
    expect(Reflect.getMetadata(PATH_METADATA, CompanyInvitationsPublicController)).toBe('invitations');
    expect(all.map((r) => `${r.method} ${r.path}`).sort()).toEqual(['GET preview', 'POST accept', 'POST register']);
    const guards = (name: string) => Reflect.getMetadata('__guards__', (CompanyInvitationsPublicController.prototype as unknown as Record<string, object>)[name]) ?? [];
    expect(guards('accept').length).toBe(1);
    expect(guards('preview').length).toBe(0);
    expect(guards('register').length).toBe(0);
  });

  it('the platform plane keeps its explicit installation route (admin-only, :companyId by design) for support / bootstrap', () => {
    expect(Reflect.getMetadata(PATH_METADATA, InstallationMembershipController)).toBe('installation/companies/:companyId/memberships');
  });

  it('F3: every /company/roles route requires core.company.roles.manage; GET = read-only, every write = editable; static routes precede :roleId', () => {
    const all = routes(CompanyRolesController);
    expect(Reflect.getMetadata(PATH_METADATA, CompanyRolesController)).toBe('company/roles');
    expect(all.length).toBeGreaterThanOrEqual(12);
    for (const r of all) {
      expect(r.required?.nodeKey).toBe(COMPANY_ROLES_MANAGE_NODE);
      expect(r.required?.access).toBe(r.method === 'GET' ? 'read-only' : 'editable');
    }
    expect(all.some((r) => /companyId/i.test(r.path))).toBe(false);
    const order = Object.getOwnPropertyNames(CompanyRolesController.prototype);
    expect(order.indexOf('catalog')).toBeLessThan(order.indexOf('detail')); // GET /catalog must not be captured by GET /:roleId
    expect(order.indexOf('templates')).toBeLessThan(order.indexOf('detail'));
    expect(order.indexOf('fromTemplate')).toBeLessThan(order.indexOf('clone'));
  });
});
