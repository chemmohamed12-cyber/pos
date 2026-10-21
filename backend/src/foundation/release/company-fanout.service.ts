import { resolve } from 'path';
import { Injectable, Logger } from '@nestjs/common';
import { DataSource, MigrationExecutor } from 'typeorm';
import { AppConfigService } from '../configuration/app-config.service';
import { AuditService } from '../audit/audit.service';
import { CompanyService } from '../company/company.service';
import { isValidCompanyTransition, CompanyStatus } from '../company/company-status';
import { DatabaseRegistryService } from '../database-registry/database-registry.service';
import { runMigrationsForDatabase } from '../release-orchestration/company-migration-runner';
import { BackupManagerService } from './backup-manager.service';
import { CompanySchemaCheckResult, checkCompanySchema, summarizeFindings } from './company-schema-check';
import { createMigrationDataSource, discoverMigrationTags } from './migration-datasource';
import { migrationNamesByTag, tagsReceivedByCompany } from './migration-names';

/** True when `candidatePath` is the application root of the build that is running this process (dist/foundation/release -> three levels up). */
export function isRunningBuildRoot(candidatePath: string): boolean {
  const norm = (p: string) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
  return norm(candidatePath) === norm(resolve(__dirname, '..', '..', '..'));
}

/**
 * Release Engine — Company fan-out (CTO 2026-10-08). The capability the Production Engine did not have: a staged deploy that upgrades the EXISTING Company
 * databases as well as the Platform database. It is a step INSIDE `ReleaseExecutionService.deployReleaseStaged` (see there), strictly PRE-SWAP, so a failure
 * anywhere here leaves ACTIVE bit-for-bit untouched (I-2) — and, because every release migration is expand-only (I-8), a Company that was already migrated
 * keeps working with the OLD code that is still active. That is the whole partial-failure policy: stop at the first failure, never continue, never roll a
 * migrated Company back (forward-only), report exactly who was migrated / failed / not attempted.
 *
 * Design decisions (all in `docs/decisions/RELEASE-ENGINE-COMPANY-FANOUT-DESIGN-2026-10-08.md`):
 *  - DISCOVERY: every `ACTIVE` DatabaseRegistry row whose Company is `READY` (DP-9 O-4: operational work only in READY). Others are reported as skipped, never touched.
 *  - WHICH MIGRATIONS: a Company receives the migrations of the tags it ALREADY has (a tag is "had" when at least one of its migrations is recorded as executed in
 *    the Company's own `migrations` table), plus `core`, intersected with the release's entitlement scope. A tag a Company never received is never applied by a
 *    release — enabling a module for a Company is a Plans operation, not a deploy side effect.
 *  - RESTORE POINT: per Company, either a fresh verified `pre_update` backup taken by the engine, or a verified recent one that must already exist.
 *  - LIFECYCLE: READY -> MIGRATING while that Company's migrations run (LA-1 admission then refuses operational work on it), MIGRATING -> READY after. A failure
 *    that provably changed nothing (pending set unchanged) returns the Company to READY; anything else leaves it MIGRATING on purpose (the state machine has no
 *    MIGRATING -> FAILED edge, and a Company in doubt must stay closed) and is reported.
 *  - EVIDENCE: one audit record per Company per step, in the platform audit chain. Never a credential.
 */
export type CompanyFanoutMode = 'off' | 'dry-run' | 'on';

export interface PlannedCompany {
  companyId: string;
  companyName: string;
  databaseName: string;
  /** The tags this Company receives in this release. */
  tags: string[];
  /** Names of the migrations that will run (or, in dry-run, would run). */
  pending: string[];
  /**
   * Migrations RECORDED as executed in this Company database that the candidate does not ship at all (any tag). A Company ahead of the candidate or with a divergent
   * history (a newer build's migration, a hand-applied row): deploying over it is not a plain upgrade, so the gate refuses it.
   */
  unknownMigrations?: string[];
  /** Read-only schema check of this Company database against the candidate's entity registry (taken at plan time, i.e. BEFORE any migration). */
  schema?: CompanySchemaCheckResult;
}

export interface SkippedCompany {
  companyId: string;
  companyName: string | null;
  reason: string;
  /** The Company lifecycle status that made it skipped (`null` = registry row without a Company). */
  status?: string | null;
  /**
   * DECOMMISSIONED = out of scope (never migrated, never blocks). Anything else that is not READY is STALE: it cannot be migrated now and would later run the new
   * code on the old schema unless it is caught up before it is reactivated.
   */
  scope?: 'out_of_scope' | 'stale';
}

