import { randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { AuthorizationContextService } from '../authorization/authorization-context.service';
import { RoleKind } from '../authorization/role.entity';
import { MODULE_ROLE_TEMPLATES, RoleTemplate } from '../module-registry/role-templates';
import { roleTitleCode } from '../authorization/role-classification';
import { buildCatalog, CatalogNode } from '../permission/capability-catalog';
import { COMPANY_MEMBERS_MANAGE_NODE, COMPANY_ROLES_MANAGE_NODE } from '../permission/company-nodes';
import { moduleOfNode } from '../permission/permission-catalog';
import { criticalNodesCovered, Grant } from '../permission/role-grant-math';
import { CompanyEntitlementService } from '../plans/company-entitlement.service';
import { CompanyActor } from './company-user-management.service';
import { CompanyUserError, lockAdministration } from './company-user-roles';
import { MembershipService } from './membership.service';

export interface RoleView {
  id: string;
  key: string;
  type: RoleKind;
  /** Terminology code of the display name for catalog template roles (the name columns stay empty until a Company renames the role). */
  titleCode: string | null;
  nameEn: string | null;
  nameAr: string | null;
  descriptionEn: string | null;
  descriptionAr: string | null;
  isActive: boolean;
  templateKey: string | null;
  templateVersion: number | null;
  customized: boolean | null;
  memberCount: number;
  grantCount: number;
  criticalNodes: string[];
  templateUpdateAvailable: boolean;
  /** Entitlement of the template's module (`null` = not module-bound). A role whose module left the package keeps its grants dormant. */
  moduleEntitled: boolean | null;
}

export interface RoleGrantView extends Grant {
  titleEn: string;
  titleAr: string;
  risk: string;
  module: string | null;
  /** The grant belongs to a module outside the Company's package: kept, but dormant (nothing can use it). */
  dormant: boolean;
}

export interface TemplateView {
  key: string;
  module: string;
  version: number;
  titleCode: string;
  entitled: boolean;
  /** The role already exists in this Company (created from this template, or a same-named role). */
  instantiated: boolean;
  grants: Grant[];
  criticalNodes: string[];
}

export interface TemplateDiff {
  roleId: string;
  templateKey: string;
  fromVersion: number;
  toVersion: number;
  customized: boolean;
  /** Offered to the Company; never applied automatically. */
  added: Grant[];
  changed: Array<{ node: string; from: string; to: string }>;
  /** Informational only: removal of a template grant is NEVER applied automatically. */
  removedFromTemplate: Grant[];
  introducesCritical: string[];
}

export interface RoleInput {
  nameEn?: unknown;
  nameAr?: unknown;
  descriptionEn?: unknown;
  descriptionAr?: unknown;
  isActive?: unknown;
  grants?: unknown;
}

const PROTECTED: ReadonlySet<RoleKind> = new Set(['system', 'legacy']);

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

/**
 * Authorization Foundation F3 — Company role management (Blueprint §6–§8, §16, §21). The Company being acted on is ALWAYS the validated Company of the
 * request (the caller passes its DataSource); there is no company parameter.
 *
 * Rules enforced here, in the service (the UI only mirrors them):
 *  - **Types.** `system` (`company_admin`) and `legacy` (the pre-template flat keys and the existing `admin`, which business logic still checks by name) are
 *    PROTECTED: no edit, no delete. `template` and `custom` roles are Company-owned and editable; editing a template role marks it customised.
 *  - **Anti-elevation.** A role definition may newly reach a CRITICAL node only if the editor holds that node explicitly; creating a role from a catalog template
 *    is a catalog-approved act and is not blocked (assignment of a critical-reaching role is gated in the user service).
 *  - **Entitlement ≠ Permission (E4).** A grant for a module outside the Company's package cannot be added; grants already there stay (dormant).
 *  - **Dependencies.** Granting an action `editable` also grants the resource's `view` node read-only, so a role cannot be unusable.
 *  - **Administration never disappears.** An edit/delete that would leave no ACTIVE member able to manage users and roles is refused (serialised by the
 *    per-Company administration lock, like the last-administrator rule).
 *  - **Template upgrades are OFFERED, never forced** (diff → apply all/selected, or ignore); customised roles are never touched; a template grant that disappears
 *    is never removed from a Company role automatically.
 *  - **No delete while in use.** A role held by any member cannot be deleted.
 */
@Injectable()
export class CompanyRoleManagementService {
  /** The template catalog in force. A property (not a constant) only so specs can exercise a v2 catalog; production always uses `MODULE_ROLE_TEMPLATES`. */
  catalog: Record<string, RoleTemplate[]> = MODULE_ROLE_TEMPLATES;

  constructor(
    private readonly audit: AuditService,
    private readonly entitlement: CompanyEntitlementService,
    private readonly contexts: AuthorizationContextService,
    private readonly memberships: MembershipService,
  ) {}

  // ───────────────────────────── reads ─────────────────────────────

  async list(ds: DataSource, companyId: string): Promise<RoleView[]> {
    const roles = await this.loadRoles(ds.manager);
    const grants = await this.loadAllGrants(ds.manager);
    const counts: Array<{ roleId: string; n: number }> = await ds.manager.query(`SELECT "roleId", count(*)::int AS n FROM "user_roles" GROUP BY "roleId"`);
    const modules = (await this.entitlement.resolve(companyId)).modules;
    const memberCount = new Map(counts.map((c) => [c.roleId, c.n]));
    const out: RoleView[] = [];
    for (const r of roles) out.push(await this.toView(ds.manager, r, grants.get(r.id) ?? [], memberCount.get(r.id) ?? 0, modules));
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }

  async detail(ds: DataSource, companyId: string, roleId: string): Promise<{ role: RoleView; grants: RoleGrantView[] }> {
    const row = await this.requireRole(ds.manager, roleId);
    const grants = (await this.loadAllGrants(ds.manager, roleId)).get(roleId) ?? [];
    const modules = (await this.entitlement.resolve(companyId)).modules;
    const [{ n }]: Array<{ n: number }> = await ds.manager.query(`SELECT count(*)::int AS n FROM "user_roles" WHERE "roleId" = $1`, [roleId]);
    return { role: await this.toView(ds.manager, row, grants, n, modules), grants: grants.map((g) => this.grantView(g, modules)) };
  }

  /** The permission catalog the editor offers: only nodes of ENTITLED modules (and core), with risk and bilingual titles. */
  async catalogFor(companyId: string): Promise<Array<CatalogNode & { risk: string }>> {
    const modules = (await this.entitlement.resolve(companyId)).modules;
    return buildCatalog().filter((c) => !c.module || modules.has(c.module)) as Array<CatalogNode & { risk: string }>;
  }

  async templates(ds: DataSource, companyId: string): Promise<TemplateView[]> {
    const modules = (await this.entitlement.resolve(companyId)).modules;
    const existing = new Set((await this.loadRoles(ds.manager)).map((r) => r.key));
    const out: TemplateView[] = [];
    for (const [module, list] of Object.entries(this.catalog)) {
      for (const t of list) {
        out.push({
          key: t.key,
          module,
          version: t.version ?? 1,
          titleCode: t.titleCode,
          entitled: modules.has(module),
          instantiated: existing.has(t.key),
          grants: t.grants.map((g) => ({ node: g.node, access: g.access })),
          criticalNodes: criticalNodesCovered(t.grants.map((g) => ({ node: g.node, access: g.access }))),
        });
      }
    }
    return out;
  }

  // ───────────────────────────── writes ─────────────────────────────

  /** Creates the Company's role from a catalog template (cloned at the template's current version). Never assigns it to anyone. */
  async createFromTemplate(actor: CompanyActor, companyId: string, ds: DataSource, templateKey: unknown): Promise<RoleView> {
    const tpl = this.findTemplate(typeof templateKey === 'string' ? templateKey : '');
    if (!tpl) throw new CompanyUserError('ROLE_NOT_FOUND', 'Unknown role template.');
    const modules = (await this.entitlement.resolve(companyId)).modules;
    if (!modules.has(tpl.module)) throw new CompanyUserError('NODE_NOT_ENTITLED', `The ${tpl.module} module is not part of this Company's package.`);
    const correlationId = randomUUID();
    const id = await ds.transaction(async (m) => {
      await lockAdministration(m, companyId);
      if ((await m.query(`SELECT 1 FROM "roles" WHERE "key" = $1`, [tpl.template.key])).length) throw new CompanyUserError('ROLE_EXISTS', 'A role with this key already exists in the Company.');
      const [{ id: roleId }] = await m.query(
        `INSERT INTO "roles" ("key", "type", "templateKey", "templateVersion", "customized", "createdBy") VALUES ($1, 'template', $1, $2, false, $3) RETURNING "id"`,
        [tpl.template.key, tpl.template.version ?? 1, actor.userId],
      );
      await this.writeGrants(m, roleId, tpl.template.grants.map((g) => ({ node: g.node, access: g.access })));
      await this.audit.record({ actorUserId: actor.userId, organizationId: null, action: 'role.created', resource: 'role', resourceId: roleId, result: 'success', correlationId, before: null, after: { key: tpl.template.key, type: 'template', templateVersion: tpl.template.version ?? 1, grants: tpl.template.grants } }, m);
      return roleId as string;
    });
    return (await this.detail(ds, companyId, id)).role;
  }

  async createCustom(actor: CompanyActor, companyId: string, ds: DataSource, input: RoleInput): Promise<RoleView> {
    const nameEn = str(input.nameEn, 120);
    const nameAr = str(input.nameAr, 120);
    if (!nameEn && !nameAr) throw new CompanyUserError('INVALID_INPUT', 'A role needs a name (English or Arabic).');
    const modules = (await this.entitlement.resolve(companyId)).modules;
    const { grants } = this.normalizeGrants(input.grants, null, modules);
    const correlationId = randomUUID();
    const id = await ds.transaction(async (m) => {
      await lockAdministration(m, companyId);
      this.assertCriticalHeld(actor, [], grants);
      const key = await this.freshKey(m, `custom.${slug(nameEn ?? nameAr ?? 'role') || 'role'}`);
      const [{ id: roleId }] = await m.query(
        `INSERT INTO "roles" ("key", "type", "nameEn", "nameAr", "descriptionEn", "descriptionAr", "createdBy") VALUES ($1, 'custom', $2, $3, $4, $5, $6) RETURNING "id"`,
        [key, nameEn, nameAr, str(input.descriptionEn, 2000), str(input.descriptionAr, 2000), actor.userId],
      );
      await this.writeGrants(m, roleId, grants);
      await this.audit.record({ actorUserId: actor.userId, organizationId: null, action: 'role.created', resource: 'role', resourceId: roleId, result: 'success', correlationId, before: null, after: { key, type: 'custom', nameEn, nameAr, grants } }, m);
      return roleId as string;
    });
    return (await this.detail(ds, companyId, id)).role;
  }

  async clone(actor: CompanyActor, companyId: string, ds: DataSource, roleId: string, input: { nameEn?: unknown; nameAr?: unknown }): Promise<RoleView> {
    const source = await this.requireRole(ds.manager, roleId);
    const grants = (await this.loadAllGrants(ds.manager, roleId)).get(roleId) ?? [];
    const nameEn = str(input.nameEn, 120) ?? (source.nameEn ? `${source.nameEn} (copy)` : `${source.key} (copy)`);
    const nameAr = str(input.nameAr, 120) ?? (source.nameAr ? `${source.nameAr} (نسخة)` : null);
    const correlationId = randomUUID();
    const id = await ds.transaction(async (m) => {
      await lockAdministration(m, companyId);
      this.assertCriticalHeld(actor, [], grants); // a clone reaches the same critical nodes
      const key = await this.freshKey(m, `custom.${slug(nameEn) || 'role'}`);
      const [{ id: newId }] = await m.query(
        `INSERT INTO "roles" ("key", "type", "nameEn", "nameAr", "descriptionEn", "descriptionAr", "createdBy") VALUES ($1, 'custom', $2, $3, $4, $5, $6) RETURNING "id"`,
        [key, nameEn, nameAr, source.descriptionEn, source.descriptionAr, actor.userId],
      );
      await this.writeGrants(m, newId, grants);
      await this.audit.record({ actorUserId: actor.userId, organizationId: null, action: 'role.cloned', resource: 'role', resourceId: newId, result: 'success', correlationId, before: { sourceRoleId: roleId, sourceKey: source.key }, after: { key, type: 'custom', grants } }, m);
      return newId as string;
    });
    return (await this.detail(ds, companyId, id)).role;
  }

  async update(actor: CompanyActor, companyId: string, ds: DataSource, roleId: string, input: RoleInput): Promise<{ role: RoleView; autoAdded: string[] }> {
    const modules = (await this.entitlement.resolve(companyId)).modules;
    const correlationId = randomUUID();
    let autoAdded: string[] = [];
    await ds.transaction(async (m) => {
      await lockAdministration(m, companyId);
      const role = await this.requireRole(m, roleId);
      if (PROTECTED.has(role.type)) throw new CompanyUserError('ROLE_PROTECTED', `${role.type === 'system' ? 'System' : 'Legacy'} roles cannot be edited.`);
      const before = (await this.loadAllGrants(m, roleId)).get(roleId) ?? [];
      const beforeMeta = { nameEn: role.nameEn, nameAr: role.nameAr, descriptionEn: role.descriptionEn, descriptionAr: role.descriptionAr, isActive: role.isActive };
      const meta = {
        nameEn: input.nameEn !== undefined ? str(input.nameEn, 120) : role.nameEn,
        nameAr: input.nameAr !== undefined ? str(input.nameAr, 120) : role.nameAr,
        descriptionEn: input.descriptionEn !== undefined ? str(input.descriptionEn, 2000) : role.descriptionEn,
        descriptionAr: input.descriptionAr !== undefined ? str(input.descriptionAr, 2000) : role.descriptionAr,
        isActive: input.isActive !== undefined ? input.isActive === true : role.isActive,
      };
      if (role.type === 'custom' && !meta.nameEn && !meta.nameAr) throw new CompanyUserError('INVALID_INPUT', 'A role needs a name.');
      let after = before;
      if (input.grants !== undefined) {
        const norm = this.normalizeGrants(input.grants, before, modules);
        after = norm.grants;
        autoAdded = norm.autoAdded;
        this.assertCriticalHeld(actor, before, after);
        await this.writeGrants(m, roleId, after, true);
      }
      const customized = role.type === 'template' ? await this.isCustomized(role.templateKey, after, role.templateVersion) : null;
      await m.query(
        `UPDATE "roles" SET "nameEn" = $2, "nameAr" = $3, "descriptionEn" = $4, "descriptionAr" = $5, "isActive" = $6, "customized" = $7, "updatedAt" = now() WHERE "id" = $1`,
        [roleId, meta.nameEn, meta.nameAr, meta.descriptionEn, meta.descriptionAr, meta.isActive, customized],
      );
      if (input.grants !== undefined) await this.assertAdministrationRemains(m, companyId);
      const d = this.diff(before, after);
      await this.audit.record({ actorUserId: actor.userId, organizationId: null, action: 'role.updated', resource: 'role', resourceId: roleId, result: 'success', correlationId, before: { ...beforeMeta, grants: before }, after: { ...meta, grants: after, grantsAdded: d.added, grantsRemoved: d.removed, grantsChanged: d.changed } }, m);
    });
    return { role: (await this.detail(ds, companyId, roleId)).role, autoAdded };
  }

  async remove(actor: CompanyActor, companyId: string, ds: DataSource, roleId: string): Promise<void> {
    const correlationId = randomUUID();
    await ds.transaction(async (m) => {
      await lockAdministration(m, companyId);
      const role = await this.requireRole(m, roleId);
      if (PROTECTED.has(role.type)) throw new CompanyUserError('ROLE_PROTECTED', `${role.type === 'system' ? 'System' : 'Legacy'} roles cannot be deleted.`);
      const [{ n }]: Array<{ n: number }> = await m.query(`SELECT count(*)::int AS n FROM "user_roles" WHERE "roleId" = $1`, [roleId]);
      if (n > 0) throw new CompanyUserError('ROLE_IN_USE', `This role is held by ${n} member(s); remove it from them first.`, { members: n });
      const before = (await this.loadAllGrants(m, roleId)).get(roleId) ?? [];
      await m.query(`DELETE FROM "role_permissions" WHERE "roleId" = $1`, [roleId]);
      await m.query(`DELETE FROM "roles" WHERE "id" = $1`, [roleId]);
      await this.audit.record({ actorUserId: actor.userId, organizationId: null, action: 'role.deleted', resource: 'role', resourceId: roleId, result: 'success', correlationId, before: { key: role.key, type: role.type, grants: before }, after: null }, m);
    });
  }

  // ───────────────────────────── template lifecycle ─────────────────────────────

  async templateUpdate(ds: DataSource, roleId: string): Promise<TemplateDiff | null> {
    const role = await this.requireRole(ds.manager, roleId);
    return this.computeDiff(ds.manager, role);
  }

  /** Apply the offered update: `'all'` or a list of nodes. Only additions and level raises are applied; never a removal; never to a customised role. */
  async applyTemplateUpdate(actor: CompanyActor, companyId: string, ds: DataSource, roleId: string, selection: unknown): Promise<RoleView> {
    const modules = (await this.entitlement.resolve(companyId)).modules;
    const correlationId = randomUUID();
    await ds.transaction(async (m) => {
      await lockAdministration(m, companyId);
      const role = await this.requireRole(m, roleId);
      const diff = await this.computeDiff(m, role);
      if (!diff) throw new CompanyUserError('NO_TEMPLATE_UPDATE', 'There is no template update to apply for this role.');
      if (diff.customized) throw new CompanyUserError('ROLE_CUSTOMIZED', 'This role was customised; template updates are informational only.', { diff });
      const all = selection === 'all';
      const wanted = new Set(Array.isArray(selection) ? (selection as unknown[]).filter((x): x is string => typeof x === 'string') : []);
      if (!all && wanted.size === 0) throw new CompanyUserError('INVALID_INPUT', 'Choose "all" or a list of nodes to apply.');
      const before = (await this.loadAllGrants(m, roleId)).get(roleId) ?? [];
      const next = new Map(before.map((g) => [g.node, g.access] as const));
      const applied: string[] = [];
      for (const g of diff.added) if (all || wanted.has(g.node)) { this.assertEntitledAdd(g.node, modules); next.set(g.node, g.access); applied.push(g.node); }
      for (const c of diff.changed) if (all || wanted.has(c.node)) { next.set(c.node, c.to as Grant['access']); applied.push(c.node); }
      const after = [...next].map(([node, access]) => ({ node, access }));
      this.assertCriticalHeld(actor, before, after);
      await this.writeGrants(m, roleId, after, true);
      const complete = all || (diff.added.every((g) => wanted.has(g.node)) && diff.changed.every((c) => wanted.has(c.node)));
      await m.query(`UPDATE "roles" SET "templateVersion" = $2, "customized" = false, "updatedAt" = now() WHERE "id" = $1`, [roleId, complete ? diff.toVersion : role.templateVersion]);
      await this.audit.record({ actorUserId: actor.userId, organizationId: null, action: 'role.template_upgraded', resource: 'role', resourceId: roleId, result: 'success', correlationId, before: { templateVersion: role.templateVersion, grants: before }, after: { templateVersion: complete ? diff.toVersion : role.templateVersion, applied, grants: after } }, m);
    });
    return (await this.detail(ds, companyId, roleId)).role;
  }

  async ignoreTemplateUpdate(actor: CompanyActor, companyId: string, ds: DataSource, roleId: string): Promise<RoleView> {
    await ds.transaction(async (m) => {
      const role = await this.requireRole(m, roleId);
      const diff = await this.computeDiff(m, role);
      if (!diff) throw new CompanyUserError('NO_TEMPLATE_UPDATE', 'There is no template update to ignore for this role.');
      await m.query(`UPDATE "roles" SET "templateIgnoredVersion" = $2, "updatedAt" = now() WHERE "id" = $1`, [roleId, diff.toVersion]);
      await this.audit.record({ actorUserId: actor.userId, organizationId: null, action: 'role.template_ignored', resource: 'role', resourceId: roleId, result: 'success', correlationId: randomUUID(), before: { templateVersion: role.templateVersion }, after: { ignoredVersion: diff.toVersion } }, m);
    });
    return (await this.detail(ds, companyId, roleId)).role;
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private findTemplate(key: string): { module: string; template: RoleTemplate } | null {
    for (const [module, list] of Object.entries(this.catalog)) {
      const template = list.find((t) => t.key === key);
      if (template) return { module, template };
    }
    return null;
  }

  private async loadRoles(m: EntityManager): Promise<RoleRow[]> {
    return m.query(`SELECT "id", "key", "type", "nameEn", "nameAr", "descriptionEn", "descriptionAr", "isActive", "templateKey", "templateVersion", "templateIgnoredVersion", "customized" FROM "roles"`);
  }

  private async requireRole(m: EntityManager, roleId: string): Promise<RoleRow> {
    if (!/^[0-9a-f-]{36}$/i.test(roleId)) throw new CompanyUserError('ROLE_NOT_FOUND', 'Role not found.');
    const rows: RoleRow[] = await m.query(
      `SELECT "id", "key", "type", "nameEn", "nameAr", "descriptionEn", "descriptionAr", "isActive", "templateKey", "templateVersion", "templateIgnoredVersion", "customized" FROM "roles" WHERE "id" = $1`,
      [roleId],
    );
    if (!rows[0]) throw new CompanyUserError('ROLE_NOT_FOUND', 'Role not found.');
    return rows[0];
  }

  private async loadAllGrants(m: EntityManager, roleId?: string): Promise<Map<string, Grant[]>> {
    const rows: Array<{ roleId: string; nodeKey: string; access: Grant['access'] }> = roleId
      ? await m.query(`SELECT "roleId", "nodeKey", "access" FROM "role_permissions" WHERE "roleId" = $1 ORDER BY "nodeKey"`, [roleId])
      : await m.query(`SELECT "roleId", "nodeKey", "access" FROM "role_permissions" ORDER BY "nodeKey"`);
    const out = new Map<string, Grant[]>();
    for (const r of rows) out.set(r.roleId, [...(out.get(r.roleId) ?? []), { node: r.nodeKey, access: r.access }]);
    return out;
  }

  private async toView(m: EntityManager, r: RoleRow, grants: Grant[], memberCount: number, modules: ReadonlySet<string>): Promise<RoleView> {
    let customized = r.customized;
    if (r.type === 'template' && customized === null) {
      customized = await this.isCustomized(r.templateKey, grants, r.templateVersion);
      await m.query(`UPDATE "roles" SET "customized" = $2 WHERE "id" = $1`, [r.id, customized]); // evaluated once, then kept current by the editor
    }
    const tpl = r.templateKey ? this.findTemplate(r.templateKey) : null;
    const diffAvail = r.type === 'template' && tpl ? (tpl.template.version ?? 1) > (r.templateVersion ?? 1) && (tpl.template.version ?? 1) > (r.templateIgnoredVersion ?? 0) : false;
    return {
      id: r.id, key: r.key, type: r.type, titleCode: roleTitleCode(r.key), nameEn: r.nameEn, nameAr: r.nameAr, descriptionEn: r.descriptionEn, descriptionAr: r.descriptionAr, isActive: r.isActive,
      templateKey: r.templateKey, templateVersion: r.templateVersion, customized, memberCount, grantCount: grants.length, criticalNodes: criticalNodesCovered(grants),
      templateUpdateAvailable: diffAvail, moduleEntitled: tpl ? modules.has(tpl.module) : null,
    };
  }

  private grantView(g: Grant, modules: ReadonlySet<string>): RoleGrantView {
    const meta = buildCatalog().find((c) => c.node === g.node);
    const module = moduleOfNode(g.node);
    return { ...g, titleEn: meta?.titleEn ?? g.node, titleAr: meta?.titleAr ?? g.node, risk: meta?.risk ?? 'low', module, dormant: !!module && !modules.has(module) };
  }

  /**
   * Do a template role's grants diverge from its template? Evaluated against the CURRENT catalog only when the role is at that version; if the catalog has
   * moved on and we never recorded the answer, we cannot know what the old template said, so the role is treated as customised (conservative: it is then never
   * auto-touched). New roles from the seeder / "from template" record `customized = false` at creation, so this fallback only concerns pre-F3 rows.
   */
  private async isCustomized(templateKey: string | null, grants: readonly Grant[], roleVersion: number | null): Promise<boolean> {
    const tpl = templateKey ? this.findTemplate(templateKey) : null;
    if (!tpl) return true;
    if ((tpl.template.version ?? 1) !== (roleVersion ?? 1)) return true;
    const a = new Map(grants.map((g) => [g.node, g.access]));
    if (a.size !== tpl.template.grants.length) return true;
    return tpl.template.grants.some((g) => a.get(g.node) !== g.access);
  }

  /** Validates a grant list from the client: known nodes, valid levels, entitlement for what is NEW, and `view` auto-completion. `hidden` removes a grant. */
  private normalizeGrants(input: unknown, existing: readonly Grant[] | null, modules: ReadonlySet<string>): { grants: Grant[]; autoAdded: string[] } {
    if (!Array.isArray(input)) throw new CompanyUserError('INVALID_INPUT', 'grants must be a list of { node, access }.');
    const catalog = new Set(buildCatalog().map((c) => c.node));
    const prior = new Map((existing ?? []).map((g) => [g.node, g.access] as const));
    const next = new Map<string, Grant['access']>();
    for (const raw of input as Array<Record<string, unknown>>) {
      const node = typeof raw?.node === 'string' ? raw.node : '';
      const access = raw?.access;
      if (access === 'hidden') continue;
      if (access !== 'read-only' && access !== 'editable') throw new CompanyUserError('INVALID_INPUT', `Invalid access level for ${node}.`);
      if (!catalog.has(node) && prior.get(node) === undefined) throw new CompanyUserError('UNKNOWN_NODE', `Unknown permission node: ${node}.`);
      next.set(node, access);
    }
    for (const [node, access] of next) if (prior.get(node) !== access) this.assertEntitledAdd(node, modules);
    const autoAdded: string[] = [];
    for (const [node, access] of [...next]) {
      if (access !== 'editable') continue;
      const parts = node.split('.');
      if (parts.length < 3 || parts[parts.length - 1] === 'view') continue;
      const view = `${parts.slice(0, -1).join('.')}.view`;
      if (catalog.has(view) && !this.reaches(next, view)) {
        this.assertEntitledAdd(view, modules);
        next.set(view, 'read-only');
        autoAdded.push(view);
      }
    }
    return { grants: [...next].map(([node, access]) => ({ node, access })), autoAdded };
  }

  private reaches(grants: ReadonlyMap<string, Grant['access']>, node: string): boolean {
    const parts = node.split('.');
    for (let i = parts.length; i > 0; i--) if (grants.has(parts.slice(0, i).join('.'))) return true;
    return false;
  }

  private assertEntitledAdd(node: string, modules: ReadonlySet<string>): void {
    const module = moduleOfNode(node);
    if (module && !modules.has(module)) throw new CompanyUserError('NODE_NOT_ENTITLED', `${node} belongs to the ${module} module, which is not part of this Company's package.`, { node, module });
  }

  /** A definition may NEWLY reach a critical node only if the editor holds it explicitly. */
  private assertCriticalHeld(actor: CompanyActor, before: readonly Grant[], after: readonly Grant[]): void {
    const had = new Set(criticalNodesCovered(before));
    const lacking = criticalNodesCovered(after).filter((n) => !had.has(n) && !actor.authz.hasAtLeast(n, 'editable'));
    if (lacking.length) throw new CompanyUserError('ROLE_EXCEEDS_GRANTOR', 'A role can newly reach critical permissions only through someone who holds them explicitly.', { criticalNodes: lacking });
  }

  private async writeGrants(m: EntityManager, roleId: string, grants: readonly Grant[], replace = false): Promise<void> {
    if (replace) {
      await m.query(`DELETE FROM "role_permissions" WHERE "roleId" = $1 AND NOT ("nodeKey" = ANY($2::text[]))`, [roleId, grants.map((g) => g.node)]);
    }
    for (const g of grants) {
      await m.query(
        `INSERT INTO "role_permissions" ("roleId", "nodeKey", "access") VALUES ($1, $2, $3) ON CONFLICT ("roleId", "nodeKey") DO UPDATE SET "access" = EXCLUDED."access"`,
        [roleId, g.node, g.access],
      );
    }
  }

  private async freshKey(m: EntityManager, base: string): Promise<string> {
    for (let i = 0; i < 50; i++) {
      const key = (i === 0 ? base : `${base}_${i + 1}`).slice(0, 64);
      if (!(await m.query(`SELECT 1 FROM "roles" WHERE "key" = $1`, [key])).length) return key;
    }
    return `${base.slice(0, 50)}_${randomUUID().slice(0, 8)}`;
  }

  private diff(before: readonly Grant[], after: readonly Grant[]): { added: Grant[]; removed: Grant[]; changed: Array<{ node: string; from: string; to: string }> } {
    const a = new Map(before.map((g) => [g.node, g.access] as const));
    const b = new Map(after.map((g) => [g.node, g.access] as const));
    return {
      added: after.filter((g) => !a.has(g.node)),
      removed: before.filter((g) => !b.has(g.node)),
      changed: after.filter((g) => a.has(g.node) && a.get(g.node) !== g.access).map((g) => ({ node: g.node, from: a.get(g.node) as string, to: g.access })),
    };
  }

  private async computeDiff(m: EntityManager, role: RoleRow): Promise<TemplateDiff | null> {
    if (role.type !== 'template' || !role.templateKey) return null;
    const tpl = this.findTemplate(role.templateKey);
    if (!tpl) return null;
    const toVersion = tpl.template.version ?? 1;
    const fromVersion = role.templateVersion ?? 1;
    if (toVersion <= fromVersion || toVersion <= (role.templateIgnoredVersion ?? 0)) return null;
    const current = (await this.loadAllGrants(m, role.id)).get(role.id) ?? [];
    const target: Grant[] = tpl.template.grants.map((g) => ({ node: g.node, access: g.access }));
    const customized = role.customized ?? (await this.isCustomized(role.templateKey, current, role.templateVersion));
    const cur = new Map(current.map((g) => [g.node, g.access] as const));
    const added = target.filter((g) => !cur.has(g.node));
    const changed = target.filter((g) => cur.has(g.node) && cur.get(g.node) !== g.access).map((g) => ({ node: g.node, from: cur.get(g.node) as string, to: g.access }));
    const tgt = new Set(target.map((g) => g.node));
    const removedFromTemplate = current.filter((g) => !tgt.has(g.node));
    const introducesCritical = criticalNodesCovered([...current.filter((g) => !changed.some((c) => c.node === g.node)), ...added, ...changed.map((c) => ({ node: c.node, access: c.to as Grant['access'] }))]).filter((n) => !criticalNodesCovered(current).includes(n));
    return { roleId: role.id, templateKey: role.templateKey, fromVersion, toVersion, customized, added, changed, removedFromTemplate, introducesCritical };
  }

  /**
   * After an edit, at least one ACTIVE member must still be able to manage users AND roles. Evaluated on the real effective grants of the members that hold
   * either node (through any role), inside the same Company transaction as the edit — a violation rolls the edit back.
   */
  private async assertAdministrationRemains(m: EntityManager, companyId: string): Promise<void> {
    const candidates: Array<{ userId: string }> = await m.query(
      `SELECT DISTINCT ur."userId" AS "userId" FROM "user_roles" ur INNER JOIN "role_permissions" rp ON rp."roleId" = ur."roleId"
        WHERE rp."access" = 'editable' AND (rp."nodeKey" = ANY($1::text[]))`,
      [[...ancestors(COMPANY_MEMBERS_MANAGE_NODE), ...ancestors(COMPANY_ROLES_MANAGE_NODE)]],
    );
    const activeIds = new Set((await this.memberships.findByCompany(companyId)).filter((x) => x.status === 'active').map((x) => x.userId));
    for (const c of candidates) {
      if (!activeIds.has(c.userId)) continue;
      const ctx = await this.contexts.load(c.userId, companyId, m);
      if (ctx.hasAtLeast(COMPANY_MEMBERS_MANAGE_NODE, 'editable') && ctx.hasAtLeast(COMPANY_ROLES_MANAGE_NODE, 'editable')) return;
    }
    throw new CompanyUserError('ADMINISTRATION_WOULD_BE_LOST', 'This change would leave the Company without an active member who can manage users and roles.');
  }

}

interface RoleRow {
  id: string;
  key: string;
  type: RoleKind;
  nameEn: string | null;
  nameAr: string | null;
  descriptionEn: string | null;
  descriptionAr: string | null;
  isActive: boolean;
  templateKey: string | null;
  templateVersion: number | null;
  templateIgnoredVersion: number | null;
  customized: boolean | null;
}

function ancestors(node: string): string[] {
  const parts = node.split('.');
  const out: string[] = [];
  for (let i = parts.length; i > 0; i--) out.push(parts.slice(0, i).join('.'));
  return out;
}

