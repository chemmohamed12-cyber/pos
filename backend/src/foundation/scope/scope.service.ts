import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
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
 *
 * Area 21 Operational Company Scoping Retrofit (2026-09-27, CTO-authorized):
 * `manager?: EntityManager` added to every method — `ScopeAssignment` is
 * Company-owned (assignments are always against a Company-owned resource
 * like a sales order/customer), so this needed the same
 * `(manager ?? this.dataSource).getRepository(...)` threading every other
 * manager-capable service already uses, not a new pattern. Switched from
 * `@InjectRepository` (structurally incapable of Company-routing — the
 * exact gap `media.controller.ts`'s own retrofit package already
 * identified as a red flag) to an injected `DataSource`, matching
 * `SalesOrdersService`'s own established shape. `ScopeAssignment` added to
 * `CORE_COMPANY_ENTITIES` (`core-company-entities.ts`) in the same change
 * — it was never there before, so a Company `DataSource` had no metadata
 * for it until now.
 */

@Injectable()
export class ScopeService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly authorization: AuthorizationService,
  ) {}

  async assign(userId: string, resourceType: string, resourceId: string, manager?: EntityManager): Promise<void> {
    const repo = (manager ?? this.dataSource).getRepository(ScopeAssignment);
    const existing = await repo.findOne({ where: { userId, resourceType, resourceId } });
    if (existing) return; // idempotent
    await repo.save(repo.create({ userId, resourceType, resourceId }));
  }

  async unassign(userId: string, resourceType: string, resourceId: string, manager?: EntityManager): Promise<void> {
    await (manager ?? this.dataSource).getRepository(ScopeAssignment).delete({ userId, resourceType, resourceId });
  }

  private async hasUnrestrictedScope(userId: string, manager?: EntityManager): Promise<boolean> {
    return (await this.authorization.workflowAccess(userId, manager)).allows('core.scope.unrestricted');
  }

  async getAssignedResourceIds(userId: string, resourceType: string, manager?: EntityManager): Promise<string[] | 'ALL'> {
    if (await this.hasUnrestrictedScope(userId, manager)) return 'ALL';
    const rows = await (manager ?? this.dataSource).getRepository(ScopeAssignment).find({ where: { userId, resourceType } });
    return rows.map((r) => r.resourceId);
  }

  /** Intersects a candidate ID list with what this user is scoped to — the list-query safety net. */
  async filterAllowed(userId: string, resourceType: string, candidateIds: string[], manager?: EntityManager): Promise<string[]> {
    const allowed = await this.getAssignedResourceIds(userId, resourceType, manager);
    if (allowed === 'ALL') return candidateIds;
    const allowedSet = new Set(allowed);
    return candidateIds.filter((id) => allowedSet.has(id));
  }

  /** Detail-view guard: throws 404 (never 403 — anti-enumeration, same discipline as Permission Engine). */
  async assertAccess(userId: string, resourceType: string, resourceId: string, manager?: EntityManager): Promise<void> {
    if (await this.hasUnrestrictedScope(userId, manager)) return;
    const row = await (manager ?? this.dataSource).getRepository(ScopeAssignment).findOne({ where: { userId, resourceType, resourceId } });
    if (!row) throw new NotFoundException();
  }

  /** Bulk existence check, used when assigning a batch (e.g. re-provisioning a rep's customer list). */
  async getAssignedCount(userId: string, resourceType: string, resourceIds: string[], manager?: EntityManager): Promise<number> {
    return (manager ?? this.dataSource).getRepository(ScopeAssignment).count({ where: { userId, resourceType, resourceId: In(resourceIds) } });
  }
}
