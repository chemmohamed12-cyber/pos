import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { COMPANY_ENTITY_REGISTRY } from './company-entity-registry';

/**
 * ADR-074 (2026-09-25, CTO Decision: Hybrid B, Step 5 — the required
 * "guard/test that proves the registry cannot silently lose entities that
 * enter Company-scoped repository paths"). Deliberately NOT a second
 * hand-maintained list of "the files/entities that matter" — that would
 * repeat the exact failure shape (a manually-typed list someone forgets to
 * update) ADR-074 exists because of. Instead this walks the real `src/`
 * tree at test time, the same way `discoverMigrationTags` walks the real
 * migrations directory, and finds every service that already declares
 * itself Company-connection-capable via this codebase's own established
 * convention (`manager?: EntityManager` or, for `ApprovalEngineService`,
 * `dataSource?: DataSource`) together with every `.getRepository(Entity)`
 * call inside it — then asserts each such entity is present in
 * `COMPANY_ENTITY_REGISTRY`. A new domain adopting this convention for a
 * new entity, without adding that entity to its own `*-company-entities.ts`
 * manifest, fails this test the next time it runs — not silently, months
 * later, against a real Company database.
 */
const SRC_ROOT = join(__dirname, '..', '..');
const MANAGER_PARAM_PATTERN = /manager\?:\s*EntityManager|dataSource\?:\s*DataSource/;
const GET_REPOSITORY_PATTERN = /\.getRepository\(([A-Za-z][A-Za-z0-9]*)\)/g;

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
      walk(full, files);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts') && !entry.endsWith('.d.ts')) {
      files.push(full);
    }
  }
  return files;
}

describe('COMPANY_ENTITY_REGISTRY completeness — ADR-074 Step 5 guard (2026-09-25)', () => {
  it('registers every entity any Company-connection-capable service (manager?/dataSource? convention) actually queries via .getRepository()', () => {
    const registeredNames = new Set(COMPANY_ENTITY_REGISTRY.map((e) => (e as { name: string }).name));
    const missing: Array<{ entity: string; file: string }> = [];

    for (const file of walk(SRC_ROOT)) {
      const content = readFileSync(file, 'utf8');
      if (!MANAGER_PARAM_PATTERN.test(content)) continue;

      let match: RegExpExecArray | null;
      GET_REPOSITORY_PATTERN.lastIndex = 0;
      while ((match = GET_REPOSITORY_PATTERN.exec(content)) !== null) {
        const entityName = match[1];
        if (!registeredNames.has(entityName)) {
          missing.push({ entity: entityName, file: file.replace(SRC_ROOT, 'src') });
        }
      }
    }

    if (missing.length > 0) {
      const report = missing.map((m) => `  - ${m.entity} (used in ${m.file})`).join('\n');
      throw new Error(
        `COMPANY_ENTITY_REGISTRY is missing ${missing.length} entit(y/ies) that a Company-connection-capable service actually queries:\n${report}\n\n` +
          `Add each to the OWNING domain's own *-company-entities.ts manifest (creating one if it doesn't exist yet), never directly to company-entity-registry.ts.`,
      );
    }

    expect(missing).toEqual([]);
  });

  it('has no duplicate entities across domain manifests (each entity owned by exactly one domain)', () => {
    const names = COMPANY_ENTITY_REGISTRY.map((e) => (e as { name: string }).name);
    const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
    expect(duplicates).toEqual([]);
  });
});
