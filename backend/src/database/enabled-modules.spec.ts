import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MIGRATION_TAGS, readEnabledModules, tagsForModules } from './enabled-modules';
import { MODULE_REGISTRY } from '../foundation/module-registry/module-registry';
import { V1_MODULE_CODES } from '../foundation/module-registry/module-manifest.type';

/**
 * Platform migration registry follow-up (Manufacturing handoff H3). `MIGRATION_TAGS`
 * is the filter every entitlement-driven migration selection passes through
 * (`tagsForModules` / `readEnabledModules` → Release Engine `createMigrationDataSource`),
 * so a tag directory missing from it is silently never globbed — the same drift class
 * as the 2026-09-15 `accounting` incident, in the entitlement path instead of the
 * no-manifest path. These specs pin the registry to the real directory tree and to the
 * module registry so the next module cannot drift again.
 */
const MIGRATIONS_DIR = join(__dirname, 'migrations');
const tagDirsOnDisk = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

describe('MIGRATION_TAGS registry', () => {
  it('covers every migrations/<tag>/ directory on disk (no silent skip)', () => {
    const missing = tagDirsOnDisk.filter((d) => !(MIGRATION_TAGS as readonly string[]).includes(d));
    expect(missing).toEqual([]);
  });

  it('names no tag that has no directory on disk', () => {
    const phantom = (MIGRATION_TAGS as readonly string[]).filter((t) => !tagDirsOnDisk.includes(t));
    expect(phantom).toEqual([]);
  });

  it("covers every module's migration_tag that has a directory", () => {
    const missing = MODULE_REGISTRY.authoredModuleCodes()
      .map((c) => MODULE_REGISTRY.manifest(c)!.migration_tag)
      .filter((tag) => tagDirsOnDisk.includes(tag) && !(MIGRATION_TAGS as readonly string[]).includes(tag));
    expect(missing).toEqual([]);
  });

  it("agrees with the CLI data-source.ts tag list (the 'all tags' set)", () => {
    const src = readFileSync(join(__dirname, 'data-source.ts'), 'utf8');
    const listed = /:\s*\[((?:'[a-z]+',?\s*)+)\]\s*\)\.map/.exec(src)?.[1].match(/'([a-z]+)'/g)?.map((s) => s.replace(/'/g, ''));
    expect(listed).toBeDefined();
    expect([...listed!].sort()).toEqual([...MIGRATION_TAGS].sort());
  });
});

describe('tagsForModules', () => {
  it.each(V1_MODULE_CODES.filter((c) => c !== 'core' && tagDirsOnDisk.includes(c)))(
    'an installation entitled to %s gets that module\'s own migrations/<tag>/',
    (code) => {
      expect(tagsForModules([code])).toContain(code);
    },
  );

  it('manufacturing entitlement pulls manufacturing + its full dependency closure (incl. accounting via finance)', () => {
    expect(tagsForModules(['manufacturing'])).toEqual(expect.arrayContaining(['core', 'sales', 'inventory', 'finance', 'accounting', 'manufacturing']));
  });

  it('sales-only entitlement still gets accounting (sales→finance→accounting) — finance migrations reference accounting tables', () => {
    expect(tagsForModules(['sales'])).toContain('accounting');
  });

  it('KNOWN GAP (characterization): an unknown module code in a signed manifest is silently ignored (core only) — not rejected at migration-selection time', () => {
    expect(tagsForModules(['not-a-module'])).toEqual(['core']);
  });

  it('every returned tag has a directory on disk, and every on-disk tag in a closure is returned', () => {
    for (const code of V1_MODULE_CODES) {
      const closure = new Set<string>(['core', code, ...MODULE_REGISTRY.dependencyClosureOf(code as never)]);
      const expected = tagDirsOnDisk.filter((d) => closure.has(d)).sort();
      expect([...tagsForModules([code])].sort()).toEqual(expected);
    }
  });
});

describe('readEnabledModules fallback', () => {
  it('unlicensed-full with no manifest and no DB row returns every tag directory on disk', async () => {
    const appRoot = mkdtempSync(join(tmpdir(), 'daii-enabled-modules-'));
    try {
      const tags = await readEnabledModules({ appRoot, mode: 'unlicensed-full', logger: () => undefined });
      expect([...tags].sort()).toEqual(tagDirsOnDisk);
    } finally {
      rmSync(appRoot, { recursive: true, force: true });
    }
  });

  it('enforced with no manifest fails closed to core only', async () => {
    const appRoot = mkdtempSync(join(tmpdir(), 'daii-enabled-modules-'));
    try {
      expect(await readEnabledModules({ appRoot, mode: 'enforced', logger: () => undefined })).toEqual(['core']);
    } finally {
      rmSync(appRoot, { recursive: true, force: true });
    }
  });

  it('an unsigned DAII_STANDARD installation row (dev/test) yields every tag directory on disk', async () => {
    const appRoot = mkdtempSync(join(tmpdir(), 'daii-enabled-modules-'));
    try {
      const dataSource = { query: async () => [{ m: '{}', s: null, e: 'DAII_STANDARD' }] };
      const tags = await readEnabledModules({ appRoot, dataSource, mode: 'unlicensed-full', logger: () => undefined });
      expect([...tags].sort()).toEqual(tagDirsOnDisk);
    } finally {
      rmSync(appRoot, { recursive: true, force: true });
    }
  });
});
