import { CompanyFanoutPlan, CompanyFanoutService, summarizePlan, summarizeResult } from './company-fanout.service';
import { runMigrationsForDatabase } from '../release-orchestration/company-migration-runner';

jest.mock('../release-orchestration/company-migration-runner', () => ({ runMigrationsForDatabase: jest.fn() }));

/**
 * The failure branches real Postgres cannot produce on demand: a migration failure that is NOT provably a no-op (so the Company must stay closed in MIGRATING),
 * an unexpected throw mid-sweep (the report of who was already migrated must survive), and the audit-safety of the summaries.
 */
describe('CompanyFanoutService — failure semantics (unit)', () => {
  const status: Record<string, string> = {};
  const updates: Array<[string, string]> = [];
  const auditRecords: Array<{ action: string; result: string; after: Record<string, unknown> }> = [];
  let service: CompanyFanoutService;
  let evaluateSpy: jest.SpyInstance;

  const planOf = (): CompanyFanoutPlan => ({
    mode: 'on',
    scope: ['core'],
    planned: ['a', 'b', 'c'].map((n) => ({ companyId: n, companyName: n.toUpperCase(), databaseName: `db_${n}`, tags: ['core'], pending: ['M1'] })),
    skipped: [],
    blockers: [],
  });

  beforeEach(() => {
    jest.clearAllMocks();
    updates.length = 0;
    auditRecords.length = 0;
    for (const k of ['a', 'b', 'c']) status[k] = 'READY';
    const companies = {
      findById: jest.fn(async (id: string) => ({ id, name: id.toUpperCase(), status: status[id] })),
      update: jest.fn(async (id: string, d: { status: string }) => {
        status[id] = d.status;
        updates.push([id, d.status]);
        return { id, status: d.status };
      }),
    };
    const registry = { getConnectionConfigForCompany: jest.fn(async () => ({ host: 'h', port: 1, username: 'u', password: 'SECRET-PW', database: 'd' })) };
    const audit = { record: jest.fn(async (r: { action: string; result: string; after: Record<string, unknown> }) => void auditRecords.push(r)) };
    service = new CompanyFanoutService({ releaseDeploy: {} } as never, registry as never, companies as never, {} as never, {} as never, audit as never);
    evaluateSpy = jest.spyOn(service as never, 'evaluate');
  });

  it('a failure whose database is NOT provably unchanged leaves the Company MIGRATING (closed), reports it, and stops the sweep', async () => {
    (runMigrationsForDatabase as jest.Mock).mockResolvedValue({ success: false, ranMigrationNames: [], error: 'connection lost mid-batch' });
    evaluateSpy.mockResolvedValue({ tags: ['core'], pending: [] }); // the pending set CHANGED (partially applied) -> not provably unchanged

    const result = await service.migrate(planOf(), '/cand', 'actor', 'rel-1');

    expect(result.ok).toBe(false);
    expect(result.outcomes.map((o) => o.status)).toEqual(['failed', 'not_attempted', 'not_attempted']);
    expect(result.outcomes[0].finalCompanyStatus).toBe('MIGRATING');
    expect(status.a).toBe('MIGRATING'); // NOT reopened
    expect(updates).toEqual([['a', 'MIGRATING']]); // and never moved back
    expect(status.b).toBe('READY');
    expect(runMigrationsForDatabase).toHaveBeenCalledTimes(1);
    const rec = auditRecords.find((r) => r.action === 'release.deploy.company_migration_failed')!;
    expect(rec.after.databaseProvablyUnchanged).toBe(false);
    expect(String(rec.after.note)).toContain('left MIGRATING on purpose');
  });

  it('if the state cannot even be re-read after a failure it is treated as NOT provably unchanged (fail closed)', async () => {
    (runMigrationsForDatabase as jest.Mock).mockResolvedValue({ success: false, ranMigrationNames: [], error: 'boom' });
    evaluateSpy.mockRejectedValue(new Error('cannot connect'));
    const result = await service.migrate(planOf(), '/cand', 'actor', 'rel-1');
    expect(result.outcomes[0].finalCompanyStatus).toBe('MIGRATING');
    expect(status.a).toBe('MIGRATING');
  });

  it('an unexpected throw in one Company becomes ITS failure: the sweep stops, the earlier Company stays reported as migrated, the later one is not attempted', async () => {
    (runMigrationsForDatabase as jest.Mock).mockResolvedValueOnce({ success: true, ranMigrationNames: ['M1'], error: null }).mockImplementationOnce(() => {
      throw new Error('driver exploded');
    });
    const result = await service.migrate(planOf(), '/cand', 'actor', 'rel-1');
    expect(result.outcomes.map((o) => o.status)).toEqual(['migrated', 'failed', 'not_attempted']);
    expect(result.outcomes[1].error).toContain('driver exploded');
    expect(result.ok).toBe(false);
    const failed = auditRecords.find((r) => r.action === 'release.deploy.company_migration_failed' && (r.after.companyId === 'b'))!;
    expect(failed).toBeDefined();
  });

  it('a Company that migrated but cannot return to READY is reported as a failure (left MIGRATING) — success is never claimed', async () => {
    (runMigrationsForDatabase as jest.Mock).mockResolvedValue({ success: true, ranMigrationNames: ['M1'], error: null });
    const companies = (service as unknown as { companies: { update: jest.Mock } }).companies;
    companies.update.mockImplementation(async (id: string, d: { status: string }) => {
      if (d.status === 'READY') throw new Error('db hiccup');
      status[id] = d.status;
      return { id, status: d.status };
    });
    const result = await service.migrate(planOf(), '/cand', 'actor', 'rel-1');
    expect(result.outcomes[0]).toMatchObject({ status: 'failed', finalCompanyStatus: 'MIGRATING', executed: ['M1'] });
    expect(result.ok).toBe(false);
  });

  it('summaries and audit payloads never carry credentials', async () => {
    (runMigrationsForDatabase as jest.Mock).mockResolvedValue({ success: true, ranMigrationNames: ['M1'], error: null });
    const plan = planOf();
    const result = await service.migrate(plan, '/cand', 'actor', 'rel-1');
    const blob = JSON.stringify([summarizePlan(plan), summarizeResult(result), auditRecords]);
    expect(blob).not.toContain('SECRET-PW');
    expect(blob).not.toMatch(/password/i);
  });
});
