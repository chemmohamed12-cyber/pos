import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Global UX Audit directive (2026-09-12) — Chart of Accounts localization
 * root cause: `accounting_gl_accounts.name` was the ONLY name column, so
 * every account rendered in English regardless of the active language,
 * even though the IFRS-SME import template already carries an Arabic
 * name for every row (`ifrs-sme.template.ts`'s `nameAr`) — the importer
 * just had nowhere in the schema to put it. Purely additive, nullable:
 * every existing account keeps rendering exactly as before (`name`
 * fallback) until re-imported or edited with an Arabic name.
 *
 * NB: this migration's terminology seed (`field.account_name_ar`) was
 * removed after a concurrency race meant it never actually ran here (see
 * `1755860300000-SeedGlAccountNameArTerminology`, which seeds it
 * instead) — this file's `up()` no longer matches what shipped, kept
 * this way deliberately so it stops describing work it didn't do.
 */
export class AddGlAccountNameAr1755860200000 implements MigrationInterface {
  name = 'AddGlAccountNameAr1755860200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "accounting_gl_accounts" ADD COLUMN "nameAr" VARCHAR(160)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "accounting_gl_accounts" DROP COLUMN "nameAr"`);
  }
}
