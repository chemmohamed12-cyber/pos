import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AppConfigService } from '../configuration/app-config.service';
import { AuditService } from '../audit/audit.service';
import { readAppVersion } from './app-version';
import { Release } from './release.entity';
import { CompanyBackupEvidence, CompanyFanoutBlockedError, CompanyFanoutService, summarizePlan, summarizeResult } from './company-fanout.service';
import { hasFindings } from './company-schema-check';

/**
 * Company catch-up (CTO 2026-10-21, 1.1.12): the remediation path for a release that is ALREADY LIVE while some Company databases are still on an older schema - the
 * state the 1.1.10 and 1.1.11 upgrades left on the host (platform migrated, Companies not). A live version cannot be deployed again (the engine refuses it), so this
 * runs the SAME CompanyFanoutService as a deploy does, against the INSTALLED application root, as an explicit, confirmed, audited operator action:
 *
 *   refuse while a deploy is in flight / the installed version is not a live release row  ->  plan (read-only)  ->  refuse on blockers, unknown history, drift nobody
 *   can migrate away  ->  the operator's confirmation must name EXACTLY the databases that will be touched  ->  verified restore point per Company BEFORE any change
 *   ->  sequential migration, stop at the first failure  ->  independent re-check (pending + schema) of every Company.
 *
 * Nothing here contains SQL, re-implements a migration, or drops/resets anything; each migration is recorded once by TypeORM, a second run finds nothing pending.
 * It is NOT a deploy: it never swaps, restarts or changes the active release. Non-READY Companies are reported, never touched.
 */
export type CatchUpStatus = 'NOTHING_TO_DO' | 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'SCHEMA_DRIFT';

export interface CatchUpResult {
  status: CatchUpStatus;
  releaseId: string;
  installedBuild: string;
  /** Companies (database names) that had pending migrations when the plan was taken. */
  databasesWithPending: string[];
  migrated: string[];
  failed: Array<{ company: string; error: string | null }>;
  notAttempted: string[];
  stillPending: Record<string, string[]>;
  schemaProblems: Record<string, unknown>;
  skippedNotReady: Array<{ company: string | null; status: string | null }>;
  note: string;
}

export class CatchUpRefusedError extends ConflictException {}

@Injectable()
export class CompanyCatchUpService {
  private readonly logger = new Logger(CompanyCatchUpService.name);
  private running = false;

