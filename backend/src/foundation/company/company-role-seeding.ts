import { DataSource } from 'typeorm';
import { Role } from '../authorization/role.entity';
import { RolePermission } from '../permission/role-permission.entity';
import { ModuleRoleTemplateSeeder } from '../module-role-templates/module-role-template.seeder';
import { DatabaseConfig } from '../configuration/app-config.service';

export interface CompanyRoleSeedResult {
  roles: number;
  grants: number;
}

/**
 * Multi-Company Phase 3 V7, Area 6 (Authorization Boundary). Reuses
 * `ModuleRoleTemplateSeeder` completely UNMODIFIED — its `seedForModule()`
 * only ever touches the two repositories passed to its constructor, so
 * constructing it against a purpose-built DataSource pointed at a
 * Company's own database (rather than the app's injected one) is enough
 * to seed that Company's own `roles`/`role_permissions` tables from the
 * existing, in-code `MODULE_ROLE_TEMPLATES` catalog. Exactly the same
 * reuse pattern as Area 16's `runMigrationsForDatabase` and Area 4's
 * reuse of `ReleaseHealthCheckService`.
 *
 * Which module codes to seed is NOT decided here — resolving a Company's
 * entitled modules is Area 7's job (Edition/Entitlement per Company),
 * not yet built. The caller supplies the list explicitly; this function
 * only proves the seeding MECHANISM works against an arbitrary Company
 * database, per Area 6's own literal scope.
 *
 * `entities: [Role, RolePermission]` is passed explicitly (rather than
 * relying on the app-wide glob every other DataSource in this codebase
 * uses) because this DataSource is deliberately narrow — it has no
 * business touching any other table in the Company's database.
 */
export async function seedCompanyRoleTemplates(database: DatabaseConfig, moduleCodes: readonly string[]): Promise<CompanyRoleSeedResult> {
  const dataSource = new DataSource({ type: 'postgres', ...database, entities: [Role, RolePermission], synchronize: false, logging: false });
  await dataSource.initialize();
  try {
    const seeder = new ModuleRoleTemplateSeeder(dataSource.getRepository(Role), dataSource.getRepository(RolePermission));
    let roles = 0;
    let grants = 0;
    for (const code of moduleCodes) {
      const r = await seeder.seedForModule(code);
      roles += r.roles;
      grants += r.grants;
    }
    return { roles, grants };
  } finally {
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  }
}

export interface CompanyAdminRoleSeedResult {
  /** Whether the `admin` Role row was newly created this call (false on a repeat/idempotent call). */
  created: boolean;
  grants: number;
}

/** The literal, always-entitled node §3.1 verified against the real permission engine — never a wildcard, and not part of `MODULE_ROLE_TEMPLATES` (Area 6/20 CTO decision, 2026-09-24). */
export { COMPANY_MEMBERS_MANAGE_NODE, COMPANY_ROLES_MANAGE_NODE, COMPANY_BACKUP_MANAGE_NODE, COMPANY_AUDIT_VIEW_NODE } from '../permission/company-nodes';
import { COMPANY_MEMBERS_MANAGE_NODE, COMPANY_ROLES_MANAGE_NODE, COMPANY_BACKUP_MANAGE_NODE, COMPANY_AUDIT_VIEW_NODE, COMPANY_ADMINISTRATION_NODES } from '../permission/company-nodes';
import { COMPANY_ADMIN_ROLE_KEY, COMPANY_ADMIN_ROLE_META } from '../module-registry/role-templates';
import { WORKFLOW_NODES } from '../authorization/workflow-rules';
/** Backup/DR Architecture V1 (2026-09-24, Track D §Step 10) — same grandfathered `core.*` node convention as `COMPANY_MEMBERS_MANAGE_NODE` above, never a wildcard. */
/** Area 14 (2026-09-25, CTO Implementation Gate) — same literal-node discipline as the two above, never a wildcard. Read-only: gates `CompanyAuditController`'s query/export surface. */

