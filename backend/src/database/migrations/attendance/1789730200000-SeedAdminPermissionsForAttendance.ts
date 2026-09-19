import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ADR-039 (RC-2) precedent, applied to the newest module: `admin` is an
 * `is_system` role that only acquires a module's access via an explicit
 * `role_permissions` grant — see `1755858000000-
 * SeedAdminModulePermissionsForHrAndAccounting.ts` (`hr`/`accounting`)
 * and `1789700200000-SeedAdminPermissionsForProcurement.ts`
 * (`procurement`), the exact same corrective migration each time a
 * module is promoted/added. Without this, an `admin`-only user gets 404
 * (`PermissionGuard` anti-enumeration) on every `attendance.*` route
 * even though `attendance` is entitled. Permission-axis change ONLY —
 * does not entitle the module.
 */
export class SeedAdminPermissionsForAttendance1789730200000 implements MigrationInterface {
  name = 'SeedAdminPermissionsForAttendance1789730200000';

  private readonly node = 'attendance';

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
