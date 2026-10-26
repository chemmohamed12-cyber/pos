import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { MIGRATION_TAGS, readEnabledModules, tagsForModules } from './enabled-modules';

/**
 * CTO decision D-5 (2026-10-26): the 140 HR/Payroll terminology seeds keep the `payroll` tag. This spec proves that the tag-selection logic of the release engine
 * executes that directory wherever the payroll module is in scope, and fails loudly if the seed is moved or its tag is dropped (silent omission).
 */
describe('payroll terminology seed - tag execution (D-5)', () => {
  const dir = join(__dirname, 'migrations', 'payroll');

  it('the seed lives in the payroll tag directory and the tag is registered', () => {
    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(dir).some((f) => /^1790100100000-SeedPayrollGapClosureTerminology\.ts$/.test(f))).toBe(true);
    expect(MIGRATION_TAGS as readonly string[]).toContain('payroll');
  });

  it('an entitlement that includes the payroll module selects the payroll tag (and core)', () => {
    const tags = tagsForModules(['payroll']);
    expect(tags).toContain('payroll');
    expect(tags).toContain('core');
  });

  it('an entitlement without the payroll module does not run payroll seeds (by design: no payroll screens either)', () => {
    expect(tagsForModules(['sales'])).not.toContain('payroll');
  });

  it('the default (unlicensed-full) installation path runs every tag, payroll included', async () => {
    const tags = await readEnabledModules({ appRoot: join(__dirname, '__no_such_manifest_dir__'), mode: 'unlicensed-full', publicKeys: [], logger: () => undefined });
    expect(tags).toContain('payroll');
    expect(tags).toContain('core');
  });

  it('fail-closed enforced mode without a manifest restricts to core only (payroll seeds do not run)', async () => {
    const tags = await readEnabledModules({ appRoot: join(__dirname, '__no_such_manifest_dir__'), mode: 'enforced', publicKeys: [], logger: () => undefined });
    expect(tags).toEqual(['core']);
  });
});
