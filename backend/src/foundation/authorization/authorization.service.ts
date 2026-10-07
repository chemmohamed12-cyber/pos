import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';
import { Role } from './role.entity';
import { UserRole } from './user-role.entity';
import { loadAuthorizationContext } from './authorization-context.loader';
import { WorkflowAccess } from './workflow-access';

/**
 * Authorization — Stage 2 build-order item 7.
 * Daii/architecture/DAII_PLATFORM_FOUNDATION_CONTRACT.md §3.
 *
 * Role-membership resolution ONLY (the WHAT-role-does-this-user-hold
 * question). Fine-grained module/feature/action permission resolution
 * is Permission Engine's job (item 8, not built yet) — this service
 * deliberately does not answer "may this role do X."
 *
 * Multi-Company Area 6 (2026-09-23, Model B decision): `Role`/`UserRole`
 * ALSO exist as real, physically separate tables inside each Company's
 * own database (seeded by `company-role-seeding.ts` during provisioning —
 * the exact same entity classes, a different connection). `manager?` on
 * `getRoleKeysForUser`/`getRoleIdsForKeys` — the two methods the live
 * authorization decision path (`RolesGuard`, `PermissionService.resolve`)
 * actually calls — lets a validated Company context route the query to
 * THAT Company's own tables instead of the ambient/platform ones. Falls
 * back to the ambient `this.roles`/`this.userRoles` when omitted,
 * unchanged for every route not yet using `CompanyContextGuard`, and for
 * `assignRole`/`revokeRole`/`getUserIdsForRole` without a manager (platform-level
 * role grants — e.g. the bootstrap admin grant, `/admin/*`).
 *
 * Area 21 (2026-10-05, CTO-authorized "Company-level authorization"): the same optional `manager`
 * was added to `assignRole`/`revokeRole`/`getUserIdsForRole`, so a Company-scoped surface (e.g. `sales/reps`)
 * grants and reads roles in THAT Company's own `roles`/`user_roles` — a role such as `sales_rep` is a
 * Company-local designation there. Additive and backward compatible: no manager ⇒ the platform catalog, unchanged.
 */
@Injectable()
export class AuthorizationService {
  constructor(
    @InjectRepository(Role) private readonly roles: Repository<Role>,
    @InjectRepository(UserRole) private readonly userRoles: Repository<UserRole>,
  ) {}

  async assignRole(userId: string, roleKey: string, manager?: EntityManager): Promise<void> {
    const roleRepo = manager ? manager.getRepository(Role) : this.roles;
    const userRoleRepo = manager ? manager.getRepository(UserRole) : this.userRoles;
    const role = await roleRepo.findOne({ where: { key: roleKey } });
    if (!role) {
      throw new NotFoundException(`Role "${roleKey}" does not exist.`);
    }
    const existing = await userRoleRepo.findOne({ where: { userId, roleId: role.id } });
    if (existing) return; // idempotent
    await userRoleRepo.save(userRoleRepo.create({ userId, roleId: role.id }));
  }

  async revokeRole(userId: string, roleKey: string, manager?: EntityManager): Promise<void> {
    const role = await (manager ? manager.getRepository(Role) : this.roles).findOne({ where: { key: roleKey } });
    if (!role) return;
    await (manager ? manager.getRepository(UserRole) : this.userRoles).delete({ userId, roleId: role.id });
  }

  /**
   * F5 — what this user holds (roles + every grant of those roles), answered as WORKFLOW RULES: the single replacement for the `getRoleKeysForUser(...)` +
   * `roles.includes('sales_supervisor')` pattern at the product call sites. One statement (the same one the request-scoped context uses). `manager` routes it to a
   * Company database exactly like the other methods here.
   */
  async workflowAccess(userId: string, manager?: EntityManager): Promise<WorkflowAccess> {
    const runner = manager ?? this.roles.manager;
    return new WorkflowAccess(await loadAuthorizationContext(runner, userId, null));
  }

  async getRoleKeysForUser(userId: string, manager?: EntityManager): Promise<string[]> {
    const userRoleRepo = manager ? manager.getRepository(UserRole) : this.userRoles;
    const roleRepo = manager ? manager.getRepository(Role) : this.roles;
    const assignments = await userRoleRepo.find({ where: { userId } });
    if (assignments.length === 0) return [];
    const roleIds = assignments.map((a) => a.roleId);
    const roles = await roleRepo.find({ where: { id: In(roleIds) } });
    return roles.map((r) => r.key);
  }

  async hasRole(userId: string, roleKey: string, manager?: EntityManager): Promise<boolean> {
    const keys = await this.getRoleKeysForUser(userId, manager);
    return keys.includes(roleKey);
  }

  /** Used internally by Permission Engine (item 8) to join role keys back to ids. `manager?` — see class doc comment. */
  async getRoleIdsForKeys(roleKeys: string[], manager?: EntityManager): Promise<string[]> {
    if (roleKeys.length === 0) return [];
    const roleRepo = manager ? manager.getRepository(Role) : this.roles;
    const roles = await roleRepo.find({ where: { key: In(roleKeys) } });
    return roles.map((r) => r.id);
  }

  /**
   * Reverse of `getRoleKeysForUser` — every user id currently holding a
   * given role (CTO instruction: Sales Order's rep-selector needs "every
   * sales_rep", not the full admin user list `/admin/users` returns).
   */
  async getUserIdsForRole(roleKey: string, manager?: EntityManager): Promise<string[]> {
    const role = await (manager ? manager.getRepository(Role) : this.roles).findOne({ where: { key: roleKey } });
    if (!role) return [];
    const assignments = await (manager ? manager.getRepository(UserRole) : this.userRoles).find({ where: { roleId: role.id } });
    return assignments.map((a) => a.userId);
  }
}
