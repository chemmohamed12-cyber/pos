import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { OrgUnit, OrgUnitType } from './org-unit.entity';

/**
 * Org engine Stage 1 — which parent types a unit type may sit under (`null` parent is handled separately). The unit type `warehouse` is FROZEN for new use
 * (CTO D-2): the real `warehouses` entity is the warehouse source of truth and links to its owning branch through `warehouses.orgUnitId`.
 */
const ALLOWED_PARENT_TYPES: Record<OrgUnitType, readonly OrgUnitType[]> = {
  company: [],
  branch: ['company'],
  department: ['company', 'branch', 'department'],
  team: ['company', 'branch', 'department', 'team'],
  warehouse: ['company', 'branch'],
};

/** Master records that still point at a unit — an archive is refused while any exist (they would keep working under an inactive unit). `condition` is trusted constant SQL. */
const BLOCKING_REFERENCES: ReadonlyArray<{ table: string; column: string; condition?: string; labelEn: string; labelAr: string }> = [
  { table: 'warehouses', column: 'orgUnitId', labelEn: 'warehouses', labelAr: 'مخازن' },
  { table: 'hr_employees', column: 'departmentId', condition: `"status" <> 'terminated'`, labelEn: 'active employees', labelAr: 'موظفون على رأس العمل' },
  { table: 'treasury_accounts', column: 'orgUnitId', labelEn: 'treasury accounts', labelAr: 'حسابات خزينة' },
  { table: 'suppliers', column: 'orgUnitId', labelEn: 'suppliers', labelAr: 'موردون' },
  { table: 'accounting_financial_dimension_values', column: 'orgUnitId', labelEn: 'cost-centre / dimension values', labelAr: 'مراكز تكلفة / قيم أبعاد' },
  { table: 'accounting_gl_accounts', column: 'orgUnitId', labelEn: 'GL accounts', labelAr: 'حسابات دفتر الأستاذ' },
  { table: 'vehicles', column: 'orgUnitId', labelEn: 'vehicles', labelAr: 'سيارات' },
];

export interface OrgRootReconciliation {
  canonicalId: string;
  renamedTo: string | null;
  movedChildren: Array<{ id: string; name: string; from: string }>;
  archivedRoots: Array<{ id: string; name: string }>;
  dryRun: boolean;
}

