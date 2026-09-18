import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F04 / handoff F04-H1 (ADR-036 D4, E-02). Additive — four nullable
 * generic external-document-reference columns on `sales_invoices` so an
 * e-invoice / e-receipt / imported-document identity attaches to the AR
 * subledger document. **No ETA-specific naming.** Backward compatible;
 * every existing row keeps `NULL`. No data migration.
 */
export class AddSalesInvoiceExternalDocumentRef1755855000000 implements MigrationInterface {
  name = 'AddSalesInvoiceExternalDocumentRef1755855000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "sales_invoices" ADD COLUMN "externalDocumentType" VARCHAR(32)`);
    await queryRunner.query(`ALTER TABLE "sales_invoices" ADD COLUMN "externalDocumentId" VARCHAR(128)`);
    await queryRunner.query(`ALTER TABLE "sales_invoices" ADD COLUMN "externalDocumentStatus" VARCHAR(32)`);
    await queryRunner.query(`ALTER TABLE "sales_invoices" ADD COLUMN "externalDocumentSecondaryId" VARCHAR(128)`);
    await queryRunner.query(
      `CREATE INDEX "IDX_sales_invoices_external_document_id" ON "sales_invoices" ("externalDocumentId") WHERE "externalDocumentId" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_sales_invoices_external_document_id"`);
    await queryRunner.query(`ALTER TABLE "sales_invoices" DROP COLUMN "externalDocumentSecondaryId"`);
    await queryRunner.query(`ALTER TABLE "sales_invoices" DROP COLUMN "externalDocumentStatus"`);
    await queryRunner.query(`ALTER TABLE "sales_invoices" DROP COLUMN "externalDocumentId"`);
    await queryRunner.query(`ALTER TABLE "sales_invoices" DROP COLUMN "externalDocumentType"`);
  }
}
