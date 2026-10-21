import { buildCompanyMigrationReport, ReleaseAuditRow } from './company-migration-report';

const row = (seq: number, action: string, result: string, after: Record<string, unknown> | null = null): ReleaseAuditRow => ({ seq, action, result, after });

describe('buildCompanyMigrationReport', () => {
  it('no deploy attempt -> says so', () => {
    const r = buildCompanyMigrationReport([row(1, 'release.registered', 'success')]);
    expect(r.attempt.outcome).toBe('no_attempt');
    expect(r.headline).toContain('No deploy attempt');
  });

  it('a successful fan-out deploy: counts, per-Company rows with the restore point, gate decisions in order, headline', () => {
    const r = buildCompanyMigrationReport([
      row(10, 'release.deploy.started', 'success'),
      row(11, 'release.deploy.company_fanout_plan', 'success', { configuredMode: 'on', modeExplicit: false, counts: { companiesEvaluated: 3, companiesWithPendingMigrations: 3, companiesSkippedStale: 0, companiesOutOfScope: 1 } }),
      row(12, 'release.deploy.company_gate', 'success', { phase: 'pre-migration', decision: 'PASS', blockers: [], warnings: [] }),
      row(13, 'release.deploy.company_migration_started', 'success', { companyName: 'Alpha', backupRunId: 'bk-1' }),
      row(14, 'release.deploy.company_migration_succeeded', 'success', { companyName: 'Alpha', executed: ['M1', 'M2'] }),
      row(15, 'release.deploy.company_migration_started', 'success', { companyName: 'Beta', backupRunId: 'bk-2' }),
      row(16, 'release.deploy.company_migration_succeeded', 'success', { companyName: 'Beta', executed: ['M1'] }),
      row(17, 'release.deploy.company_migration_noop', 'success', { companyName: 'Gamma' }),
      row(18, 'release.deploy.company_gate', 'success', { phase: 'post-migration', blockers: [], warnings: [] }),
      row(19, 'release.deploy.succeeded', 'success', {}),
    ]);
    expect(r.attempt).toEqual({ outcome: 'succeeded', mode: 'on', modeExplicit: false });
    expect(r.counts).toMatchObject({ evaluated: 3, needingMigration: 3, migrated: 2, noop: 1, failed: 0, outOfScope: 1 });
    expect(r.companies.find((c) => c.company === 'Alpha')).toMatchObject({ status: 'succeeded', executed: ['M1', 'M2'], backupRunId: 'bk-1' });
    expect(r.gate.map((g) => g.phase)).toEqual(['pre-migration', 'post-migration']);
    expect(r.headline).toContain('Succeeded: 3 Company(ies) checked, 2 migrated, 0 failed');
  });

  it('a failed attempt where Platform migrations completed: databases AHEAD is stated, and only the LATEST attempt is reported', () => {
    const r = buildCompanyMigrationReport([
      row(1, 'release.deploy.started', 'success'),
      row(2, 'release.deploy.company_migration_failed', 'failure', { companyName: 'OldAttempt', error: 'old' }),
      row(3, 'release.deploy.failed', 'failure', { databasesAheadOfActiveApplication: false }),
      row(10, 'release.deploy.started', 'success'),
      row(11, 'release.deploy.company_fanout_plan', 'success', { configuredMode: 'on', counts: { companiesEvaluated: 2 } }),
      row(12, 'release.deploy.company_migration_succeeded', 'success', { companyName: 'Alpha', executed: ['M1'] }),
      row(13, 'release.deploy.company_migration_failed', 'failure', { companyName: 'Beta', error: 'relation "x" already exists' }),
      row(14, 'release.deploy.company_fanout', 'failure', { notAttempted: ['Gamma'] }),
      row(15, 'release.deploy.failed', 'failure', { databasesAheadOfActiveApplication: true }),
    ]);
    expect(r.attempt.outcome).toBe('failed');
    expect(r.companies.map((c) => c.company).sort()).toEqual(['Alpha', 'Beta']); // OldAttempt belongs to the previous attempt
    expect(r.counts).toMatchObject({ migrated: 1, failed: 1, notAttempted: 1 });
    expect(r.databasesAheadOfActiveApplication).toBe(true);
    expect(r.headline).toContain('AHEAD');
    expect(r.companies.find((c) => c.company === 'Beta')?.error).toContain('already exists');
  });

  it('a dry-run is reported as plan only with nothing changed', () => {
    const r = buildCompanyMigrationReport([
      row(1, 'release.deploy.started', 'success'),
      row(2, 'release.deploy.company_fanout_plan', 'success', { configuredMode: 'dry-run', counts: { companiesEvaluated: 4, companiesWithPendingMigrations: 4 } }),
      row(3, 'release.deploy.plan_only', 'success', { note: 'x' }),
    ]);
    expect(r.attempt.outcome).toBe('plan_only');
    expect(r.headline).toContain('Nothing was changed');
    expect(r.headline).toContain('4 Company(ies) checked');
  });

  it('stale Companies recorded by an `allow` policy deploy surface in the report and the headline', () => {
    const r = buildCompanyMigrationReport([
      row(1, 'release.deploy.started', 'success'),
      row(2, 'release.deploy.company_fanout_plan', 'success', { configuredMode: 'on', counts: { companiesEvaluated: 1, companiesSkippedStale: 1 } }),
      row(3, 'release.deploy.evidence', 'success', { layers: { companyMigrationGate: { staleCompanies: [{ name: 'Dormouse', status: 'SUSPENDED' }] } } }),
      row(4, 'release.deploy.succeeded', 'success', {}),
    ]);
    expect(r.staleCompanies).toEqual([{ name: 'Dormouse', status: 'SUSPENDED' }]);
    expect(r.headline).toContain('STALE');
  });

  it('malformed audit payloads never throw', () => {
    expect(() => buildCompanyMigrationReport([row(1, 'release.deploy.started', 'success', null), row(2, 'release.deploy.company_migration_started', 'success', null), row(3, 'release.deploy.company_gate', 'denied', null)])).not.toThrow();
  });
});
