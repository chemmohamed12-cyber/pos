import { MigrationInterface, QueryRunner } from 'typeorm';

/** Numbering Engine — Stage 2 build-order item 17. Seeds the Sales Order sequence ahead of Phase B. */
export class CreateNumberingSequences1755841200000 implements MigrationInterface {
  name = 'CreateNumberingSequences1755841200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "numbering_sequences" (
        "documentType" VARCHAR(64) PRIMARY KEY,
        "prefix" VARCHAR(16) NOT NULL,
        "includeYear" BOOLEAN NOT NULL DEFAULT true,
        "lastNumber" INT NOT NULL DEFAULT 0,
        "lastYear" INT,
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `INSERT INTO "numbering_sequences" ("documentType", "prefix", "includeYear") VALUES ('sales_order', 'SO', true)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "numbering_sequences"`);
  }
}
