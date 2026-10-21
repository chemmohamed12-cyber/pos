import { readdirSync } from 'fs';
import { join } from 'path';

/**
 * Pure helpers shared by the Company fan-out (deploy time) and the Company schema admission (run time): which migrations does a build ship, per tag, and which tags does
 * a Company receive. No I/O beyond reading the compiled migration directory, no framework imports, so the runtime check can use them without loading the Release Engine.
 */
const MIGRATION_FILE = /^(\d+)-(.+)\.js$/;

/**
 * `<root>/dist/database/migrations/<tag>/<timestamp>-<Name>.js` -> the migration's recorded name `<Name><timestamp>` (the TypeORM class-name convention
 * every migration in this repo follows; `company-fanout.real-pg.spec.ts` proves it against the real compiled set), grouped by tag.
 */
export function migrationNamesByTag(appRoot: string, tags: readonly string[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const tag of tags) {
    const names = new Set<string>();
    try {
      for (const f of readdirSync(join(appRoot, 'dist', 'database', 'migrations', tag))) {
        const m = MIGRATION_FILE.exec(f);
        if (m) names.add(`${m[2]}${m[1]}`);
      }
    } catch {
      /* a tag directory that is not on disk contributes nothing */
    }
    out.set(tag, names);
  }
  return out;
}

/** The tags a Company receives: `core`, plus every candidate tag of which the Company already has at least one executed migration. */
export function tagsReceivedByCompany(byTag: Map<string, Set<string>>, executed: ReadonlySet<string>): string[] {
  const tags: string[] = [];
  for (const [tag, names] of byTag) {
    if (tag === 'core') {
      tags.push(tag);
      continue;
    }
    for (const n of names) {
      if (executed.has(n)) {
        tags.push(tag);
        break;
      }
    }
  }
  return tags.sort();
}

/** Migrations the build ships for the given tags that are NOT recorded as executed. */
export function pendingFor(byTag: Map<string, Set<string>>, tags: readonly string[], executed: ReadonlySet<string>): string[] {
  const pending: string[] = [];
  for (const t of tags) for (const n of byTag.get(t) ?? []) if (!executed.has(n)) pending.push(n);
  return pending.sort();
}
