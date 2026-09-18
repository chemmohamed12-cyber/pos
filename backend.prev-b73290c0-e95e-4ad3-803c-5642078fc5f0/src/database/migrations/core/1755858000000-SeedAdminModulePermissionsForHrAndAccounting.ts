import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ADR-039 (RC-2) — corrective migration. The `admin` role is an `is_system`
 * role that acquires each module's access by an explicit `role_permissions`
 * grant, written one migration at a time as each engine/module is built
 * (`1755852800000` → `system.release.backup`, `1755853300000` → `core.config`,
 * `1755853500000-BackfillLegacyRolePermissions` → `sales`/`inventory`/
 * `logistics`/`finance`/`reporting`, `1755855500000` → `core.approval`, …).
 *
 * `hr` (ADR-029, promoted 2026-09-07) and `accounting` (ADR-032, Financial
 * Core F01+) were promoted AFTER `1755853500000` and no migration ever
 * extended `admin` for them — so an `admin`-only user gets 404 (PermissionGuard
 * anti-enumeration) on every `hr.*` / `accounting.*` route even though both
 * modules are entitled. `TENANT_ENTITLEMENT_PERMISSION_MODEL.md §5`: `admin`
 * "cannot be deleted, only **extended**." This migration performs that
 * extension, in the exact idiom of the nine existing `admin` grants.
 *
 * This is a Permission-axis change ONLY. It does NOT entitle a module: an
 * un-entitled `hr`/`accounting` still 404s at `RequireModuleGuard`, which runs
 * BEFORE `PermissionGuard`. No `if admin`, no bypass, no engine change.
 */
export class SeedAdminModulePermissionsForHrAndAccounting1755858000000 implements MigrationInterface {
  name = 'SeedAdminModulePermissionsForHrAndAccounting1755858000000';

  private readonly nodes = ['hr', 'accounting'];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const node of this.nodes) {
      await queryRunner.query(
        `INSERT INTO "role_permissions" ("roleId", "nodeKey", "access")
         SELECT "id", $1, 'editable' FROM "roles" WHERE "key" = 'admin'
         ON CONFLICT DO NOTHING`,
        [node],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "role_permissions"
       WHERE "nodeKey" = ANY($1)
         AND "roleId" = (SELECT "id" FROM "roles" WHERE "key" = 'admin')`,
      [this.nodes],
    );
  }
}
