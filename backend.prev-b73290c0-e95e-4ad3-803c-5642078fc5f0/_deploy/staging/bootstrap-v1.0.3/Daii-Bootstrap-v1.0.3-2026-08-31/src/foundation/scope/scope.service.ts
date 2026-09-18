import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ScopeAssignment } from './scope-assignment.entity';
import { AuthorizationService } from '../authorization/authorization.service';

/**
 * Scope Engine — Stage 2 build-order item 9.
 * Daii/architecture/DAII_PLATFORM_FOUNDATION_CONTRACT.md §5, ADR-005.
 *
 * WHICH data a user may act against — distinct from Permission Engine's
 * WHAT (item 8). `unrestrictedRoles` is a deliberately small, explicit
 * escape hatch (admin sees everything) rather than a full org/territory
 * hierarchy resolver — that hierarchy is Sales/Organization domain work
 * (items 10, 23, Phase B) not yet built; this stays generic until a real
 * domain needs richer scope-derivation logic.
 */
const UNRESTRICTED_ROLES = ['admin'];

@Injectable()
export class ScopeService {
  constructor(
    @InjectRepository(ScopeAssignment) private readonly assignments: Repository<ScopeAssignment>,
    private readonly authorization: AuthorizationService,
  ) {}

  async assign(userId: string, resourceType: string, resourceId: string): Promise<void> {
    const existing = await this.assignments.findOne({ where: { userId, resourceType, resourceId } });
    if (existing) return; // idempotent
    await this.assignments.save(this.assignments.create({ userId, resourceType, resourceId }));
  }

  async unassign(userId: string, resourceType: string, resourceId: string): Promise<void> {
    await this.assignments.delete({ userId, resourceType, resourceId });
  }

  private async hasUnrestrictedScope(userId: string): Promise<boolean> {
    const roles = await this.authorization.getRoleKeysForUser(userId);
    return roles.some((r) => UNRESTRICTED_ROLES.includes(r));
  }

  async getAssignedResourceIds(userId: string, resourceType: string): Promise<string[] | 'ALL'> {
    if (await this.hasUnrestrictedScope(userId)) return 'ALL';
    const rows = await this.assignments.find({ where: { userId, resourceType } });
    return rows.map((r) => r.resourceId);
  }

  /** Intersects a candidate ID list with what this user is scoped to — the list-query safety net. */
  async filterAllowed(userId: string, resourceType: string, candidateIds: string[]): Promise<string[]> {
    const allowed = await this.getAssignedResourceIds(userId, resourceType);
    if (allowed === 'ALL') return candidateIds;
    const allowedSet = new Set(allowed);
    return candidateIds.filter((id) => allowedSet.has(id));
  }

  /** Detail-view guard: throws 404 (never 403 — anti-enumeration, same discipline as Permission Engine). */
  async assertAccess(userId: string, resourceType: string, resourceId: string): Promise<void> {
    if (await this.hasUnrestrictedScope(userId)) return;
    const row = await this.assignments.findOne({ where: { userId, resourceType, resourceId } });
    if (!row) throw new NotFoundException();
  }

  /** Bulk existence check, used when assigning a batch (e.g. re-provisioning a rep's customer list). */
  async getAssignedCount(userId: string, resourceType: string, resourceIds: string[]): Promise<number> {
    return this.assignments.count({ where: { userId, resourceType, resourceId: In(resourceIds) } });
  }
}
