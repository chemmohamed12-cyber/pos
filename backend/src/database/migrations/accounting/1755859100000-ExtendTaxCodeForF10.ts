import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F10 (ADR-043 D2). Additive extension of the F01 `accounting_tax_codes`
 * scaffold — `type` (jurisdiction-neutral standard/zero_rated/exempt,
 * NOT NULL with a safe default so every existing row stays valid),
 * `jurisdictionCode`/`effectiveFrom`/`effectiveTo` (all nullable —
 * optional, no existing row's meaning changes). No other table touched;
 * no `accounting_journal_entries`/`_lines` column added (F10 Blueprint §5
 * anti-pattern list).
 */
export class ExtendTaxCodeForF101755859100000 implements MigrationInterface {
  name = 'ExtendTaxCodeForF101755859100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "accounting_tax_codes" ADD COLUMN "type" VARCHAR(16) NOT NULL DEFAULT 'standard'`);
    await queryRunner.query(
      `ALTER TABLE "accounting_tax_codes" ADD CONSTRAINT "CHK_accounting_tax_codes_type" CHECK ("type" IN ('standard','zero_rated','exempt'))`,
    );
    await queryRunner.query(`ALTER TABLE "accounting_tax_codes" ADD COLUMN "jurisdictionCode" VARCHAR(8)`);
    await queryRunner.query(`ALTER TABLE "accounting_tax_codes" ADD COLUMN "effectiveFrom" DATE`);
    await queryRunner.query(`ALTER TABLE "accounting_tax_codes" ADD COLUMN "effectiveTo" DATE`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "accounting_tax_codes" DROP COLUMN "effectiveTo"`);
    await queryRunner.query(`ALTER TABLE "accounting_tax_codes" DROP COLUMN "effectiveFrom"`);
    await queryRunner.query(`ALTER TABLE "accounting_tax_codes" DROP COLUMN "jurisdictionCode"`);
    await queryRunner.query(`ALTER TABLE "accounting_tax_codes" DROP CONSTRAINT "CHK_accounting_tax_codes_type"`);
    await queryRunner.query(`ALTER TABLE "accounting_tax_codes" DROP COLUMN "type"`);
  }
}