export interface CompanyFanoutPlan {
  mode: CompanyFanoutMode;
  /** The tag directories in scope for this release (the entitlement scope, or every tag on disk). Verification and failure re-checks use the same scope as the plan. */
  scope: string[];
  planned: PlannedCompany[];
  skipped: SkippedCompany[];
  /** Anything that makes it unsafe to proceed (a READY Company that cannot be evaluated). Non-empty => the deploy aborts pre-swap. */
  blockers: string[];
}

export type CompanyOutcomeStatus = 'migrated' | 'noop' | 'failed' | 'not_attempted';

export interface CompanyOutcome {
  companyId: string;
  companyName: string;
  status: CompanyOutcomeStatus;
  executed: string[];
  error: string | null;
  /** The Company's lifecycle status after its turn. `MIGRATING` here means "left closed on purpose" and needs an operator. */
  finalCompanyStatus: string;
  durationMs: number;
}

export interface CompanyFanoutResult {
  ok: boolean;
  outcomes: CompanyOutcome[];
}

export interface CompanyBackupEvidence {
  companyId: string;
  backupRunId: string;
  basis: 'created' | 'recent';
}

/** The restore-point gate refused: nothing was migrated. */
export class CompanyFanoutBlockedError extends Error {
  constructor(readonly blockers: string[]) {
    super(`Company fan-out blocked: ${blockers.join(' | ')}`);
    this.name = 'CompanyFanoutBlockedError';
  }
}

// the pure name helpers live in migration-names.ts (shared with the run-time Company schema admission); re-exported here for existing importers
export { migrationNamesByTag, tagsReceivedByCompany };

/** Audit-safe summary of a plan (no credentials, no connection strings). */
export function summarizePlan(plan: CompanyFanoutPlan): Record<string, unknown> {
  return {
    mode: plan.mode,
    companies: plan.planned.map((c) => ({
      companyId: c.companyId,
      name: c.companyName,
      database: c.databaseName,
      tags: c.tags,
      pendingCount: c.pending.length,
      pending: c.pending,
      ...(c.unknownMigrations && c.unknownMigrations.length > 0 ? { unknownMigrations: c.unknownMigrations.slice(0, 20), unknownMigrationCount: c.unknownMigrations.length } : {}),
      ...(c.schema ? { schemaCheck: { ran: c.schema.ran, checkedTables: c.schema.checkedTables, ...(c.schema.error ? { error: c.schema.error } : {}), ...summarizeFindings(c.schema.findings) } } : {}),
    })),
    counts: {
      companiesEvaluated: plan.planned.length,
      companiesWithPendingMigrations: plan.planned.filter((c) => c.pending.length > 0).length,
      companiesWithUnknownMigrations: plan.planned.filter((c) => (c.unknownMigrations?.length ?? 0) > 0).length,
      companiesSkippedStale: plan.skipped.filter((c) => c.scope !== 'out_of_scope').length,
      companiesOutOfScope: plan.skipped.filter((c) => c.scope === 'out_of_scope').length,
    },
    skipped: plan.skipped,
    blockers: plan.blockers,
    scope: plan.scope,
  };
}

export function summarizeResult(result: CompanyFanoutResult): Record<string, unknown> {
  return {
    ok: result.ok,
    migrated: result.outcomes.filter((o) => o.status === 'migrated').map((o) => o.companyName),
    noop: result.outcomes.filter((o) => o.status === 'noop').map((o) => o.companyName),
    failed: result.outcomes.filter((o) => o.status === 'failed').map((o) => ({ company: o.companyName, error: o.error, finalCompanyStatus: o.finalCompanyStatus })),
    notAttempted: result.outcomes.filter((o) => o.status === 'not_attempted').map((o) => o.companyName),
  };
}

@Injectable()
export class CompanyFanoutService {
  private readonly logger = new Logger(CompanyFanoutService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly registry: DatabaseRegistryService,
    private readonly companies: CompanyService,
    private readonly backups: BackupManagerService,
    private readonly platform: DataSource,
    private readonly audit: AuditService,
  ) {}

  mode(): CompanyFanoutMode {
    return this.config.releaseDeploy.companyMigrations ?? 'off';
  }

  // ───────────────────────────────────────────── plan (read-only) ─────────────────────────────────────────────

