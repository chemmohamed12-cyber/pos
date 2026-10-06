import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { OrgUnit, OrgUnitType } from './org-unit.entity';
import { OrgMembership } from './org-membership.entity';

/**
 * Organization — Stage 2 build-order item 10.
 * Daii/architecture/DAII_PLATFORM_FOUNDATION_CONTRACT.md §7.
 *
 * Recursive ancestor/descendant walks are done in application code (a
 * handful of round-trips over a small tree) rather than a recursive SQL
 * CTE — proportional to V1 scale (CTO Execution Policy §9: measure
 * before optimizing hypothetically).
 *
 * Area 21 Operational Company Scoping Retrofit (2026-09-27) — rewritten
 * from `@InjectRepository(OrgUnit)`/`@InjectRepository(OrgMembership)`
 * (structurally incapable of Company-routing, bound at module-load time
 * to the ambient DataSource) to an injected `DataSource` + `manager?` on
 * every method, the same fix `ScopeService` already received during the
 * Sales Orders retrofit (§16). `OrgUnit`/`OrgMembership` are Company-owned
 * (each Company has its own branch/department tree) and this service is
 * consumed across multiple domains (`treasury`, `accounting`, `hr`) via
 * `ScopeResolver` — a foundation-level fix, not specific to any one
 * domain's own retrofit turn.
 */
@Injectable()
export class OrganizationService {
  constructor(private readonly dataSource: DataSource) {}

  /** Backs the Organization hierarchy UI — small tree, whole-table read is proportional (CTO Execution Policy §9). */
  async listUnits(manager?: EntityManager): Promise<OrgUnit[]> {
    return (manager ?? this.dataSource).getRepository(OrgUnit).find({ order: { createdAt: 'ASC' } });
  }

  /** ADR-059 (HR Phase 1) — `hr`'s `/hr/departments` view filters to `type = 'department'` through this, rather than a second table. */
  async listUnitsByType(type: OrgUnitType, manager?: EntityManager): Promise<OrgUnit[]> {
    return (manager ?? this.dataSource).getRepository(OrgUnit).find({ where: { type }, order: { name: 'ASC' } });
  }

  async getUnitById(id: string, manager?: EntityManager): Promise<OrgUnit | null> {
    return (manager ?? this.dataSource).getRepository(OrgUnit).findOne({ where: { id } });
  }

  /** `code` (ADR-059 D4 — HR issues this via `NumberingService` for `type = 'department'`) is optional and unused by every other existing caller of this method. */
  async createUnit(type: OrgUnitType, name: string, parentId: string | null = null, code: string | null = null, manager?: EntityManager): Promise<OrgUnit> {
    const repo = (manager ?? this.dataSource).getRepository(OrgUnit);
    if (parentId) {
      const parent = await repo.findOne({ where: { id: parentId } });
      if (!parent) throw new NotFoundException(`Parent org unit "${parentId}" not found.`);
    }
    return repo.save(repo.create({ type, name, parentId, code }));
  }

  /** ADR-059 (HR Phase 1) — the missing "rename a department" capability the Phase 0 study flagged as a real gap (`hr.department.edit` was declared but unwired). Generic enough for any `OrgUnit`, not HR-specific. */
  async renameUnit(id: string, name: string, manager?: EntityManager): Promise<OrgUnit> {
    const repo = (manager ?? this.dataSource).getRepository(OrgUnit);
    const unit = await repo.findOne({ where: { id } });
    if (!unit) throw new NotFoundException(`Org unit "${id}" not found.`);
    unit.name = name;
    return repo.save(unit);
  }

  async assignMember(userId: string, orgUnitId: string, manager?: EntityManager): Promise<void> {
    const runner = manager ?? this.dataSource;
    const unit = await runner.getRepository(OrgUnit).findOne({ where: { id: orgUnitId } });
    if (!unit) throw new NotFoundException(`Org unit "${orgUnitId}" not found.`);
    const membershipRepo = runner.getRepository(OrgMembership);
    const existing = await membershipRepo.findOne({ where: { userId, orgUnitId } });
    if (existing) return; // idempotent
    await membershipRepo.save(membershipRepo.create({ userId, orgUnitId }));
  }

  async removeMember(userId: string, orgUnitId: string, manager?: EntityManager): Promise<void> {
    await (manager ?? this.dataSource).getRepository(OrgMembership).delete({ userId, orgUnitId });
  }

  async getUnitIdsForUser(userId: string, manager?: EntityManager): Promise<string[]> {
    const rows = await (manager ?? this.dataSource).getRepository(OrgMembership).find({ where: { userId } });
    return rows.map((r) => r.orgUnitId);
  }

  async getMemberIds(orgUnitId: string, manager?: EntityManager): Promise<string[]> {
    const rows = await (manager ?? this.dataSource).getRepository(OrgMembership).find({ where: { orgUnitId } });
    return rows.map((r) => r.userId);
  }

  /** All descendant unit ids (children, grandchildren, ...) of a given unit, not including itself. */
  async getDescendantIds(orgUnitId: string, manager?: EntityManager): Promise<string[]> {
    const repo = (manager ?? this.dataSource).getRepository(OrgUnit);
    const descendants: string[] = [];
    let frontier = [orgUnitId];
    while (frontier.length > 0) {
      const children = await repo.find({ where: { parentId: In(frontier) } });
      if (children.length === 0) break;
      const childIds = children.map((c) => c.id);
      descendants.push(...childIds);
      frontier = childIds;
    }
    return descendants;
  }

  /** All ancestor unit ids from immediate parent up to the root. */
  async getAncestorIds(orgUnitId: string, manager?: EntityManager): Promise<string[]> {
    const repo = (manager ?? this.dataSource).getRepository(OrgUnit);
    const ancestors: string[] = [];
    let current = await repo.findOne({ where: { id: orgUnitId } });
    while (current?.parentId) {
      ancestors.push(current.parentId);
      current = await repo.findOne({ where: { id: current.parentId } });
    }
    return ancestors;
  }
}
