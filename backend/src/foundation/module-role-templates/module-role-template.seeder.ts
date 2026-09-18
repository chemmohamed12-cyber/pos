import { Inject, Injectable, Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Role } from '../authorization/role.entity';
import { RolePermission } from '../permission/role-permission.entity';
import { MODULE_ROLE_TEMPLATES } from '../module-registry/role-templates';
import { ENTITLEMENT_RESOLVER, EntitlementResolver } from '../module-registry/entitlement-resolver.token';

/**
 * ERP Foundation — P4 F2. Seeds the per-module system role templates
 * (`role-templates.ts`) into `roles` + `role_permissions`, idempotently, for
 * every currently-ENTITLED module on boot. P6's "enable Module" deploy step
 * calls `seedForModule()` for a newly-enabled module.
 *
 * The templates are seeded as ordinary roles the customer then owns and may
 * edit (TENANT_ENTITLEMENT_PERMISSION_MODEL.md §5). Existing role rows /
 * user_role assignments are never touched — this only ADDS role keys and
 * node grants that are missing.
 *
 * ADR-039 (RC-1 fix): this runs on `onApplicationBootstrap`, NOT `onModuleInit`.
 * `EntitlementService` populates its cache in its own `onModuleInit`
 * (`await reload()`). Because `EntitlementModule` is `@Global()`, an explicit
 * import does NOT reorder `onModuleInit` hooks — the seeder used to run first,
 * read a cold `coreOnly('invalid')` cache, see nothing entitled, and silently
 * seed nothing. Nest guarantees EVERY module's `onModuleInit` has completed
 * before ANY `onApplicationBootstrap` fires, so by this hook the entitlement
 * cache is loaded. A fail-closed guard remains for any residual not-ready state.
 */
@Injectable()
export class ModuleRoleTemplateSeeder implements OnApplicationBootstrap {
  private readonly logger = new Logger(ModuleRoleTemplateSeeder.name);

  constructor(
    @InjectRepository(Role) private readonly roles: Repository<Role>,
    @InjectRepository(RolePermission) private readonly rolePermissions: Repository<RolePermission>,
    @Optional() @Inject(ENTITLEMENT_RESOLVER) private readonly entitlement?: EntitlementResolver,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // ADR-039 (RC-1 fix). Runs after every `onModuleInit` (incl.
    // `EntitlementService.reload()`), so the entitlement cache is loaded.
    // Guard anyway — NEVER seed against a cold / non-active cache
    // (`coreOnly('invalid')` → `status: 'suspended'`, or a genuinely invalid
    // manifest). Fail CLOSED: no seeding, a loud WARN, no "assume entitled".
    // `activeEditionCode()` is `''` ONLY in the cold/suspended `coreOnly`
    // state; any loaded state (implicit-standard or a real manifest) returns a
    // non-empty edition code.
    if (this.entitlement && !this.entitlement.activeEditionCode()) {
      this.logger.warn(
        'module role templates: entitlement state is not ready/active (no active edition) — skipping seed this boot. ' +
          'Templates will seed on the next boot once entitlement resolves, or on the module-enable deploy step. Seed count: 0.',
      );
      return;
    }

    const modules = Object.keys(MODULE_ROLE_TEMPLATES).filter((code) =>
      // `this.entitlement` is always bound in the real (`@Global`) app; the
      // `: true` branch is the pre-P3 "no entitlement engine at all" contract
      // (kept for the existing unit test — unreachable in the running app).
      this.entitlement ? this.entitlement.isModuleEntitled(code) : true,
    );
    let seededRoles = 0;
    let seededGrants = 0;
    for (const code of modules) {
      const r = await this.seedForModule(code);
      seededRoles += r.roles;
      seededGrants += r.grants;
    }
    // ADR-039 (RC-1 fix): ALWAYS log the outcome, including a 0/0 seed count,
    // so a silent no-seed can never happen again.
    this.logger.log(
      `module role templates: +${seededRoles} role(s), +${seededGrants} grant(s) across ${modules.length} entitled module(s)`,
    );
  }

  async seedForModule(moduleCode: string): Promise<{ roles: number; grants: number }> {
    const templates = MODULE_ROLE_TEMPLATES[moduleCode] ?? [];
    let roles = 0;
    let grants = 0;
    for (const t of templates) {
      let role = await this.roles.findOne({ where: { key: t.key } });
      if (!role) {
        role = await this.roles.save(this.roles.create({ key: t.key }));
        roles++;
      }
      for (const g of t.grants) {
        const existing = await this.rolePermissions.findOne({ where: { roleId: role.id, nodeKey: g.node } });
        if (!existing) {
          await this.rolePermissions.save(this.rolePermissions.create({ roleId: role.id, nodeKey: g.node, access: g.access }));
          grants++;
        }
      }
    }
    return { roles, grants };
  }
}
