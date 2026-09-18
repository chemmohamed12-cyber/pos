import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F12 — Fixed Assets (ADR-045). Same convention as `SeedControlFunctionTerminology1755859400000` —
 * the Chart of Accounts tree resolves `value.control_function.<code>` for every `ControlFunction`
 * value; `fixed_asset` needs the same entry so it never renders as a raw, untranslated enum value.
 */
export class SeedFixedAssetControlFunctionTerminology1755861100000 implements MigrationInterface {
  name = 'SeedFixedAssetControlFunctionTerminology1755861100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `INSERT INTO "terminology_entries" ("code", "category", "ar", "en")
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (code) DO UPDATE SET "ar" = EXCLUDED."ar", "en" = EXCLUDED."en", "version" = "terminology_entries"."version" + 1`,
      ['value.control_function.fixed_asset', 'field', 'الأصول الثابتة', 'Fixed Asset'],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = 'value.control_function.fixed_asset'`);
  }
}
