import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Security Assurance Gate — Track S20 (Cleanup), found 2026-09-08: the
 * live server log carried a persistent `nav_group.hr has no registry
 * entry — falling back to raw code` warning. Every OTHER navigation
 * group declared in `navigation-registry.ts` (`nav_group.sales`,
 * `.warehouses`, `.production`, `.shipping`, `.customers_accounts`,
 * `.treasury`, `.catalog`, `.administration`) has its own terminology
 * seed migration — `nav_group.hr` is the one exception, genuinely
 * missing rather than intentionally omitted (its own registry entry's
 * doc comment: "ERP Foundation P9 (ADR-029) — the first navigation group
 * for a module that didn't exist before this phase"; `SeedHrTerminology`
 * from that same phase seeded `module.hr` and both of `hr`'s nav ITEMS
 * — `nav.hr_employees`/`nav.hr_departments` — but not the nav GROUP
 * label itself). A new migration, not an edit to the already-applied
 * `SeedHrTerminology1755854100000`, per this codebase's standing
 * discipline against modifying a historical migration's body.
 */
export class SeedNavGroupHrTerminology1755854300000 implements MigrationInterface {
  name = 'SeedNavGroupHrTerminology1755854300000';

  private readonly terminology: Array<[string, string, string, string]> = [
    ['nav_group.hr', 'nav_group', 'الموارد البشرية', 'HR'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [code, category, ar, en] of this.terminology) {
      await queryRunner.query(
        `INSERT INTO "terminology_entries" ("code", "category", "ar", "en")
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (code) DO UPDATE SET "ar" = EXCLUDED."ar", "en" = EXCLUDED."en", "version" = "terminology_entries"."version" + 1`,
        [code, category, ar, en],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [this.terminology.map(([code]) => code)]);
  }
}