  constructor(
    private readonly fanout: CompanyFanoutService,
    private readonly config: AppConfigService,
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  /** Read-only: what a catch-up would touch (the same plan the live status shows) - the exact list the operator must confirm. */
  async preview(): Promise<{ databasesNeedingCatchUp: string[]; refusal: string | null }> {
    try {
      const { plan } = await this.prepare();
      return { databasesNeedingCatchUp: plan.planned.filter((c) => c.pending.length > 0).map((c) => c.databaseName).sort(), refusal: null };
    } catch (err) {
      if (err instanceof CatchUpRefusedError) return { databasesNeedingCatchUp: [], refusal: err.message };
      throw err;
    }
  }

  private async prepare() {
    const installedBuild = readAppVersion();
    const release = await this.dataSource.getRepository(Release).findOne({ where: { version: installedBuild, status: 'succeeded' }, order: { uploadedAt: 'DESC' } });
    if (!release) {
      throw new CatchUpRefusedError(`No succeeded release row exists for the installed version ${installedBuild}: catch-up only repairs Companies of a release that is live.`);
    }
    const inFlight = await this.dataSource.getRepository(Release).count({ where: [{ status: 'deploying' }, { status: 'migrating' }, { status: 'health_checking' }] });
    if (inFlight > 0) throw new CatchUpRefusedError('A deploy is in progress; catch-up refuses to run next to it.');
    const plan = await this.fanout.plan(this.config.releaseExecution.appRoot);
    return { release, installedBuild, plan };
  }

  async run(actorUserId: string, confirmDatabases: readonly string[]): Promise<CatchUpResult> {
    if (this.running) throw new CatchUpRefusedError('A catch-up is already running.');
    this.running = true;
    try {
      return await this.runLocked(actorUserId, confirmDatabases);
    } finally {
      this.running = false;
    }
  }

  private async runLocked(actorUserId: string, confirmDatabases: readonly string[]): Promise<CatchUpResult> {
    const { release, installedBuild, plan } = await this.prepare();
    const audit = (action: string, result: 'success' | 'failure' | 'denied', after: Record<string, unknown>) =>
      this.audit.record({ actorUserId, organizationId: null, action: `release.company_catchup.${action}`, resource: 'release', resourceId: release.id, result, correlationId: null, after });
    const appRoot = this.config.releaseExecution.appRoot;
    const withPending = plan.planned.filter((c) => c.pending.length > 0);
    const base = {
      releaseId: release.id,
      installedBuild,
      databasesWithPending: withPending.map((c) => c.databaseName).sort(),
      migrated: [] as string[],
      failed: [] as Array<{ company: string; error: string | null }>,
      notAttempted: [] as string[],
      stillPending: {} as Record<string, string[]>,
      schemaProblems: {} as Record<string, unknown>,
      skippedNotReady: plan.skipped.filter((s) => s.scope !== 'out_of_scope').map((s) => ({ company: s.companyName, status: s.status ?? null })),
    };
    await audit('planned', plan.blockers.length === 0 ? 'success' : 'denied', summarizePlan(plan));

    const refuse = async (reason: string): Promise<never> => {
      await audit('refused', 'denied', { reason });
      throw new CatchUpRefusedError(reason);
    };
    if (plan.blockers.length > 0) await refuse(`A READY Company could not be evaluated: ${plan.blockers.join(' | ')}`);
    const unknown = plan.planned.filter((c) => (c.unknownMigrations?.length ?? 0) > 0);
    if (unknown.length > 0) await refuse(`COMPANY_HISTORY_UNKNOWN: ${unknown.map((c) => c.companyName).join(', ')} hold migrations this build does not ship; nothing was changed.`);

    const drift = plan.planned.filter((c) => c.pending.length === 0 && c.schema?.ran && hasFindings(c.schema.findings));
    if (withPending.length === 0) {
      if (drift.length > 0) {
        await audit('schema_drift', 'denied', { companies: drift.map((c) => c.companyName) });
        return { ...base, status: 'SCHEMA_DRIFT', note: 'No Company has pending migrations, but some do not match the schema this build queries. No migration can repair that; nothing was changed.' };
      }
      await audit('nothing_to_do', 'success', {});
      return { ...base, status: 'NOTHING_TO_DO', note: 'Every READY Company is current; nothing was changed.' };
    }

    // the operator must name EXACTLY the databases that will be touched (no more, no fewer)
    const expected = [...base.databasesWithPending];
    const given = [...confirmDatabases].sort();
    if (JSON.stringify(expected) !== JSON.stringify(given)) {
      await refuse(`The confirmation must list exactly the Company databases that will be migrated: ${expected.join(', ')}. Nothing was changed.`);
    }

    let backups: CompanyBackupEvidence[];
    try {
      backups = await this.fanout.ensureBackups(plan, actorUserId);
    } catch (err) {
      if (err instanceof CompanyFanoutBlockedError) await refuse(`No verified restore point for every affected Company: ${err.blockers.join(' | ')}. Nothing was migrated.`);
      throw err;
    }
    await audit('restore_points', 'success', { backups });

    const result = await this.fanout.migrate(plan, appRoot, actorUserId, release.id, backups);
    const summary = summarizeResult(result);
    base.migrated = summary.migrated as string[];
    base.failed = ((summary.failed as Array<{ company: string; error: string | null }>) ?? []).map((f) => ({ company: f.company, error: f.error }));
    base.notAttempted = summary.notAttempted as string[];

    base.stillPending = await this.fanout.verify(plan, appRoot);
    const schemaAfter = await this.fanout.verifySchema(plan, appRoot);
    for (const [company, s] of Object.entries(schemaAfter)) {
      if (!s.ran || hasFindings(s.findings)) base.schemaProblems[company] = { ran: s.ran, error: s.error ?? null, missingTables: s.findings.missingTables.slice(0, 20), missingColumns: s.findings.missingColumns };
    }
    const failed = !result.ok || Object.keys(base.stillPending).length > 0 || Object.keys(base.schemaProblems).length > 0;
    const partial = !failed && base.skippedNotReady.length > 0;
    const status: CatchUpStatus = failed ? 'FAILED' : partial ? 'PARTIAL' : 'SUCCESS';
    await audit('completed', failed ? 'failure' : 'success', { status, migrated: base.migrated, failed: base.failed, notAttempted: base.notAttempted, stillPending: base.stillPending, schemaProblems: base.schemaProblems });
    this.logger.log(`Company catch-up ${status}: migrated [${base.migrated.join(', ')}], failed ${base.failed.length}, still pending ${Object.keys(base.stillPending).length}`);
    const note = failed
      ? 'Do not re-run blindly: read which Company stopped and why, fix the cause, then run again (completed migrations are not repeated).'
      : partial
        ? 'Some Companies are not READY and were not touched; catch them up before they are reactivated.'
        : 'Every READY Company is migrated and re-verified (pending migrations and schema).';
    return { ...base, status, note };
  }
}