/**
 * Multi-Company Area 20/Membership-Management (2026-09-24, §3.1 verified
 * decision). Deliberately NOT a `MODULE_ROLE_TEMPLATES` entry and NOT
 * routed through `ModuleRoleTemplateSeeder` — `admin` is not a business
 * module role, and folding it into that catalog would make it behave like
 * one (subject to entitlement/module-enable semantics it has no business
 * being subject to). §3.1 verified there is no wildcard grant in this
 * permission engine (`ancestorChain` walks dotted prefixes only, no `'*'`
 * special case) — "administrator" is therefore built the only way the
 * engine actually supports: one real, literal grant per module the
 * Company is ACTUALLY being seeded with (the exact same
 * `{node: moduleCode, access: 'editable'}` shape `sales.manager` etc.
 * already use), computed from the caller's own `moduleCodes` so it can
 * never drift out of sync with what this specific Company has — plus the
 * always-present `core.company.members.manage` and `core.company.backup.manage`
 * grants (the latter added for Track D, 2026-09-24). Idempotent: repeat
 * calls neither duplicate the `Role` row nor duplicate any grant.
 *
 * Same narrow, purpose-built-DataSource pattern as `seedCompanyRoleTemplates`
 * — a separate connection, not a shared one, keeping this function's
 * blast radius limited to `roles`/`role_permissions` exactly like its
 * sibling.
 */
export async function seedCompanyAdminRole(database: DatabaseConfig, moduleCodes: readonly string[]): Promise<CompanyAdminRoleSeedResult> {
  const dataSource = new DataSource({ type: 'postgres', ...database, entities: [Role, RolePermission], synchronize: false, logging: false });
  await dataSource.initialize();
  try {
    const roleRepo = dataSource.getRepository(Role);
    const permRepo = dataSource.getRepository(RolePermission);

    let role = await roleRepo.findOne({ where: { key: 'admin' } });
    const created = !role;
    if (!role) {
      role = await roleRepo.save(roleRepo.create({ key: 'admin', type: 'legacy', nameEn: 'Legacy Administrator (Operational)', nameAr: 'مدير تشغيلي (قديم)' }));
    }

    // F5: the legacy administrator also holds every workflow capability (it passed every role-list check implicitly).
    const nodes = [...moduleCodes, COMPANY_MEMBERS_MANAGE_NODE, COMPANY_ROLES_MANAGE_NODE, COMPANY_BACKUP_MANAGE_NODE, COMPANY_AUDIT_VIEW_NODE, ...WORKFLOW_NODES];
    let grants = 0;
    for (const node of nodes) {
      const existing = await permRepo.findOne({ where: { roleId: role.id, nodeKey: node } });
      if (!existing) {
        await permRepo.save(permRepo.create({ roleId: role.id, nodeKey: node, access: 'editable' }));
        grants++;
      }
    }
    return { created, grants };
  } finally {
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  }
}

/**
 * F3 / D17 — seeds the Company ADMINISTRATION system role `company_admin` (idempotent): the four `core.company.*` administration nodes at `editable`
 * and NOTHING operational — no module-wide grant, no critical node. Unlike `seedCompanyAdminRole` it never extends with the Company's modules, and a package
 * upgrade never adds to it (the only automatic grants to an administrator are administration nodes, Blueprint E2/A3).
 */
export async function seedCompanyAdministratorRole(database: DatabaseConfig): Promise<CompanyAdminRoleSeedResult> {
  const dataSource = new DataSource({ type: 'postgres', ...database, entities: [Role, RolePermission], synchronize: false, logging: false });
  await dataSource.initialize();
  try {
    const roleRepo = dataSource.getRepository(Role);
    const permRepo = dataSource.getRepository(RolePermission);
    let role = await roleRepo.findOne({ where: { key: COMPANY_ADMIN_ROLE_KEY } });
    const created = !role;
    if (!role) role = await roleRepo.save(roleRepo.create({ key: COMPANY_ADMIN_ROLE_KEY, type: 'system', ...COMPANY_ADMIN_ROLE_META }));
    let grants = 0;
    for (const node of COMPANY_ADMINISTRATION_NODES) {
      if (!(await permRepo.findOne({ where: { roleId: role.id, nodeKey: node } }))) {
        await permRepo.save(permRepo.create({ roleId: role.id, nodeKey: node, access: 'editable' }));
        grants++;
      }
    }
    return { created, grants };
  } finally {
    if (dataSource.isInitialized) await dataSource.destroy();
  }
}
