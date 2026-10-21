import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { join } from 'path';
import { AppConfigService } from '../configuration/app-config.service';
import { migrationNamesByTag, pendingFor, tagsReceivedByCompany } from '../release/migration-names';
import { discoverMigrationTags } from '../release/migration-datasource';
import { DaiiException } from '../error-contract/daii-exception';

/**
 * Company SCHEMA ADMISSION (CTO 2026-10-21, 1.1.12). The interim-period guard: a release can be LIVE while a Company database is still on an older schema (the state the
 * 1.1.10 and 1.1.11 upgrades left on the host). Without this, the new code runs against missing tables/columns: some screens answer HTTP 500, others work, and any path
 * that writes before it reads a missing column can leave partial state. With it, EVERY acquisition of a Company database (the request guard and the schedulers alike - they
 * all go through `CompanyConnectionManagerService.getDataSource`) first proves the Company has every migration this build ships for the tags it already has, and
 * otherwise refuses with ONE clear, stable answer - HTTP 503 `COMPANY_SCHEMA_BEHIND` - before any query of the application touches that database.
 *
 * - The check is a single read of the Company's own `migrations` table compared with the migration files of the RUNNING build (the same tag rule the deploy uses:
 *   `core` + every tag the Company already has). A Company that is AHEAD of the build (a rollback to an older build on a newer schema) is admitted: migrations are
 *   expand-only, so the older build keeps working on it.
 * - Platform routes (the Release Center that performs the catch-up) never go through a Company database and stay available.
 * - Positive results are cached for a short time (one read per Company per TTL, not per request); a refusal is cached only briefly so that service resumes within
 *   seconds of the catch-up, with no restart.
 * - Fail-open ONLY where the check cannot judge: a build with no compiled migrations on disk (a dev run) or a read that fails (the real error surfaces from the actual
 *   query; a transient blip must not become an outage). Never fail-open on a successful read that shows pending migrations.
 * - `COMPANY_SCHEMA_ADMISSION=enforce` (default) | `report` (log only) | `off`.
 */
export const COMPANY_SCHEMA_BEHIND_CODE = 'COMPANY_SCHEMA_BEHIND';

/**
 * HTTP 503 with the stable code `COMPANY_SCHEMA_BEHIND` (a `DaiiException`, so the global error filter keeps the code in the response envelope); carries no Company data,
 * only what the operator must do.
 */
