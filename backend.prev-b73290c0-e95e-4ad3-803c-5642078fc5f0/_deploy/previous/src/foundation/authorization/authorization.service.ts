import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Role } from './role.entity';
import { UserRole } from './user-role.entity';

/**
 * Authorization — Stage 2 build-order item 7.
 * Daii/architecture/DAII_PLATFORM_FOUNDATION_CONTRACT.md §3.
 *
 * Role-membership resolution ONLY (the WHAT-role-does-this-user-hold
 * question). Fine-grained module/feature/action permission resolution
 * is Permission Engine's job (item 8, not built yet) — this service
 * deliberately does not answer "may this role do X."
 */
@Injectable()
export class AuthorizationService {
  constructor(
    @InjectRepository(Role) private readonly roles: Repository<Role>,
    @InjectRepository(UserRole) private readonly userRoles: Repository<UserRole>,
  ) {}

  async assignRole(userId: string, roleKey: string): Promise<void> {
    const role = await this.roles.findOne({ where: { key: roleKey } });
    if (!role) {
      throw new NotFoundException(`Role "${roleKey}" does not exist.`);
    }
    const existing = await this.userRoles.findOne({ where: { userId, roleId: role.id } });
    if (existing) return; // idempotent
    await this.userRoles.save(this.userRoles.create({ userId, roleId: role.id }));
  }

  async revokeRole(userId: string, roleKey: string): Promise<void> {
    const role = await this.roles.findOne({ where: { key: roleKey } });
    if (!role) return;
    await this.userRoles.delete({ userId, roleId: role.id });
  }

  async getRoleKeysForUser(userId: string): Promise<string[]> {
    const assignments = await this.userRoles.find({ where: { userId } });
    if (assignments.length === 0) return [];
    const roleIds = assignments.map((a) => a.roleId);
    const roles = await this.roles.find({ where: { id: In(roleIds) } });
    return roles.map((r) => r.key);
  }

  async hasRole(userId: string, roleKey: string): Promise<boolean> {
    const keys = await this.getRoleKeysForUser(userId);
    return keys.includes(roleKey);
  }

  /** Used internally by Permission Engine (item 8) to join role keys back to ids. */
  async getRoleIdsForKeys(roleKeys: string[]): Promise<string[]> {
    if (roleKeys.length === 0) return [];
    const roles = await this.roles.find({ where: { key: In(roleKeys) } });
    return roles.map((r) => r.id);
  }

  /**
   * Reverse of `getRoleKeysForUser` — every user id currently holding a
   * given role (CTO instruction: Sales Order's rep-selector needs "every
   * sales_rep", not the full admin user list `/admin/users` returns).
   */
  async getUserIdsForRole(roleKey: string): Promise<string[]> {
    const role = await this.roles.findOne({ where: { key: roleKey } });
    if (!role) return [];
    const assignments = await this.userRoles.find({ where: { roleId: role.id } });
    return assignments.map((a) => a.userId);
  }
}
