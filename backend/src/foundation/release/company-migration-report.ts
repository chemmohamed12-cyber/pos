/**
 * Company migration report for the Release Center (CTO 2026-10-21): "how many Companies were checked, how many were migrated, how many failed" - before AND after
 * activation - derived ONLY from the release's own audit trail (the platform audit chain), so it can never disagree with what the engine recorded. Pure function: the
 * controller reads the rows, this shapes them. Read-only; no credentials ever appear (the audit payloads it reads are already credential-free).
 */
export interface ReleaseAuditRow {
  seq: number | string;
  action: string;
  result: string;
  after: Record<string, unknown> | null;
}

export interface CompanyMigrationReport {
  /** The latest deploy attempt of this release (everything after its last `release.deploy.started`). */
  attempt: { outcome: 'succeeded' | 'failed' | 'plan_only' | 'in_progress' | 'no_attempt'; mode: string | null; modeExplicit: boolean | null };
  counts: { evaluated: number; needingMigration: number; migrated: number; noop: number; failed: number; notAttempted: number; staleSkipped: number; outOfScope: number };
  gate: Array<{ phase: string; decision: string | null; blockers: string[]; warnings: string[] }>;
  companies: Array<{ company: string; status: string; executed: string[]; error: string | null; backupRunId: string | null }>;
  staleCompanies: Array<{ name: string | null; status: string | null }>;
  databasesAheadOfActiveApplication: boolean;
  /** Plain-language one-liner for the operator. */
  headline: string;
}

const asArray = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);
const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export function buildCompanyMigrationReport(rowsInput: ReleaseAuditRow[]): CompanyMigrationReport {
  const rows = [...rowsInput].sort((a, b) => Number(a.seq) - Number(b.seq));
  let start = -1;
  rows.forEach((r, i) => {
    if (r.action === 'release.deploy.started') start = i;
  });
  const attemptRows = start >= 0 ? rows.slice(start) : [];
  const has = (a: string) => attemptRows.some((r) => r.action === a);
  const last = (a: string) => [...attemptRows].reverse().find((r) => r.action === a);

  let outcome: CompanyMigrationReport['attempt']['outcome'] = 'no_attempt';
  if (start >= 0) outcome = has('release.deploy.succeeded') ? 'succeeded' : has('release.deploy.plan_only') ? 'plan_only' : has('release.deploy.failed') ? 'failed' : 'in_progress';

  const planAfter = asObj(last('release.deploy.company_fanout_plan')?.after);
  const planCounts = asObj(planAfter.counts);
  const gate = attemptRows
    .filter((r) => r.action === 'release.deploy.company_gate')
    .map((r) => {
      const a = asObj(r.after);
      return { phase: String(a.phase ?? ''), decision: a.decision !== undefined ? String(a.decision) : r.result === 'denied' ? 'BLOCKED' : 'PASS', blockers: asArray(a.blockers), warnings: asArray(a.warnings) };
    });

  const companies = new Map<string, { company: string; status: string; executed: string[]; error: string | null; backupRunId: string | null }>();
  for (const r of attemptRows) {
    const m = /^release\.deploy\.company_migration_(started|succeeded|failed|noop)$/.exec(r.action);
    if (!m) continue;
    const a = asObj(r.after);
    const name = String(a.companyName ?? a.companyId ?? '?');
    const prev = companies.get(name);
    companies.set(name, {
      company: name,
      status: m[1],
      executed: asArray(a.executed).length ? asArray(a.executed) : prev?.executed ?? [],
      error: a.error ? String(a.error).slice(0, 300) : prev?.error ?? null,
      backupRunId: a.backupRunId ? String(a.backupRunId) : prev?.backupRunId ?? null,
    });
  }
  const list = [...companies.values()];
  const fanAfter = asObj(last('release.deploy.company_fanout')?.after);
  const notAttempted = asArray(fanAfter.notAttempted).length;

  const succeeded = asObj(last('release.deploy.succeeded')?.after);
  const evidence = asObj(asObj(asObj(last('release.deploy.evidence')?.after).layers).companyMigrationGate);
  const staleRaw = (Array.isArray(evidence.staleCompanies) ? evidence.staleCompanies : Array.isArray(succeeded.staleCompanies) ? succeeded.staleCompanies : []) as Array<Record<string, unknown>>;
  const stale = staleRaw.map((s) => ({ name: s.name !== undefined ? String(s.name) : null, status: s.status !== undefined ? String(s.status) : null }));

  const failedAfter = asObj(last('release.deploy.failed')?.after);
  const counts = {
    evaluated: Number(planCounts.companiesEvaluated ?? 0),
    needingMigration: Number(planCounts.companiesWithPendingMigrations ?? 0),
    migrated: list.filter((c) => c.status === 'succeeded').length,
    noop: list.filter((c) => c.status === 'noop').length,
    failed: list.filter((c) => c.status === 'failed').length,
    notAttempted,
    staleSkipped: Number(planCounts.companiesSkippedStale ?? stale.length),
    outOfScope: Number(planCounts.companiesOutOfScope ?? 0),
  };
  const ahead = failedAfter.databasesAheadOfActiveApplication === true;

  let headline: string;
  if (outcome === 'no_attempt') headline = 'No deploy attempt has been recorded for this release.';
  else if (outcome === 'plan_only') headline = `Plan only (dry-run): ${counts.evaluated} Company(ies) checked, ${counts.needingMigration} need migrations. Nothing was changed.`;
  else if (outcome === 'succeeded') headline = `Succeeded: ${counts.evaluated} Company(ies) checked, ${counts.migrated} migrated, ${counts.failed} failed${stale.length ? `, ${stale.length} STALE (not READY - catch up before reactivation)` : ''}.`;
  else if (outcome === 'failed') headline = `Failed: ${counts.evaluated} Company(ies) checked, ${counts.migrated} migrated, ${counts.failed} failed${ahead ? '. The databases are AHEAD of the active application, which keeps running; fix the cause and re-run this release' : '. Nothing was activated'}.`;
  else headline = 'In progress.';

  return {
    attempt: { outcome, mode: planAfter.configuredMode !== undefined ? String(planAfter.configuredMode) : planAfter.mode !== undefined ? String(planAfter.mode) : null, modeExplicit: typeof planAfter.modeExplicit === 'boolean' ? planAfter.modeExplicit : null },
    counts,
    gate,
    companies: list,
    staleCompanies: stale,
    databasesAheadOfActiveApplication: ahead,
    headline,
  };
}
