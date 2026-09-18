import { Injectable, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { readFile, stat } from 'fs/promises';
import { join } from 'path';
import { AppConfigService } from '../configuration/app-config.service';
import { STRICT_UUID_REGEX } from '../../database/uuid-repair.core';

export interface ReleaseHealthCheckResult {
  ok: boolean;
  components: Record<string, boolean>;
  detail: Record<string, string>;
  /** Non-blocking observations — surfaced to the operator, never affect `ok`. Legacy non-RFC4122 primary keys land here (repair is a separate Controlled Data Repair, not a deploy blocker). */
  warnings?: Record<string, string>;
}

/**
 * Release Center — Execution Layer. Ports `tools/deploy/verify-deploy.sh`'s
 * schema-readiness step into TypeScript so the deploy pipeline can run it
 * against the injected `DataSource` with no HTTP self-call and no shell
 * dependency, PLUS (v1.0.3 deployment report):
 *  - strict RFC4122 validation of the UUID functions (not just 8-4-4-4-12
 *    shape) — the exact defect that shipped in v1.0.2 and caused the
 *    "accountId/treasuryAccountId must be a UUID" bug;
 *  - `frontend.bundle` — reads `<FRONTEND_RUNTIME_PATH>/index.html` and
 *    asserts every `assets/*.{js,css}` it references actually exists on
 *    disk. This is exactly the check that would have caught the v1.0.3
 *    site bug (a fresh `frontend/dist` built, but `backend/public` left
 *    serving the previous bundle).
 */
const REQUIRED_TABLES = ['_daii_bootstrap_check', 'users'];
const UUID_FUNCTIONS = ['gen_random_uuid()', 'uuid_generate_v4()'];

@Injectable()
export class ReleaseHealthCheckService {
  constructor(
    private readonly dataSource: DataSource,
    @Optional() private readonly config?: AppConfigService,
  ) {}

  async check(): Promise<ReleaseHealthCheckResult> {
    const components: Record<string, boolean> = {};
    const detail: Record<string, string> = {};
    const warnings: Record<string, string> = {};

    try {
      await this.dataSource.query('SELECT 1');
      components['database.connectivity'] = true;
    } catch (err) {
      components['database.connectivity'] = false;
      detail['database.connectivity'] = err instanceof Error ? err.message : String(err);
      return { ok: false, components, detail, warnings };
    }

    for (const table of REQUIRED_TABLES) {
      const key = `table.${table}`;
      try {
        const rows: Array<{ to_regclass: string | null }> = await this.dataSource.query('SELECT to_regclass($1) AS to_regclass', [`public.${table}`]);
        const exists = rows[0]?.to_regclass !== null && rows[0]?.to_regclass !== undefined;
        components[key] = exists;
        if (!exists) detail[key] = `table "public.${table}" does not exist`;
      } catch (err) {
        components[key] = false;
        detail[key] = err instanceof Error ? err.message : String(err);
      }
    }

    for (const fn of UUID_FUNCTIONS) {
      const key = `function.${fn}`;
      try {
        const rows: Array<Record<string, string>> = await this.dataSource.query(`SELECT ${fn} AS result`);
        const value = rows[0]?.result;
        // Strict RFC4122 — a UUID-shaped string with a random version/variant
        // nibble (the pre-1755852500000 defect) must FAIL this, not pass.
        const ok = typeof value === 'string' && STRICT_UUID_REGEX.test(value);
        components[key] = ok;
        if (!ok) detail[key] = `did not return an RFC4122-valid UUID: ${JSON.stringify(value)}`;
      } catch (err) {
        components[key] = false;
        detail[key] = err instanceof Error ? err.message : String(err);
      }
    }

    await this.checkFrontendBundle(components, detail);
    await this.warnOnLegacyUuidData(warnings);

    const ok = Object.values(components).every(Boolean);
    return { ok, components, detail, warnings };
  }

  /**
   * Reads the runtime `index.html` and confirms every local `assets/*`
   * bundle it references exists and is non-empty. Skipped (not failed) if
   * `AppConfigService` isn't wired (older tests) or the runtime path has
   * no `index.html` at all (a backend-only deployment).
   */
  private async checkFrontendBundle(components: Record<string, boolean>, detail: Record<string, string>): Promise<void> {
    if (!this.config) return;
    const runtimePath = this.config.releaseExecution.frontendRuntimePath;
    const indexPath = join(runtimePath, 'index.html');

    let html: string;
    try {
      html = await readFile(indexPath, 'utf8');
    } catch {
      // No SPA at the runtime path — nothing to verify (backend-only host).
      return;
    }

    const referenced = new Set<string>();
    const re = /(?:src|href)\s*=\s*["']([^"']*\/assets\/[^"']+\.(?:js|css)[^"']*)["']/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      referenced.add(m[1].replace(/^\.?\//, '').split('?')[0]);
    }

    const key = 'frontend.bundle';
    if (referenced.size === 0) {
      components[key] = true;
      return;
    }

    const missing: string[] = [];
    for (const rel of referenced) {
      try {
        const info = await stat(join(runtimePath, rel));
        if (!info.isFile() || info.size === 0) missing.push(`${rel} (empty)`);
      } catch {
        missing.push(rel);
      }
    }
    components[key] = missing.length === 0;
    if (missing.length > 0) {
      detail[key] = `index.html references bundle file(s) not present under ${runtimePath}: ${missing.join(', ')}. ` +
        'The deployed frontend build does not match what is being served — likely a stale or half-copied bundle.';
    }
  }

  /**
   * Cheap, non-blocking legacy-UUID probe on the two tables most likely to
   * be resubmitted through an `@IsUUID()` field (`treasury_accounts` and
   * the acting user's own `users.id`). A full per-table census belongs to
   * `verify-deploy.sh` / the Controlled Data Repair audit — not to a check
   * that runs mid-deploy.
   */
  private async warnOnLegacyUuidData(warnings: Record<string, string>): Promise<void> {
    for (const table of ['treasury_accounts', 'users']) {
      try {
        const rows: Array<{ count: string }> = await this.dataSource.query(
          `SELECT count(*)::text AS count FROM "${table}" WHERE id::text !~* $1`,
          [STRICT_UUID_REGEX.source],
        );
        const n = Number(rows[0]?.count ?? 0);
        if (n > 0) {
          warnings[`data.uuid_compliance.${table}`] =
            `${n} row(s) in "${table}" have a non-RFC4122 primary key (legacy generator). ` +
            'These will fail @IsUUID() if resubmitted from the UI. Run a Controlled Data Repair (DATA_REPAIR_RUNBOOK.md) — not a deploy blocker.';
        }
      } catch {
        // table absent / not migrated yet — nothing to warn about.
      }
    }
  }
}
