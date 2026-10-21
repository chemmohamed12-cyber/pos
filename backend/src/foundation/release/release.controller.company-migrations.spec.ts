import { ServiceUnavailableException } from '@nestjs/common';
import { ReleaseController } from './release.controller';
import { CompanyFanoutPlan } from './company-fanout.service';

/**
 * The two read-only Company migration endpoints of the Release Center (CTO 2026-10-21): the LIVE status against the installed build, and the recorded report of a
 * release's latest deploy attempt. The rules behind them are pinned in company-migration-gate.spec.ts / company-migration-report.spec.ts; this pins the wiring and
 * the wording an operator reads.
 */
const clean = { ran: true, checkedTables: 100, findings: { missingTables: [], missingColumns: {} } };
const drift = { ran: true, checkedTables: 100, findings: { missingTables: ['cash_sessions', 'bank_statements'], missingColumns: { products: ['itemType'] } } };
const planOf = (over: Partial<CompanyFanoutPlan>): CompanyFanoutPlan => ({ mode: 'on', scope: ['core'], planned: [], skipped: [], blockers: [], ...over });

function controller(opts: { plan?: CompanyFanoutPlan; wire?: boolean; rows?: unknown[] } = {}) {
  const fanout = { plan: jest.fn(async () => opts.plan ?? planOf({})) };
  const dataSource = { query: jest.fn(async () => opts.rows ?? []) };
  const config = {
    releaseExecution: { appRoot: 'C:/app' },
    releaseDeploy: { companyMigrations: 'on', companyMigrationsExplicit: false, companySkippedPolicy: 'block', companySchemaCheck: 'enforce' },
  };
  const c = new ReleaseController({} as never, {} as never, {} as never, {} as never, {} as never, {} as never, config as never, dataSource as never, opts.wire === false ? undefined : (fanout as never));
  return { c, fanout, dataSource };
}

describe('GET release/company-migrations (live, read-only)', () => {
  it('every Company current => CURRENT / allCurrent, plans against the installed application root', async () => {
    const { c, fanout } = controller({
      plan: planOf({ planned: [{ companyId: 'a', companyName: 'Alpha', databaseName: 'db_a', tags: ['core'], pending: [], schema: clean }] }),
    });
    const r = await c.getLiveCompanyMigrationStatus();
    expect(fanout.plan).toHaveBeenCalledWith('C:/app');
    expect(r).toMatchObject({ allCurrent: true, decision: 'CURRENT', blockers: [], configuredMode: 'on', modeExplicit: false });
    expect(r.counts.evaluated).toBe(1);
  });

  it('a Company behind is described in the operator\'s terms (pending + missing tables/columns), NOT with the "RELEASE_COMPANY_MIGRATIONS=off" message', async () => {
    const { c } = controller({
      plan: planOf({
        planned: [
          { companyId: 'a', companyName: 'Alpha', databaseName: 'db_a', tags: ['core'], pending: ['M1', 'M2'], schema: drift },
          { companyId: 'b', companyName: 'Beta', databaseName: 'db_b', tags: ['core'], pending: [], schema: clean },
        ],
      }),
    });
    const r = await c.getLiveCompanyMigrationStatus();
    expect(r.allCurrent).toBe(false);
    expect(r.decision).toBe('BEHIND');
    expect(r.blockers).toEqual(['Alpha: 2 pending migration(s), 2 missing table(s), 1 table(s) with missing columns']);
    expect(r.counts.needingMigration).toBe(1);
    expect(r.blockers.join(' ')).not.toContain('RELEASE_COMPANY_MIGRATIONS');
  });

  it('a stale (not READY) Company and an unverifiable schema also prevent "every Company is current"', async () => {
    const { c } = controller({
      plan: planOf({
        planned: [{ companyId: 'a', companyName: 'Alpha', databaseName: 'db_a', tags: ['core'], pending: [], schema: { ran: false, checkedTables: 0, findings: { missingTables: [], missingColumns: {} }, error: 'x' } }],
        skipped: [{ companyId: 's', companyName: 'Sus', reason: 'SUSPENDED', status: 'SUSPENDED', scope: 'stale' }],
      }),
    });
    const r = await c.getLiveCompanyMigrationStatus();
    expect(r.allCurrent).toBe(false);
    expect(r.blockers.join(' ')).toContain('Sus');
    expect(r.blockers.join(' ')).toContain('could not run');
    expect(r.staleCompanies).toHaveLength(1);
  });

  it('the service not wired => 503, never an empty "all current"', async () => {
    const { c } = controller({ wire: false });
    await expect(c.getLiveCompanyMigrationStatus()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe('GET release/releases/:id/company-migration-report', () => {
  it('reads only this release\'s deploy audit rows (parameterised) and returns the built report', async () => {
    const { c, dataSource } = controller({
      rows: [
        { seq: 1, action: 'release.deploy.started', result: 'success', after: null },
        { seq: 2, action: 'release.deploy.plan_only', result: 'success', after: { note: 'x' } },
      ],
    });
    const r = await c.getCompanyMigrationReport('rel-1');
    const [sql, params] = (dataSource.query as jest.Mock).mock.calls[0];
    expect(sql).toContain('FROM audit_records');
    expect(sql).toContain(`action LIKE 'release.deploy.%'`);
    expect(sql).not.toContain('rel-1'); // never concatenated
    expect(params).toEqual(['rel-1']);
    expect(r.attempt.outcome).toBe('plan_only');
  });
});
