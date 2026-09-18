import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { verifyManifest } from '../foundation/entitlement/manifest-verify';
import { EntitlementPublicKey } from '../foundation/entitlement/manifest.type';
import { computeInstallationFingerprint } from '../foundation/entitlement/installation-fingerprint';
import { MODULE_REGISTRY } from '../foundation/module-registry/module-registry';

/**
 * Per-module migration partitioning (ADR-025 §4). The ONE dependency-free
 * reader that answers "which `migrations/<tag>/` directories are in scope for
 * THIS installation" — Core plus every entitled module (and its `depends_on`
 * closure, F-MOD-2).
 *
 * Deliberately NOT a NestJS provider and imports NOTHING from
 * `foundation/*` except two pure, dependency-free things:
 *   - `verifyManifest` — Ed25519 via Node native `crypto` only (P3)
 *   - `MODULE_REGISTRY` — a deep-frozen const (P1)
 * so it runs in a bare `migration:run` CLI, in the Release Engine's
 * short-lived migration DataSource, AND as a boot-time DI provider value,
 * identically.
 *
 * Resolution order (ADR-025 §4.1):
 *   1. `<appRoot>/entitlement.manifest.json` (+ sibling `.sig`, or an inline
 *      `signature` field) — the deploy writes this BEFORE migrations run.
 *   2. the `installation` DB row (a `pg`-level query, no TypeORM repo/DI).
 *   3. fall back: `ENTITLEMENT_MODE=enforced` → `['core']` + loud warning
 *      (fail-closed); otherwise (default `unlicensed-full`) → every tag
 *      (the implicit DAII_STANDARD edition — current product unchanged).
 */
export const MIGRATION_TAGS = ['core', 'sales', 'inventory', 'logistics', 'finance', 'hr'] as const;
export type MigrationTag = (typeof MIGRATION_TAGS)[number];

export interface ReadEnabledModulesOptions {
  /** where `entitlement.manifest.json` lives. Default `process.cwd()`. */
  appRoot?: string;
  /** anything with `.query(sql, params?)` — the running app's DataSource, or a raw pg client. */
  dataSource?: { query(sql: string, params?: unknown[]): Promise<unknown[]> };
  /** Ed25519 verification keys. Default: parsed from `ENTITLEMENT_PUBLIC_KEYS` env (JSON `[{kid,spki_b64}]`). */
  publicKeys?: readonly EntitlementPublicKey[];
  /** Default: `ENTITLEMENT_MODE` env, else `'unlicensed-full'`. */
  mode?: 'unlicensed-full' | 'enforced';
  clockToleranceMinutes?: number;
  /** injected for tests */
  logger?: (msg: string) => void;
}

function parseEnvKeys(): EntitlementPublicKey[] {
  try {
    const raw = process.env.ENTITLEMENT_PUBLIC_KEYS;
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as EntitlementPublicKey[]) : [];
  } catch {
    return [];
  }
}

/** ['core', ...codes ∪ each code's depends_on closure], intersected with the real tag dirs. */
export function tagsForModules(moduleCodes: readonly string[]): MigrationTag[] {
  const set = new Set<string>(['core']);
  for (const code of moduleCodes) {
    set.add(code);
    for (const dep of MODULE_REGISTRY.dependencyClosureOf(code as never)) set.add(dep);
  }
  return MIGRATION_TAGS.filter((t) => set.has(t));
}

export async function readEnabledModules(opts: ReadEnabledModulesOptions = {}): Promise<MigrationTag[]> {
  const appRoot = opts.appRoot ?? process.cwd();
  const publicKeys = opts.publicKeys ?? parseEnvKeys();
  const mode = opts.mode ?? (process.env.ENTITLEMENT_MODE === 'enforced' ? 'enforced' : 'unlicensed-full');
  const log = opts.logger ?? ((m: string) => console.warn(`[readEnabledModules] ${m}`));
  const verifyOpts = { publicKeys, clockToleranceMinutes: opts.clockToleranceMinutes ?? 10, currentFingerprint: computeInstallationFingerprint() };

  // 1. signed manifest file in the release package / app root. The signature
  //    is ALWAYS detached (a sibling `.sig`) — the signed bytes are the
  //    canonical manifest itself, so an inline signature field would be part
  //    of what is verified and could never validate.
  const manifestFile = join(appRoot, 'entitlement.manifest.json');
  const sigFile = `${manifestFile}.sig`;
  if (existsSync(manifestFile) && existsSync(sigFile)) {
    try {
      const rawJson = readFileSync(manifestFile, 'utf8');
      const sig = readFileSync(sigFile, 'utf8').trim();
      const result = verifyManifest(rawJson, sig, verifyOpts);
      if (result.ok) return tagsForModules(result.manifest.module_codes);
      log(`entitlement.manifest.json present but INVALID (${result.reason}) — falling through`);
    } catch (e) {
      log(`entitlement.manifest.json unreadable: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 2. the installation DB row
  if (opts.dataSource) {
    try {
      const rows = (await opts.dataSource.query(
        `SELECT "entitlementManifest"::text AS m, "manifestSignature" AS s, "editionCode" AS e FROM "installation" WHERE "id" = 'installation' LIMIT 1`,
      )) as Array<{ m: string | null; s: string | null; e: string | null }>;
      const row = rows?.[0];
      if (row?.m) {
        // an explicitly-applied implicit-standard row (dev/test) has no signature — trust it = all modules
        if (row.e === 'DAII_STANDARD' && !row.s) return [...MIGRATION_TAGS];
        const result = verifyManifest(row.m, row.s, verifyOpts);
        if (result.ok) return tagsForModules(result.manifest.module_codes);
        log(`installation row manifest INVALID (${result.reason}) — falling through`);
      }
    } catch (e) {
      // table may not exist yet on a brand-new DB — that is expected, not an error
      log(`installation row not readable (${e instanceof Error ? e.message : String(e)}) — falling through`);
    }
  }

  // 3. fall back
  if (mode === 'enforced') {
    log('ENTITLEMENT_MODE=enforced and no valid manifest — restricting migrations to core/ only (fail-closed).');
    return ['core'];
  }
  return [...MIGRATION_TAGS];
}
