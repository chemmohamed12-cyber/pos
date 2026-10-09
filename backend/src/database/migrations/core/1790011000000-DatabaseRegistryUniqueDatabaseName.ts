import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A physical database belongs to exactly ONE Company. Pool-mode allocation (see company-database-allocator.ts) reads the assigned names from this table, and a host may run
 * several Node workers, so the database itself must refuse a second registration of the same name — an in-process lock cannot. Additive: it refuses nothing that valid
 * data contains. If duplicates already exist the migration STOPS with their names; it never deletes or merges registry rows on its own.
 */
export class DatabaseRegistryUniqueDatabaseName1790011000000 implements MigrationInterface {
  name = 'DatabaseRegistryUniqueDatabaseName1790011000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const dup: Array<{ databaseName: string; n: number }> = await queryRunner.query(
      `SELECT "databaseName", count(*)::int AS n FROM "database_registries" GROUP BY "databaseName" HAVING count(*) > 1`,
    );
    if (dup.length > 0) {
      throw new Error(
        `database_registries holds the same databaseName on more than one row (${dup.map((d) => `${d.databaseName} x${d.n}`).join(', ')}); resolve this deliberately before applying the unique index — no row was changed.`,
      );
    }
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_database_registries_databaseName" ON "database_registries" ("databaseName")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_database_registries_databaseName"`);
  }
}
