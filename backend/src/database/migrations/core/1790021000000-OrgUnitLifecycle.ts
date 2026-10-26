import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Enterprise Organizational Structure Engine — Stage 1 (CTO Gate 0 approval 2026-10-22).
 * Additive and behaviour-preserving: every existing unit becomes `active`; nothing is moved, renamed or deleted.
 *  - `status` / `archivedAt`: a unit that documents point to is ARCHIVED, never deleted.
 *  - `parentId` FK: ON DELETE CASCADE -> RESTRICT, so a parent can no longer silently take its subtree (and the records pointing to it) with it.
 *  - one ACTIVE root of type `company` per Company database — created only where the data already satisfies it. A database that still holds several roots
 *    keeps working (the service refuses to create another); the reconciliation step merges them and creates the index afterwards.
 */
export class OrgUnitLifecycle1790021000000 implements MigrationInterface {
  name = 'OrgUnitLifecycle1790021000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "org_units" ADD COLUMN IF NOT EXISTS "status" VARCHAR(16) NOT NULL DEFAULT 'active'`);
    await queryRunner.query(`ALTER TABLE "org_units" ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMPTZ NULL`);
    await queryRunner.query(`
      DO $$
      DECLARE fk text;
      BEGIN
        FOR fk IN
          SELECT c.conname FROM pg_constraint c
          WHERE c.conrelid = 'org_units'::regclass AND c.contype = 'f' AND c.confrelid = 'org_units'::regclass AND c.confdeltype = 'c'
        LOOP
          EXECUTE format('ALTER TABLE org_units DROP CONSTRAINT %I', fk);
          EXECUTE 'ALTER TABLE org_units ADD CONSTRAINT "FK_org_units_parent" FOREIGN KEY ("parentId") REFERENCES org_units("id") ON DELETE RESTRICT';
        END LOOP;
      END $$;
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF (SELECT count(*) FROM org_units WHERE type = 'company' AND "parentId" IS NULL AND status = 'active') <= 1 THEN
          CREATE UNIQUE INDEX IF NOT EXISTS "IDX_org_units_single_root" ON org_units ((true)) WHERE type = 'company' AND "parentId" IS NULL AND status = 'active';
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_org_units_single_root"`);
    await queryRunner.query(`ALTER TABLE "org_units" DROP COLUMN IF EXISTS "archivedAt"`);
    await queryRunner.query(`ALTER TABLE "org_units" DROP COLUMN IF EXISTS "status"`);
    // the parent FK is deliberately left at RESTRICT: re-introducing cascade deletion of a referenced subtree would be the unsafe direction
  }
}