export interface OrgUnitImpact {
  unit: OrgUnit;
  activeChildren: number;
  members: number;
  grants: number;
  /** Master records that block an archive. */
  blocking: Array<{ table: string; labelEn: string; labelAr: string; count: number }>;
  /** Documents / ledgers that reference the unit — they stay valid (history is never rewritten) and are only informational. */
  historical: Array<{ table: string; count: number }>;
  canArchive: boolean;
  reasons: string[];
}
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

  /** ADR-059 (HR Phase 1) — `hr`'s `/hr/departments` view filters to `type = 'department'` through this, rather than a second table. Archived units are not offered. */
  async listUnitsByType(type: OrgUnitType, manager?: EntityManager): Promise<OrgUnit[]> {
    return (manager ?? this.dataSource).getRepository(OrgUnit).find({ where: { type, status: 'active' }, order: { name: 'ASC' } });
  }

  async getUnitById(id: string, manager?: EntityManager): Promise<OrgUnit | null> {
    return (manager ?? this.dataSource).getRepository(OrgUnit).findOne({ where: { id } });
  }

  private activeRoots(repo: Repository<OrgUnit>): Promise<number> {
    return repo.createQueryBuilder('u').where(`u.type = 'company' AND u."parentId" IS NULL AND u.status = 'active'`).getCount();
  }

  /**
   * Org engine Stage 1 — tree integrity on creation: the unit type `warehouse` is frozen; the parent must exist, be active and be of an allowed type; a Company root has no
   * parent and there is at most one active root; a branch needs a parent once the Company has a root; sibling units of one type cannot share a name.
   * `code` (ADR-059 D4 — HR issues this via `NumberingService` for `type = 'department'`) is optional and unused by every other existing caller of this method.
   */
  async createUnit(type: OrgUnitType, name: string, parentId: string | null = null, code: string | null = null, manager?: EntityManager): Promise<OrgUnit> {
    const repo = (manager ?? this.dataSource).getRepository(OrgUnit);
    const cleanName = (name ?? '').trim();
    if (!cleanName) throw new BadRequestException('A unit name is required. / اسم الوحدة مطلوب.');
    if (type === 'warehouse') {
      throw new BadRequestException('Warehouses are managed in the Warehouses screen; the "warehouse" organization unit type is no longer used. / المخازن تُدار من شاشة المخازن ولم يعد نوع الوحدة «مخزن» مستخدماً.');
    }
    let parent: OrgUnit | null = null;
    if (parentId) {
      parent = await repo.findOne({ where: { id: parentId } });
      if (!parent) throw new NotFoundException(`Parent org unit "${parentId}" not found.`);
      if (parent.status !== 'active') throw new ConflictException('The parent unit is archived. / الوحدة الأم مؤرشفة.');
    }
    this.assertParentFits(type, parent);
    if (type === 'company') {
      if ((await this.activeRoots(repo)) > 0) throw new ConflictException('The Company already has a root unit. / للشركة وحدة جذر بالفعل.');
    } else if (!parent && type === 'branch' && (await this.activeRoots(repo)) > 0) {
      throw new BadRequestException('A branch must be placed under the Company. / يجب أن يكون الفرع تحت الشركة.');
    }
    await this.assertSiblingNameFree(repo, type, parentId, cleanName, null);
    return repo.save(repo.create({ type, name: cleanName, parentId, code, status: 'active', archivedAt: null }));
  }

  /** Parent/child type matrix. A null parent is allowed for a Company root, and (legacy flat trees, HR departments) for department / team / branch when no root exists. */
  private assertParentFits(type: OrgUnitType, parent: OrgUnit | null): void {
    if (type === 'company') {
      if (parent) throw new BadRequestException('A Company root cannot have a parent. / جذر الشركة لا يمكن أن يكون له أصل.');
      return;
    }
    if (!parent) return;
    if (!ALLOWED_PARENT_TYPES[type].includes(parent.type)) {
      throw new BadRequestException(`A ${type} cannot be placed under a ${parent.type}. / لا يمكن وضع هذا النوع تحت وحدة من النوع «${parent.type}».`);
    }
  }

  private async assertSiblingNameFree(repo: Repository<OrgUnit>, type: OrgUnitType, parentId: string | null, name: string, exceptId: string | null): Promise<void> {
    const qb = repo
      .createQueryBuilder('u')
      .where('u.type = :type AND lower(u.name) = lower(:name) AND u.status = :active', { type, name, active: 'active' })
      .andWhere(parentId ? 'u."parentId" = :parentId' : 'u."parentId" IS NULL', { parentId });
    if (exceptId) qb.andWhere('u.id <> :exceptId', { exceptId });
    if ((await qb.getCount()) > 0) throw new ConflictException(`A ${type} named "${name}" already exists under the same parent. / توجد وحدة بنفس الاسم تحت نفس الأصل.`);
  }

  /** ADR-059 (HR Phase 1) — the missing "rename a department" capability the Phase 0 study flagged as a real gap (`hr.department.edit` was declared but unwired). Generic enough for any `OrgUnit`, not HR-specific. */
  async renameUnit(id: string, name: string, manager?: EntityManager): Promise<OrgUnit> {
    return this.updateUnit(id, { name }, manager);
  }

  /**
   * Edit a unit: rename and/or move under another parent. The type never changes. A move is refused if it would create a cycle (the new parent is the unit
   * itself or one of its descendants), breaks the type matrix, or collides with a sibling name. An archived unit is read-only until reactivated.
   */
  async updateUnit(id: string, changes: { name?: string; parentId?: string | null }, manager?: EntityManager): Promise<OrgUnit> {
    const repo = (manager ?? this.dataSource).getRepository(OrgUnit);
    const unit = await repo.findOne({ where: { id } });
    if (!unit) throw new NotFoundException(`Org unit "${id}" not found.`);
    if (unit.status !== 'active') throw new ConflictException('The unit is archived — reactivate it before editing. / الوحدة مؤرشفة — أعد تفعيلها قبل التعديل.');
    const name = changes.name === undefined ? unit.name : changes.name.trim();
    if (!name) throw new BadRequestException('A unit name is required. / اسم الوحدة مطلوب.');
    let parentId = unit.parentId;
    if (changes.parentId !== undefined && changes.parentId !== unit.parentId) {
      if (unit.type === 'company') throw new BadRequestException('The Company root cannot be moved. / لا يمكن نقل جذر الشركة.');
      const target = changes.parentId ? await repo.findOne({ where: { id: changes.parentId } }) : null;
      if (changes.parentId && !target) throw new NotFoundException(`Parent org unit "${changes.parentId}" not found.`);
      if (target && target.status !== 'active') throw new ConflictException('The parent unit is archived. / الوحدة الأم مؤرشفة.');
      if (target && (target.id === unit.id || (await this.getDescendantIds(unit.id, manager)).includes(target.id))) {
        throw new BadRequestException('A unit cannot be moved under itself or one of its own sub-units. / لا يمكن نقل الوحدة تحت نفسها أو تحت إحدى وحداتها الفرعية.');
      }
      if (!target && unit.type === 'branch' && (await this.activeRoots(repo)) > 0) {
        throw new BadRequestException('A branch must be placed under the Company. / يجب أن يكون الفرع تحت الشركة.');
      }
      this.assertParentFits(unit.type, target);
      parentId = changes.parentId ?? null;
    }
    if (name !== unit.name || parentId !== unit.parentId) await this.assertSiblingNameFree(repo, unit.type, parentId, name, unit.id);
    unit.name = name;
    unit.parentId = parentId;
    return repo.save(unit);
  }

  /**
   * What archiving this unit would affect — shown to the user before they confirm. Blocking = master records still attached (children, warehouses, employees,
   * accounts, suppliers, vehicles …); historical = documents that reference the unit and simply stay valid. Members / explicit grants are reported, not removed.
   */
  async getImpact(id: string, manager?: EntityManager): Promise<OrgUnitImpact> {
    const runner = manager ?? this.dataSource;
    const unit = await runner.getRepository(OrgUnit).findOne({ where: { id } });
    if (!unit) throw new NotFoundException(`Org unit "${id}" not found.`);
    const one = async (sql: string, params: unknown[]): Promise<number> => Number((await runner.query(sql, params))[0]?.n ?? 0);
    const exists = async (table: string, column?: string): Promise<boolean> =>
      (
        await runner.query(
          `SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ${column ? 'AND column_name = $2' : ''} LIMIT 1`,
          column ? [table, column] : [table],
        )
      ).length > 0;
    const activeChildren = await one(`SELECT count(*)::int AS n FROM "org_units" WHERE "parentId" = $1 AND status = 'active'`, [id]);
    const members = await one(`SELECT count(*)::int AS n FROM "org_memberships" WHERE "orgUnitId" = $1`, [id]);
    const grants = (await exists('access_scopes')) ? await one(`SELECT count(*)::int AS n FROM "access_scopes" WHERE "orgUnitId" = $1`, [id]) : 0;
    const blocking: OrgUnitImpact['blocking'] = [];
    const blockingTables = new Set<string>();
    for (const ref of BLOCKING_REFERENCES) {
      if (!(await exists(ref.table, ref.column))) continue;
      blockingTables.add(ref.table);
      const count = await one(`SELECT count(*)::int AS n FROM "${ref.table}" WHERE "${ref.column}" = $1${ref.condition ? ` AND ${ref.condition}` : ''}`, [id]);
      if (count > 0) blocking.push({ table: ref.table, labelEn: ref.labelEn, labelAr: ref.labelAr, count });
    }
    const historical: OrgUnitImpact['historical'] = [];
    const cols: Array<{ table_name: string }> = await runner.query(
      `SELECT table_name FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'orgUnitId' AND table_name NOT IN ('org_memberships','access_scopes','org_units') ORDER BY table_name`,
    );
    for (const { table_name } of cols) {
      if (blockingTables.has(table_name)) continue;
      const count = await one(`SELECT count(*)::int AS n FROM "${table_name}" WHERE "orgUnitId" = $1`, [id]);
      if (count > 0) historical.push({ table: table_name, count });
    }
    const reasons: string[] = [];
    if (unit.status !== 'active') reasons.push('Already archived. / مؤرشفة بالفعل.');
    if (activeChildren > 0) reasons.push(`${activeChildren} active sub-unit(s) must be moved or archived first. / يجب نقل أو أرشفة ${activeChildren} وحدة فرعية أولاً.`);
    for (const b of blocking) reasons.push(`${b.count} ${b.labelEn} still attached. / ${b.count} ${b.labelAr} ما زالت مرتبطة.`);
    return { unit, activeChildren, members, grants, blocking, historical, canArchive: reasons.length === 0, reasons };
  }

  /** Soft-archive: refused while sub-units or master records are attached. Historical documents keep their reference (never rewritten). */
  async archiveUnit(id: string, manager?: EntityManager): Promise<OrgUnit> {
    const impact = await this.getImpact(id, manager);
    if (!impact.canArchive) throw new ConflictException({ message: impact.reasons.join(' '), impact });
    const repo = (manager ?? this.dataSource).getRepository(OrgUnit);
    impact.unit.status = 'archived';
    impact.unit.archivedAt = new Date();
    return repo.save(impact.unit);
  }

  async activateUnit(id: string, manager?: EntityManager): Promise<OrgUnit> {
    const repo = (manager ?? this.dataSource).getRepository(OrgUnit);
    const unit = await repo.findOne({ where: { id } });
    if (!unit) throw new NotFoundException(`Org unit "${id}" not found.`);
    if (unit.status === 'active') return unit;
    if (unit.parentId) {
      const parent = await repo.findOne({ where: { id: unit.parentId } });
      if (parent && parent.status !== 'active') throw new ConflictException('Reactivate the parent unit first. / أعد تفعيل الوحدة الأم أولاً.');
    }
    if (unit.type === 'company' && !unit.parentId && (await this.activeRoots(repo)) > 0) {
      throw new ConflictException('The Company already has an active root. / للشركة جذر فعّال بالفعل.');
    }
    await this.assertSiblingNameFree(repo, unit.type, unit.parentId, unit.name, unit.id);
    unit.status = 'active';
    unit.archivedAt = null;
    return repo.save(unit);
  }

  /**
   * Reconcile several root units of type `company` into ONE canonical root (CTO D-9). Nothing is deleted and no id changes: the other roots' sub-units are
   * re-parented under the canonical root, and each emptied root is archived. A root that still has members, grants or attached master records is NOT touched
   * (the call fails with the details) — widening or silently moving a scope source would be unsafe. With `dryRun` nothing is written.
   */
  async reconcileRoots(canonicalId: string, opts: { rename?: string; dryRun?: boolean } = {}, manager?: EntityManager): Promise<OrgRootReconciliation> {
    const run = async (m: EntityManager): Promise<OrgRootReconciliation> => {
      const repo = m.getRepository(OrgUnit);
      const canonical = await repo.findOne({ where: { id: canonicalId } });
      if (!canonical || canonical.type !== 'company' || canonical.parentId || canonical.status !== 'active') {
        throw new BadRequestException('The canonical unit must be an active Company root. / يجب أن تكون الوحدة المعتمدة جذر شركة فعّالاً.');
      }
      const others = await repo
        .createQueryBuilder('u')
        .where(`u.type = 'company' AND u."parentId" IS NULL AND u.status = 'active' AND u.id <> :id`, { id: canonicalId })
        .orderBy('u."createdAt"', 'ASC')
        .getMany();
      const report: OrgRootReconciliation = { canonicalId, renamedTo: null, movedChildren: [], archivedRoots: [], dryRun: Boolean(opts.dryRun) };
      for (const root of others) {
        const impact = await this.getImpact(root.id, m);
        const attached = impact.members + impact.grants + impact.blocking.reduce((n, b) => n + b.count, 0);
        if (attached > 0) throw new ConflictException({ message: `Root "${root.name}" still has members, grants or attached records — resolve them first. / الجذر «${root.name}» ما زال له أعضاء أو صلاحيات أو سجلات مرتبطة.`, impact });
        const kids = await repo.find({ where: { parentId: root.id } });
        for (const kid of kids) {
          if (!ALLOWED_PARENT_TYPES[kid.type].includes('company')) throw new ConflictException(`Sub-unit "${kid.name}" (${kid.type}) cannot sit directly under the Company. / لا يمكن وضع «${kid.name}» مباشرةً تحت الشركة.`);
          if (kid.status === 'active') await this.assertSiblingNameFree(repo, kid.type, canonicalId, kid.name, kid.id);
          report.movedChildren.push({ id: kid.id, name: kid.name, from: root.name });
          if (!opts.dryRun) await repo.update({ id: kid.id }, { parentId: canonicalId });
        }
        report.archivedRoots.push({ id: root.id, name: root.name });
        if (!opts.dryRun) await repo.update({ id: root.id }, { status: 'archived', archivedAt: new Date() });
      }
      const newName = opts.rename?.trim();
      if (newName && newName !== canonical.name) {
        report.renamedTo = newName;
        if (!opts.dryRun) await repo.update({ id: canonicalId }, { name: newName });
      }
      if (!opts.dryRun) {
        await m.query(
          `DO $$ BEGIN IF (SELECT count(*) FROM org_units WHERE type = 'company' AND "parentId" IS NULL AND status = 'active') <= 1 THEN
             CREATE UNIQUE INDEX IF NOT EXISTS "IDX_org_units_single_root" ON org_units ((true)) WHERE type = 'company' AND "parentId" IS NULL AND status = 'active'; END IF; END $$;`,
        );
      }
      return report;
    };
    if (manager) return run(manager);
    return this.dataSource.transaction(run);
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
