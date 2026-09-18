import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Warehouse & Inventory Control UX/UI V1 (CTO directive) — two new roles
 * the directive explicitly calls for that didn't exist yet: Warehouse
 * Supervisor (approves issue/transfer/adjustment transactions) and
 * Inventory Controller (runs/approves stock counts). Role is data, not
 * an enum (see `role.entity.ts`'s own doc comment) — same seeding
 * pattern as `1755840300000-CreateAuthorizationTables.ts`'s original
 * six roles, just a later migration adding two more rows.
 */
export class SeedWarehouseRoles1755846500000 implements MigrationInterface {
  name = 'SeedWarehouseRoles1755846500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const keys = ['warehouse_supervisor', 'inventory_controller'];
    for (const key of keys) {
      await queryRunner.query(`INSERT INTO "roles" ("key") VALUES ($1) ON CONFLICT DO NOTHING`, [key]);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "roles" WHERE "key" = ANY($1)`, [['warehouse_supervisor', 'inventory_controller']]);
  }
}