  /**
   * Discover the READY Companies and compute, per Company, its tags and pending migrations against the CANDIDATE's compiled migration set. Reads only.
   * A READY Company that cannot be evaluated (credential, connection, ...) is a BLOCKER, not a skip: deploying around a Company we could not look at would
   * leave it on the old schema under new code without anyone having decided that.
   */
  async plan(candidatePath: string, releaseTags?: readonly string[]): Promise<CompanyFanoutPlan> {
    const scope = releaseTags ?? discoverMigrationTags(candidatePath);
    const byTag = migrationNamesByTag(candidatePath, scope);
    // everything the candidate ships, whatever the entitlement scope: a recorded migration outside this set is UNKNOWN to the candidate
    const shippedAll = new Set<string>();
    for (const names of migrationNamesByTag(candidatePath, discoverMigrationTags(candidatePath)).values()) for (const n of names) shippedAll.add(n);
    const plan: CompanyFanoutPlan = { mode: this.mode(), scope: [...scope], planned: [], skipped: [], blockers: [] };

    for (const reg of await this.registry.findAllActive()) {
      const company = await this.companies.findById(reg.companyId);
      if (!company) {
        plan.skipped.push({ companyId: reg.companyId, companyName: null, reason: 'registry row without a Company', status: null, scope: 'stale' });
        continue;
      }
      if (company.status !== 'READY') {
        plan.skipped.push({ companyId: company.id, companyName: company.name, reason: `Company status is ${company.status}, not READY`, status: company.status, scope: company.status === 'DECOMMISSIONED' ? 'out_of_scope' : 'stale' });
        continue;
      }
      try {
        const evaluated = await this.evaluate(company.id, candidatePath, scope, byTag, shippedAll);
        const schema = await this.schemaCheck(company.id, candidatePath, evaluated.tags);
        plan.planned.push({ companyId: company.id, companyName: company.name, databaseName: reg.databaseName, ...evaluated, schema });
      } catch (err) {
        plan.blockers.push(`Company "${company.name}" (${company.id}) could not be evaluated: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    plan.planned.sort((a, b) => a.companyName.localeCompare(b.companyName) || a.companyId.localeCompare(b.companyId));
    return plan;
  }

  private async evaluate(
    companyId: string,
    candidatePath: string,
    scope: readonly string[],
    byTag: Map<string, Set<string>>,
    shippedAll?: ReadonlySet<string>,
  ): Promise<{ tags: string[]; pending: string[]; unknownMigrations?: string[] }> {
    const cfg = await this.registry.getConnectionConfigForCompany(companyId);
    const ds = createMigrationDataSource(candidatePath, cfg, scope);
    await ds.initialize();
    try {
      const executedRows: Array<{ name: string }> = await ds.query('SELECT name FROM migrations');
      const executed = new Set(executedRows.map((r) => r.name));
      const tags = tagsReceivedByCompany(byTag, executed);
      const inScope = new Set<string>();
      for (const t of tags) for (const n of byTag.get(t) ?? []) inScope.add(n);
      const pendingAll = (await new MigrationExecutor(ds).getPendingMigrations()).map((m) => m.name as string);
      const unknownMigrations = shippedAll ? [...executed].filter((n) => !shippedAll.has(n)).sort() : undefined;
      return { tags, pending: pendingAll.filter((n) => inScope.has(n)), ...(unknownMigrations ? { unknownMigrations } : {}) };
    } finally {
      if (ds.isInitialized) await ds.destroy();
    }
  }

  /** Read-only schema check of one Company database against the candidate (see company-schema-check.ts). Never throws: an unrunnable check is `ran: false`, never "clean". */
  async schemaCheck(companyId: string, candidatePath: string, tags: readonly string[]): Promise<CompanySchemaCheckResult> {
    try {
      const cfg = await this.registry.getConnectionConfigForCompany(companyId);
      return await checkCompanySchema(candidatePath, cfg, tags, this.config.releaseBuild.nodeBin, undefined, isRunningBuildRoot(candidatePath));
    } catch (err) {
      return { ran: false, checkedTables: 0, findings: { missingTables: [], missingColumns: {} }, error: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300) };
    }
  }

  /** Post-migration schema check of every planned Company, re-derived from the database (never from the migration run's own report). */
  async verifySchema(plan: CompanyFanoutPlan, candidatePath: string): Promise<Record<string, CompanySchemaCheckResult>> {
    const out: Record<string, CompanySchemaCheckResult> = {};
    for (const c of plan.planned) out[c.companyName] = await this.schemaCheck(c.companyId, candidatePath, c.tags);
    return out;
  }

  // ───────────────────────────────────────────── restore points ─────────────────────────────────────────────

  /** One restore point per Company that actually has something to migrate. Refuses (throws) before ANY migration if any Company lacks one. */
  async ensureBackups(plan: CompanyFanoutPlan, actorUserId: string): Promise<CompanyBackupEvidence[]> {
    const { companyBackupPolicy, companyBackupMaxAgeHours } = this.config.releaseDeploy;
    const evidence: CompanyBackupEvidence[] = [];
    const blockers: string[] = [];
    for (const c of plan.planned.filter((p) => p.pending.length > 0)) {
      try {
        if (companyBackupPolicy === 'require-recent') {
          const rows: Array<{ id: string }> = await this.platform.query(
            `SELECT r."id" FROM "backup_runs" r
              WHERE r."companyId" = $1 AND r."completedAt" IS NOT NULL AND r."completedAt" >= now() - make_interval(hours => $2)
                AND EXISTS (SELECT 1 FROM "backup_artifacts" a WHERE a."backupRunId" = r."id" AND a."type" = 'database' AND a."status" = 'verified')
              ORDER BY r."completedAt" DESC LIMIT 1`,
            [c.companyId, companyBackupMaxAgeHours],
          );
          if (rows.length === 0) blockers.push(`Company "${c.companyName}" has no verified backup newer than ${companyBackupMaxAgeHours}h (RELEASE_COMPANY_BACKUP_POLICY=require-recent)`);
          else evidence.push({ companyId: c.companyId, backupRunId: rows[0].id, basis: 'recent' });
        } else {
          const run = await this.backups.createBackup('pre_update', actorUserId, c.companyId);
          const verified: Array<{ x: number }> = await this.platform.query(
            `SELECT 1 AS x FROM "backup_artifacts" WHERE "backupRunId" = $1 AND "type" = 'database' AND "status" = 'verified'`,
            [run.id],
          );
          if (verified.length === 0) blockers.push(`the pre-update backup of Company "${c.companyName}" (run ${run.id}) did not verify`);
          else evidence.push({ companyId: c.companyId, backupRunId: run.id, basis: 'created' });
        }
      } catch (err) {
        blockers.push(`Company "${c.companyName}": restore point failed — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (blockers.length > 0) throw new CompanyFanoutBlockedError(blockers);
    return evidence;
  }

  // ───────────────────────────────────────────── execute ─────────────────────────────────────────────

  /** Sequential, stop at the first failure. Companies after the failing one are reported `not_attempted` and are not touched. */
  async migrate(plan: CompanyFanoutPlan, candidatePath: string, actorUserId: string, releaseId: string, backups: readonly CompanyBackupEvidence[] = []): Promise<CompanyFanoutResult> {
    const outcomes: CompanyOutcome[] = [];
    let stopped = false;
    for (const c of plan.planned) {
      if (stopped) {
        outcomes.push({ companyId: c.companyId, companyName: c.companyName, status: 'not_attempted', executed: [], error: null, finalCompanyStatus: 'READY', durationMs: 0 });
        continue;
      }
      let outcome: CompanyOutcome;
      try {
        outcome = await this.migrateOne(plan, c, candidatePath, actorUserId, releaseId, backups.find((b) => b.companyId === c.companyId) ?? null);
      } catch (err) {
        // never lose the report of who was already migrated: an unexpected throw becomes this Company's failure, and the sweep stops as for any failure
        const error = `unexpected error: ${err instanceof Error ? err.message : String(err)}`;
        const now = await this.companies.findById(c.companyId).catch(() => null);
        outcome = { companyId: c.companyId, companyName: c.companyName, status: 'failed', executed: [], error, finalCompanyStatus: now?.status ?? 'unknown', durationMs: 0 };
        await this.audit.record({ actorUserId, organizationId: null, action: 'release.deploy.company_migration_failed', resource: 'release', resourceId: releaseId, result: 'failure', correlationId: null, after: { companyId: c.companyId, companyName: c.companyName, error, stage: 'unexpected' } }).catch(() => undefined);
      }
      outcomes.push(outcome);
      if (outcome.status === 'failed') stopped = true;
    }
    return { ok: !outcomes.some((o) => o.status === 'failed'), outcomes };
  }

  private async migrateOne(plan: CompanyFanoutPlan, c: PlannedCompany, candidatePath: string, actorUserId: string, releaseId: string, backup: CompanyBackupEvidence | null): Promise<CompanyOutcome> {
    const started = Date.now();
    const base = { companyId: c.companyId, companyName: c.companyName };
    const emit = (action: string, result: 'success' | 'failure', after: Record<string, unknown>) =>
      this.audit.record({ actorUserId, organizationId: null, action: `release.deploy.company_migration_${action}`, resource: 'release', resourceId: releaseId, result, correlationId: null, after: { ...base, ...after } });

    if (c.pending.length === 0) {
      await emit('noop', 'success', { tags: c.tags, note: 'nothing pending' });
      return { ...base, status: 'noop', executed: [], error: null, finalCompanyStatus: 'READY', durationMs: 0 };
    }

    // Re-check at execution time (LA-1 principle): a Company suspended between plan and turn is not migrated, and the deploy stops.
    const current = await this.companies.findById(c.companyId);
    if (!current || current.status !== 'READY') {
      const error = `Company is ${current?.status ?? 'missing'} at its turn, not READY`;
      await emit('failed', 'failure', { error, stage: 'admission' });
      return { ...base, status: 'failed', executed: [], error, finalCompanyStatus: current?.status ?? 'missing', durationMs: Date.now() - started };
    }

    await emit('started', 'success', { tags: c.tags, pending: c.pending, backupRunId: backup?.backupRunId ?? null, backupBasis: backup?.basis ?? null });
    try {
      await this.transition(c.companyId, 'MIGRATING');
    } catch (err) {
      const error = `could not enter MIGRATING: ${err instanceof Error ? err.message : String(err)}`;
      await emit('failed', 'failure', { error, stage: 'lifecycle' });
      return { ...base, status: 'failed', executed: [], error, finalCompanyStatus: 'READY', durationMs: Date.now() - started };
    }

    const cfg = await this.registry.getConnectionConfigForCompany(c.companyId);
    const run = await runMigrationsForDatabase(candidatePath, cfg, c.tags);

    if (run.success) {
      let finalStatus = 'READY';
      try {
        await this.transition(c.companyId, 'READY');
      } catch (err) {
        finalStatus = 'MIGRATING';
        this.logger.error(`Company ${c.companyId} migrated but could not return to READY: ${err instanceof Error ? err.message : String(err)}`);
      }
      const ok = finalStatus === 'READY';
      await emit(ok ? 'succeeded' : 'failed', ok ? 'success' : 'failure', { tags: c.tags, executed: run.ranMigrationNames, finalCompanyStatus: finalStatus, durationMs: Date.now() - started, ...(ok ? {} : { error: 'migrated, but could not return to READY', stage: 'lifecycle' }) });
      return { ...base, status: ok ? 'migrated' : 'failed', executed: run.ranMigrationNames, error: ok ? null : 'migrated, but could not return to READY', finalCompanyStatus: finalStatus, durationMs: Date.now() - started };
    }

    // Failed. TypeORM runs the batch in one transaction, so normally nothing changed. PROVE it before reopening the Company: the pending set must equal the plan.
    let provablyUnchanged = false;
    try {
      const again = await this.evaluate(c.companyId, candidatePath, plan.scope, migrationNamesByTag(candidatePath, plan.scope));
      provablyUnchanged = again.pending.length === c.pending.length && again.pending.every((n) => c.pending.includes(n));
    } catch {
      provablyUnchanged = false;
    }
    let finalStatus = 'MIGRATING';
    if (provablyUnchanged) {
      try {
        await this.transition(c.companyId, 'READY');
        finalStatus = 'READY';
      } catch (err) {
        this.logger.error(`Company ${c.companyId}: migration failed, unchanged, but could not return to READY: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await emit('failed', 'failure', { tags: c.tags, error: run.error, stage: 'migration', databaseProvablyUnchanged: provablyUnchanged, finalCompanyStatus: finalStatus, ...(finalStatus === 'MIGRATING' ? { note: 'left MIGRATING on purpose: operator must inspect, then MIGRATING -> READY' } : {}) });
    return { ...base, status: 'failed', executed: [], error: run.error, finalCompanyStatus: finalStatus, durationMs: Date.now() - started };
  }

  private async transition(companyId: string, to: CompanyStatus): Promise<void> {
    const company = await this.companies.findById(companyId);
    if (!company) throw new Error(`Company not found: ${companyId}`);
    if (!isValidCompanyTransition(company.status, to)) throw new Error(`invalid Company transition ${company.status} -> ${to}`);
    await this.companies.update(companyId, { status: to });
  }

  // ───────────────────────────────────────────── verify ─────────────────────────────────────────────

  /** Independent post-condition (never "the call did not throw"): re-derive each planned Company's pending set from TypeORM. Returns the Companies that still have some. */
  async verify(plan: CompanyFanoutPlan, candidatePath: string): Promise<Record<string, string[]>> {
    const scope = plan.scope;
    const byTag = migrationNamesByTag(candidatePath, scope);
    const stillPending: Record<string, string[]> = {};
    for (const c of plan.planned) {
      const again = await this.evaluate(c.companyId, candidatePath, scope, byTag);
      if (again.pending.length > 0) stillPending[c.companyName] = again.pending;
    }
    return stillPending;
  }
}

