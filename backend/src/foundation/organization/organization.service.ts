import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
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
 */
@Injectable()
export class OrganizationService {
  constructor(
    @InjectRepository(OrgUnit) private readonly units: Repository<OrgUnit>,
    @InjectRepository(OrgMembership) private readonly memberships: Repository<OrgMembership>,
  ) {}

  /** Backs the Organization hierarchy UI — small tree, whole-table read is proportional (CTO Execution Policy §9). */
  async listUnits(): Promise<OrgUnit[]> {
    return this.units.find({ order: { createdAt: 'ASC' } });
  }

  /** ADR-059 (HR Phase 1) — `hr`'s `/hr/departments` view filters to `type = 'department'` through this, rather than a second table. */
  async listUnitsByType(type: OrgUnitType): Promise<OrgUnit[]> {
    return this.units.find({ where: { type }, order: { name: 'ASC' } });
  }

  async getUnitById(id: string): Promise<OrgUnit | null> {
    return this.units.findOne({ where: { id } });
  }

  /** `code` (ADR-059 D4 — HR issues this via `NumberingService` for `type = 'department'`) is optional and unused by every other existing caller of this method. */
  async createUnit(type: OrgUnitType, name: string, parentId: string | null = null, code: string | null = null): Promise<OrgUnit> {
    if (parentId) {
      const parent = await this.units.findOne({ where: { id: parentId } });
      if (!parent) throw new NotFoundException(`Parent org unit "${parentId}" not found.`);
    }
    return this.units.save(this.units.create({ type, name, parentId, code }));
  }

  /** ADR-059 (HR Phase 1) — the missing "rename a department" capability the Phase 0 study flagged as a real gap (`hr.department.edit` was declared but unwired). Generic enough for any `OrgUnit`, not HR-specific. */
  async renameUnit(id: string, name: string): Promise<OrgUnit> {
    const unit = await this.units.findOne({ where: { id } });
    if (!unit) throw new NotFoundException(`Org unit "${id}" not found.`);
    unit.name = name;
    return this.units.save(unit);
  }

  async assignMember(userId: string, orgUnitId: string): Promise<void> {
    const unit = await this.units.findOne({ where: { id: orgUnitId } });
    if (!unit) throw new NotFoundException(`Org unit "${orgUnitId}" not found.`);
    const existing = await this.memberships.findOne({ where: { userId, orgUnitId } });
    if (existing) return; // idempotent
    await this.memberships.save(this.memberships.create({ userId, orgUnitId }));
  }

  async removeMember(userId: string, orgUnitId: string): Promise<void> {
    await this.memberships.delete({ userId, orgUnitId });
  }

  async getUnitIdsForUser(userId: string): Promise<string[]> {
    const rows = await this.memberships.find({ where: { userId } });
    return rows.map((r) => r.orgUnitId);
  }

  async getMemberIds(orgUnitId: string): Promise<string[]> {
    const rows = await this.memberships.find({ where: { orgUnitId } });
    return rows.map((r) => r.userId);
  }

  /** All descendant unit ids (children, grandchildren, ...) of a given unit, not including itself. */
  async getDescendantIds(orgUnitId: string): Promise<string[]> {
    const descendants: string[] = [];
    let frontier = [orgUnitId];
    while (frontier.length > 0) {
      const children = await this.units.find({ where: { parentId: In(frontier) } });
      if (children.length === 0) break;
      const childIds = children.map((c) => c.id);
      descendants.push(...childIds);
      frontier = childIds;
    }
    return descendants;
  }

  /** All ancestor unit ids from immediate parent up to the root. */
  async getAncestorIds(orgUnitId: string): Promise<string[]> {
    const ancestors: string[] = [];
    let current = await this.units.findOne({ where: { id: orgUnitId } });
    while (current?.parentId) {
      ancestors.push(current.parentId);
      current = await this.units.findOne({ where: { id: current.parentId } });
    }
    return ancestors;
  }
}
