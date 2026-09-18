import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { PermissionAccess, RolePermission } from './role-permission.entity';
import { AuthorizationService } from '../authorization/authorization.service';

const ACCESS_RANK: Record<PermissionAccess, number> = { hidden: 0, 'read-only': 1, editable: 2 };

/** All ancestor keys of a dotted path, most-specific first: "a.b.c" -> ["a.b.c", "a.b", "a"]. */
function ancestorChain(nodeKey: string): string[] {
  const parts = nodeKey.split('.');
  const chain: string[] = [];
  for (let i = parts.length; i > 0; i--) {
    chain.push(parts.slice(0, i).join('.'));
  }
  return chain;
}

/**
 * Permission Engine — Stage 2 build-order item 8.
 * Daii/architecture/DAII_PLATFORM_FOUNDATION_CONTRACT.md §4, ADR-005.
 *
 * Resolution: for each role the user holds, walk from the exact node up
 * through its ancestors and take the first configured access level for
 * that role (most-specific wins per role). Across roles, take the most
 * permissive result (roles are additive capabilities). No configured
 * level anywhere for any role = hidden (deny-by-default).
 */
@Injectable()
export class PermissionService {
  constructor(
    @InjectRepository(RolePermission) private readonly rolePermissions: Repository<RolePermission>,
    private readonly authorization: AuthorizationService,
  ) {}

  async resolve(userId: string, nodeKey: string): Promise<PermissionAccess> {
    const roleKeys = await this.authorization.getRoleKeysForUser(userId);
    if (roleKeys.length === 0) return 'hidden';

    const roleIds = await this.authorization.getRoleIdsForKeys(roleKeys);
    if (roleIds.length === 0) return 'hidden';

    const chain = ancestorChain(nodeKey);
    const rows = await this.rolePermissions.find({
      where: { roleId: In(roleIds), nodeKey: In(chain) },
    });
    if (rows.length === 0) return 'hidden';

    let best: PermissionAccess = 'hidden';
    for (const roleId of roleIds) {
      const rowsForRole = rows.filter((r) => r.roleId === roleId);
      for (const key of chain) {
        const match = rowsForRole.find((r) => r.nodeKey === key);
        if (match) {
          if (ACCESS_RANK[match.access] > ACCESS_RANK[best]) best = match.access;
          break; // most-specific ancestor found for this role, stop walking for it
        }
      }
    }
    return best;
  }

  async hasAtLeast(userId: string, nodeKey: string, required: PermissionAccess): Promise<boolean> {
    const resolved = await this.resolve(userId, nodeKey);
    return ACCESS_RANK[resolved] >= ACCESS_RANK[required];
  }
}
