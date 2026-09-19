import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ADR-039 (RC-2) precedent, applied to `manufacturing` (ADR-061) — the same
 * exact corrective migration `SeedAdminPermissionsForProcurement` already
 * used: `admin` is an `is_system` role that only acquires a module's
 * access via an explicit `role_permissions` grant. Without this, an
 * `admin`-only user gets 404 (PermissionGuard anti-enumeration) on every
 * `manufacturing.*` route even though `manufacturing` is entitled.
 * Permission-axis change ONLY — does not entitle the module or the
 * `manufacturing.work_orders` feature (those are separate axes).
 */
export class SeedAdminPermissionsForManufacturing1789732000000 implements MigrationInterface {
  name = 'SeedAdminPermissionsForManufacturing1789732000000';

  private readonly node = 'manufacturing';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `INSERT INTO "role_permissions" ("roleId", "nodeKey", "access")
       SELECT "id", $1, 'editable' FROM "roles" WHERE "key" = 'admin'
       ON CONFLICT DO NOTHING`,
      [this.node],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "role_permissions"
       WHERE "nodeKey" = $1
         AND "roleId" = (SELECT "id" FROM "roles" WHERE "key" = 'admin')`,
      [this.node],
    );
  }
}
