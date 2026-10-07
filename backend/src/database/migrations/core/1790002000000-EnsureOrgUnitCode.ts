import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Authorization Program F1.5 (2026-10-07) — `org_units.code` must exist in EVERY database that holds an org tree.
 *
 * The column was added only by the HR-tagged migration `1789710000000-RetireHrDepartmentsIntoOrgUnits` (departments became org units), so a Company
 * WITHOUT the HR module has an `org_units` table that the `OrgUnit` entity cannot read (`column "code" does not exist`). That was latent while the
 * organization HTTP surface read the ambient tables; F1.5 moves it to the Company's own database, where the gap would surface on every Company
 * lacking HR. Additive and idempotent: no data change, no effect where the column already exists.
 */
export class EnsureOrgUnitCode1790002000000 implements MigrationInterface {
  name = 'EnsureOrgUnitCode1790002000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "org_units" ADD COLUMN IF NOT EXISTS "code" VARCHAR(32)`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_org_units_code" ON "org_units" ("code") WHERE "code" IS NOT NULL`);
  }

  public async down(): Promise<void> {
    // intentionally a no-op: the column/index are owned by the HR migration where HR is installed; dropping them here could destroy department codes
  }
}
