import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Post-v1.1.1-deployment finding (2026-09-21): several nav/module labels
 * rendered as their raw code, uppercased-with-underscore (e.g.
 * `MODULE.PAYROLL`, `NAV_GROUP.PROCUREMENT`), on the Hosting target.
 *
 * Root cause, confirmed by direct source inspection this session — NOT a
 * code defect:
 *   - `LanguageContext.tsx`'s `t()` fallback and `TerminologyService.
 *     resolve()`/`resolveMany()`'s own fallback BOTH return the raw code
 *     completely unmodified when no registry entry exists — neither path
 *     can ever produce an uppercase transformation of anything. A
 *     genuinely-missing entry would render as the exact lowercase code
 *     already in source (`module.payroll`), never `MODULE.PAYROLL`.
 *   - `Layout.tsx`'s own `NAV_GROUPS` array already uses the correct
 *     lowercase codes for every one of these entries (confirmed by direct
 *     read) — nothing to change there.
 *   - Every owning seed migration for these 7 codes (`manufacturing/
 *     1789731000000`, `attendance/1789730100000`, `procurement/
 *     1789700100000`, `payroll/1789740200000`, `targets/1789750200000`,
 *     `commission/1789751300000`) already carries the correct Arabic/
 *     English text in source, confirmed identical to this session's own
 *     local dev database (where every one of these 7 codes already
 *     resolves correctly).
 *
 * The Hosting operator's own direct query confirmed the ACTUAL stored
 * `ar`/`en` values for these codes on that target are stale/placeholder
 * ("test data") — meaning the correct content above was authored into
 * these migration files, but the target's own `migrations` table already
 * recorded those migration names as executed (from an earlier point when
 * their content differed), so TypeORM never re-runs them there. The exact
 * same class of gap this codebase already hit once and fixed the same way
 * (`1789751400000-CorrectPayrollCommissionPendingNotice.ts`): a
 * migration's own SOURCE was corrected after it had already been applied
 * once — the only way that correction reaches an environment that already
 * ran it is a NEW migration.
 *
 * Purely additive/corrective: re-asserts the exact same 7 entries their
 * own owning migrations already declare, byte-for-byte, via the same
 * idempotent `ON CONFLICT` upsert every terminology migration in this
 * codebase already uses — safe regardless of whether a given row is
 * missing (inserts it) or present with stale content (corrects it).
 */
export class CorrectStaleTerminologyValues1789770000000 implements MigrationInterface {
  name = 'CorrectStaleTerminologyValues1789770000000';

  private readonly rows: Array<[string, string, string, string]> = [
    ['module.payroll', 'field', 'الرواتب', 'Payroll'],
    ['module.manufacturing', 'field', 'التصنيع', 'Manufacturing'],
    ['module.attendance', 'field', 'الحضور والانصراف', 'Attendance'],
    ['module.targets', 'field', 'المستهدفات', 'Targets'],
    ['module.commission', 'field', 'العمولات', 'Commission'],
    ['nav_group.procurement', 'field', 'المشتريات', 'Procurement'],
    ['nav.manufacturing_work_orders', 'field', 'أوامر الإنتاج', 'Work Orders'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [code, category, ar, en] of this.rows) {
      await queryRunner.query(
        `INSERT INTO "terminology_entries" ("code", "category", "ar", "en")
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (code) DO UPDATE SET "ar" = EXCLUDED."ar", "en" = EXCLUDED."en", "version" = "terminology_entries"."version" + 1`,
        [code, category, ar, en],
      );
    }
  }

  /**
   * No prior-value restoration — the row's PRE-this-migration content was
   * stale/placeholder data, never a deliberate value worth restoring.
   * `down()` here only reverts the `version` bump's own side effect is not
   * reversible in isolation without knowing each row's exact pre-image, so,
   * matching this codebase's own precedent for a corrective terminology
   * migration, this is a no-op down() — reverting a text correction to a
   * known-wrong value is never the intended rollback semantics.
   */
  public async down(): Promise<void> {
    // Intentionally a no-op — see class doc comment.
  }
}