export class CompanySchemaBehindException extends DaiiException {
  constructor() {
    super(
      COMPANY_SCHEMA_BEHIND_CODE,
      'This Company is being upgraded to the installed version and is temporarily unavailable. A platform administrator must complete the Company catch-up (Release Center). / ' +
        'هذه الشركة قيد الترقية إلى الإصدار المثبّت وغير متاحة مؤقتًا؛ يجب أن يستكمل مسؤول المنصة ترحيل قواعد بيانات الشركات من مركز الإصدارات.',
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}

export type SchemaAdmissionMode = 'enforce' | 'report' | 'off';
/** `judged: false` = the check could not decide (no compiled migrations, or the read failed): admitted, and never cached, so the next request decides again. */
interface Verdict {
  behind: boolean;
  pending: number;
  judged: boolean;
}
const POSITIVE_TTL_MS = 30_000;
const NEGATIVE_TTL_MS = 5_000;

@Injectable()
export class CompanySchemaAdmission {
  private readonly logger = new Logger(CompanySchemaAdmission.name);
  private shipped: Map<string, Set<string>> | null = null;
  private readonly verdicts = new Map<string, { behind: boolean; pending: number; until: number }>();
  private readonly inFlight = new Map<string, Promise<Verdict>>();
  private lastReportLog = 0;

  /** Test seam (never set in production): the shipped migration names, the clock and the mode. */
  overrides?: { shipped?: Map<string, Set<string>>; now?: () => number; mode?: SchemaAdmissionMode };

  constructor(@Optional() private readonly config?: AppConfigService) {}

  private mode(): SchemaAdmissionMode {
    return this.overrides?.mode ?? this.config?.companySchemaAdmission ?? 'enforce';
  }
  private now(): number {
    return this.overrides?.now ? this.overrides.now() : Date.now();
  }

  /** The migration names the RUNNING build ships, per tag (read once). Empty when the build has no compiled migrations on disk. */
  private shippedByTag(): Map<string, Set<string>> {
    if (this.overrides?.shipped) return this.overrides.shipped;
    if (!this.shipped) {
      const appRoot = this.config?.releaseExecution?.appRoot ?? process.cwd();
      const tags = discoverMigrationTags(appRoot);
      this.shipped = migrationNamesByTag(appRoot, tags);
      const total = [...this.shipped.values()].reduce((n, s) => n + s.size, 0);
      if (total === 0) this.logger.warn(`Company schema admission cannot judge: no compiled migrations under ${join(appRoot, 'dist', 'database', 'migrations')} (a development run?) - admitting.`);
    }
    return this.shipped;
  }

  /** Throws `CompanySchemaBehindException` (enforce) when this Company lacks a migration the running build ships for its tags; otherwise returns. */
  async assertCurrent(companyId: string, dataSource: DataSource): Promise<void> {
    const mode = this.mode();
    if (mode === 'off') return;
    const verdict = await this.verdictFor(companyId, dataSource);
    if (!verdict.behind) return;
    if (mode === 'report') {
      const t = this.now();
      if (t - this.lastReportLog > 60_000) {
        this.lastReportLog = t;
        this.logger.warn(`Company ${companyId} is behind this build (${verdict.pending} pending migration(s)); COMPANY_SCHEMA_ADMISSION=report: admitted.`);
      }
      return;
    }
    throw new CompanySchemaBehindException();
  }

  /** Forget the cached verdict of a Company (a catch-up / deploy that just migrated it calls this; the short refusal TTL does the same within seconds). */
  invalidate(companyId?: string): void {
    if (companyId) this.verdicts.delete(companyId);
    else this.verdicts.clear();
  }

  private async verdictFor(companyId: string, dataSource: DataSource): Promise<Verdict> {
    const cached = this.verdicts.get(companyId);
    if (cached && cached.until > this.now()) return { behind: cached.behind, pending: cached.pending, judged: true };
    const running = this.inFlight.get(companyId);
    if (running) return running;
    const p = this.evaluate(dataSource)
      .then((v) => {
        if (v.judged) this.verdicts.set(companyId, { behind: v.behind, pending: v.pending, until: this.now() + (v.behind ? NEGATIVE_TTL_MS : POSITIVE_TTL_MS) });
        if (v.behind) this.logger.warn(`Company ${companyId} is behind this build: ${v.pending} pending migration(s) - refusing Company operations until the catch-up completes.`);
        return v;
      })
      .finally(() => this.inFlight.delete(companyId));
    this.inFlight.set(companyId, p);
    return p;
  }

  private async evaluate(dataSource: DataSource): Promise<Verdict> {
    const byTag = this.shippedByTag();
    if ([...byTag.values()].every((s) => s.size === 0)) return { behind: false, pending: 0, judged: false }; // cannot judge
    let executed: Set<string>;
    try {
      const rows: Array<{ name: string }> = await dataSource.query('SELECT name FROM migrations');
      executed = new Set(rows.map((r) => String(r.name)));
    } catch (err) {
      this.logger.warn(`Company schema admission could not read the migrations table (${err instanceof Error ? err.message : String(err)}) - not judging.`);
      return { behind: false, pending: 0, judged: false };
    }
    const tags = tagsReceivedByCompany(byTag, executed);
    const pending = pendingFor(byTag, tags, executed);
    return { behind: pending.length > 0, pending: pending.length, judged: true };
  }
}
