import { QueryRunner } from 'typeorm';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../testing/two-company-real-pg-harness';
import { PLATFORM_ROLES } from '../platform/platform-nodes';
import { SeedPlatformRoleNames1790019200000 } from '../../database/migrations/core/1790019200000-SeedPlatformRoleNames';

/**
 * CTO decision 2026-10-20 (role key localization) — real PostgreSQL. The four platform roles the header showed as raw keys get their approved Arabic / English
 * names from the Terminology Registry. The migration changes ONLY `terminology_entries` rows, is safe to rerun, never overwrites a customised translation, and `down`
 * removes only rows that still hold the seeded text. The names are checked against the role definitions in code, so the two sources cannot drift apart.
 */
describe('Platform role names — terminology migration (real Postgres)', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let qr: QueryRunner;
  const migration = new SeedPlatformRoleNames1790019200000();
  const KEYS = ['platform_super_admin', 'company_manager', 'support_operations', 'platform_audit_readonly'];
  const codes = KEYS.map((k) => `role.${k}`);

  const rows = async () => qr.query(`SELECT code, category, ar, en FROM terminology_entries WHERE code = ANY($1) ORDER BY code`, [codes]);
  const total = async () => Number((await qr.query(`SELECT count(*)::int AS n FROM terminology_entries`))[0].n);

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'role_names' });
    qr = h.controlPlane.createQueryRunner();
    await qr.connect();
  });

  afterAll(async () => {
    await qr.release();
    await h.teardown();
  });

  it('the four keys resolve to the approved names taken from the role definitions in code (exact keys, Arabic and English)', async () => {
    await migration.up(qr);
    const found = await rows();
    expect(found).toHaveLength(4);
    for (const key of KEYS) {
      const def = PLATFORM_ROLES.find((r) => r.key === key)!;
      const row = found.find((r: { code: string }) => r.code === `role.${key}`);
      expect(row).toMatchObject({ category: 'role_label', ar: def.nameAr, en: def.nameEn });
    }
  });

  it('rerunning is safe: no duplicate, no error, nothing else touched', async () => {
    const before = await total();
    await migration.up(qr);
    await migration.up(qr);
    expect(await rows()).toHaveLength(4);
    expect(await total()).toBe(before);
  });

  it('a customised translation is not overwritten by up, and is left alone by down', async () => {
    await qr.query(`UPDATE terminology_entries SET ar = 'اسم مخصص', "version" = "version" + 1 WHERE code = 'role.company_manager'`);
    await migration.up(qr);
    expect((await qr.query(`SELECT ar FROM terminology_entries WHERE code = 'role.company_manager'`))[0].ar).toBe('اسم مخصص');
    await migration.down(qr);
    const left = await rows();
    expect(left.map((r: { code: string }) => r.code)).toEqual(['role.company_manager']); // only the customised row survives; the three untouched rows were removed
    expect(left[0].ar).toBe('اسم مخصص');
  });

  it('up after down restores the three removed rows and still keeps the customised one; unrelated role labels are never touched', async () => {
    const roleAdminBefore = await qr.query(`SELECT ar, en FROM terminology_entries WHERE code = 'role.admin'`);
    await migration.up(qr);
    const found = await rows();
    expect(found).toHaveLength(4);
    expect(found.find((r: { code: string }) => r.code === 'role.company_manager').ar).toBe('اسم مخصص');
    expect(await qr.query(`SELECT ar, en FROM terminology_entries WHERE code = 'role.admin'`)).toEqual(roleAdminBefore);
  });

  it('the migration issues SQL against terminology_entries only (no role, permission or membership table)', () => {
    const sql = (migration.up.toString() + migration.down.toString()).match(/(?:INSERT INTO|DELETE FROM|UPDATE)\s+"?[a-z_]+"?/gi) ?? [];
    expect(sql.length).toBeGreaterThan(0);
    for (const statement of sql) expect(statement).toMatch(/terminology_entries/);
  });
});
