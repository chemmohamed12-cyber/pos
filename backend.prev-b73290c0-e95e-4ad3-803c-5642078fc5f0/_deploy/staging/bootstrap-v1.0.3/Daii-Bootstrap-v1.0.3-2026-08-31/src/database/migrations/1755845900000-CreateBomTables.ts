import { MigrationInterface, QueryRunner } from 'typeorm';

/** Gap G-2 (planning/excel-mapping/EXCEL_BUSINESS_MAPPING_PACKAGE.md) — Bill of Materials, Commerce domain (DAII_DOMAIN_BOUNDARIES.md §1). */
export class CreateBomTables1755845900000 implements MigrationInterface {
  name = 'CreateBomTables1755845900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "bill_of_materials" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "finishedProductId" UUID NOT NULL REFERENCES "products"("id"),
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_bill_of_materials_finishedProductId" ON "bill_of_materials" ("finishedProductId")`,
    );

    await queryRunner.query(`
      CREATE TABLE "bom_components" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "billOfMaterialId" UUID NOT NULL REFERENCES "bill_of_materials"("id") ON DELETE CASCADE,
        "componentProductId" UUID NOT NULL REFERENCES "products"("id"),
        "quantityPerUnit" INT NOT NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_bom_components_billOfMaterialId" ON "bom_components" ("billOfMaterialId")`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_bom_components_billOfMaterialId_componentProductId" ON "bom_components" ("billOfMaterialId", "componentProductId")`,
    );

    await queryRunner.query(
      `INSERT INTO "numbering_sequences" ("documentType", "prefix", "includeYear") VALUES ('assembly', 'ASM', true)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "numbering_sequences" WHERE "documentType" = 'assembly'`);
    await queryRunner.query(`DROP TABLE "bom_components"`);
    await queryRunner.query(`DROP TABLE "bill_of_materials"`);
  }
}
