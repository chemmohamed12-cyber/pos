import { CompanyCatchUpService, CatchUpRefusedError } from './company-catch-up.service';
import { CompanyFanoutBlockedError, CompanyFanoutPlan, CompanyFanoutResult, PlannedCompany } from './company-fanout.service';
import { CompanySchemaCheckResult } from './company-schema-check';
import { Release } from './release.entity';

/**
 * Company catch-up (1.1.12): the explicit, confirmed, audited remediation for a LIVE release whose Companies are behind. Pinned here: every refusal happens BEFORE any
 * restore point or migration, the confirmation must name exactly the databases that will be touched, and success is only reported after the independent re-check.
 */
const clean: CompanySchemaCheckResult = { ran: true, checkedTables: 100, findings: { missingTables: [], missingColumns: {} } };
const drift: CompanySchemaCheckResult = { ran: true, checkedTables: 100, findings: { missingTables: ['cash_sessions'], missingColumns: {} } };
const co = (name: string, pending: string[], over: Partial<PlannedCompany> = {}): PlannedCompany => ({ companyId: `id-${name}`, companyName: name, databaseName: `db_${name}`, tags: ['core'], pending, unknownMigrations: [], schema: clean, ...over });
const planOf = (planned: PlannedCompany[], over: Partial<CompanyFanoutPlan> = {}): CompanyFanoutPlan => ({ mode: 'on', scope: ['core'], planned, skipped: [], blockers: [], ...over });
const okResult = (names: string[]): CompanyFanoutResult => ({ ok: true, outcomes: names.map((n) => ({ companyId: `id-${n}`, companyName: n, status: 'migrated' as const, executed: ['M1'], error: null, finalCompanyStatus: 'READY', durationMs: 1 })) });

function build(opts: { release?: boolean; inFlight?: number; plan?: CompanyFanoutPlan } = {}) {
  const calls: string[] = [];
  const fanout = {
    plan: jest.fn(async () => (calls.push('plan'), opts.plan ?? planOf([co('A', ['M1']), co('B', ['M1'])]))),
    ensureBackups: jest.fn(async () => (calls.push('backups'), [{ companyId: 'id-A', backupRunId: 'bk-a', basis: 'created' }])),
    migrate: jest.fn(async () => (calls.push('migrate'), okResult(['A', 'B']))),
    verify: jest.fn(async () => (calls.push('verify'), {} as Record<string, string[]>)),
    verifySchema: jest.fn(async () => (calls.push('verifySchema'), { A: clean, B: clean })),
  };
  const releaseRepo = {
    findOne: jest.fn(async () => (opts.release === false ? null : ({ id: 'rel-1', version: '1.1.11', status: 'succeeded' } as unknown as Release))),
    count: jest.fn(async () => opts.inFlight ?? 0),
  };
  const dataSource = { getRepository: jest.fn(() => releaseRepo) };
  const auditCalls: Array<{ action: string; result: string }> = [];
  const audit = { record: jest.fn(async (r: { action: string; result: string }) => void auditCalls.push({ action: r.action, result: r.result })) };
  const config = { releaseExecution: { appRoot: 'C:/app' } };
  const svc = new CompanyCatchUpService(fanout as never, config as never, dataSource as never, audit as never);
  return { svc, fanout, calls, auditCalls, releaseRepo };
}
const nothingChanged = (f: ReturnType<typeof build>) => {
  expect(f.fanout.ensureBackups).not.toHaveBeenCalled();
  expect(f.fanout.migrate).not.toHaveBeenCalled();
};

describe('CompanyCatchUpService', () => {
  it('happy path: plan -> restore points -> migrate -> re-check pending -> re-check schema, then SUCCESS with an audit trail', async () => {
    const f = build();
    const r = await f.svc.run('admin-1', ['db_A', 'db_B']);
    expect(r.status).toBe('SUCCESS');
    expect(r.migrated).toEqual(['A', 'B']);
    expect(f.calls).toEqual(['plan', 'backups', 'migrate', 'verify', 'verifySchema']);
    expect(f.fanout.plan).toHaveBeenCalledWith('C:/app'); // the INSTALLED root
    expect(f.auditCalls.map((a) => a.action)).toEqual(['release.company_catchup.planned', 'release.company_catchup.restore_points', 'release.company_catchup.completed']);
  });

  it('refuses when the installed version has no succeeded release row (it only repairs a LIVE release) - nothing planned, nothing changed', async () => {
    const f = build({ release: false });
    await expect(f.svc.run('a', [])).rejects.toBeInstanceOf(CatchUpRefusedError);
    expect(f.fanout.plan).not.toHaveBeenCalled();
    nothingChanged(f);
  });

  it('refuses next to a deploy in flight', async () => {
    const f = build({ inFlight: 1 });
    await expect(f.svc.run('a', ['db_A', 'db_B'])).rejects.toThrow(/deploy is in progress/);
    nothingChanged(f);
  });

  it('refuses when a READY Company cannot be evaluated (plan blocker)', async () => {
    const f = build({ plan: planOf([co('A', ['M1'])], { blockers: ['Company "C" could not be evaluated: ECONNREFUSED'] }) });
    await expect(f.svc.run('a', ['db_A'])).rejects.toThrow(/could not be evaluated/);
    nothingChanged(f);
    expect(f.auditCalls.map((a) => a.action)).toContain('release.company_catchup.refused');
  });

  it('refuses when a Company holds migrations this build does not ship (COMPANY_HISTORY_UNKNOWN)', async () => {
    const f = build({ plan: planOf([co('A', ['M1'], { unknownMigrations: ['Alien1'] })]) });
    await expect(f.svc.run('a', ['db_A'])).rejects.toThrow(/COMPANY_HISTORY_UNKNOWN/);
    nothingChanged(f);
  });

  it('every Company current => NOTHING_TO_DO (no restore point, no migration)', async () => {
    const f = build({ plan: planOf([co('A', []), co('B', [])]) });
    const r = await f.svc.run('a', []);
    expect(r.status).toBe('NOTHING_TO_DO');
    nothingChanged(f);
  });

  it('nothing pending but the schema differs => SCHEMA_DRIFT (no migration can repair it; nothing changed)', async () => {
    const f = build({ plan: planOf([co('A', [], { schema: drift })]) });
    const r = await f.svc.run('a', []);
    expect(r.status).toBe('SCHEMA_DRIFT');
    nothingChanged(f);
  });

  it('the confirmation must name EXACTLY the databases to be migrated: too few, too many, or none are refused before any restore point', async () => {
    for (const given of [['db_A'], ['db_A', 'db_B', 'db_X'], [] as string[]]) {
      const f = build();
      await expect(f.svc.run('a', given)).rejects.toThrow(/must list exactly/);
      nothingChanged(f);
    }
  });

  it('a Company without a verified restore point => refused, NOTHING migrated', async () => {
    const f = build();
    f.fanout.ensureBackups.mockRejectedValue(new CompanyFanoutBlockedError(['the pre-update backup of Company "B" did not verify']));
    await expect(f.svc.run('a', ['db_A', 'db_B'])).rejects.toThrow(/No verified restore point/);
    expect(f.fanout.migrate).not.toHaveBeenCalled();
  });

  it('a Company fails => FAILED naming who failed and who was not attempted; success is never reported', async () => {
    const f = build();
    f.fanout.migrate.mockResolvedValue({
      ok: false,
      outcomes: [
        { companyId: 'id-A', companyName: 'A', status: 'migrated', executed: ['M1'], error: null, finalCompanyStatus: 'READY', durationMs: 1 },
        { companyId: 'id-B', companyName: 'B', status: 'failed', executed: [], error: 'relation "x" already exists', finalCompanyStatus: 'READY', durationMs: 1 },
      ],
    } as CompanyFanoutResult);
    const r = await f.svc.run('a', ['db_A', 'db_B']);
    expect(r.status).toBe('FAILED');
    expect(r.migrated).toEqual(['A']);
    expect(r.failed).toEqual([{ company: 'B', error: 'relation "x" already exists' }]);
    expect(f.auditCalls[f.auditCalls.length - 1]).toEqual({ action: 'release.company_catchup.completed', result: 'failure' });
  });

  it('migrations reported as done but the independent re-check still finds pending migrations or schema problems => FAILED, never SUCCESS', async () => {
    const a = build();
    a.fanout.verify.mockResolvedValue({ B: ['M1'] });
    expect((await a.svc.run('a', ['db_A', 'db_B'])).status).toBe('FAILED');
    const b = build();
    b.fanout.verifySchema.mockResolvedValue({ A: clean, B: drift });
    const r = await b.svc.run('a', ['db_A', 'db_B']);
    expect(r.status).toBe('FAILED');
    expect(Object.keys(r.schemaProblems)).toEqual(['B']);
  });

  it('a non-READY (stale) Company is reported and not touched: PARTIAL', async () => {
    const f = build({ plan: planOf([co('A', ['M1'])], { skipped: [{ companyId: 's', companyName: 'Sus', reason: 'SUSPENDED', status: 'SUSPENDED', scope: 'stale' }] }) });
    f.fanout.migrate.mockResolvedValue(okResult(['A']));
    f.fanout.verifySchema.mockResolvedValue({ A: clean } as never);
    const r = await f.svc.run('a', ['db_A']);
    expect(r.status).toBe('PARTIAL');
    expect(r.skippedNotReady).toEqual([{ company: 'Sus', status: 'SUSPENDED' }]);
  });

  it('only one catch-up at a time', async () => {
    const f = build();
    let release: () => void = () => undefined;
    f.fanout.migrate.mockImplementation(() => new Promise((res) => (release = () => res(okResult(['A', 'B'])))));
    const first = f.svc.run('a', ['db_A', 'db_B']);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await expect(f.svc.run('a', ['db_A', 'db_B'])).rejects.toThrow(/already running/);
    release();
    await first;
  });

  it('preview lists exactly the databases a catch-up would touch (read-only: no restore point, no migration)', async () => {
    const f = build();
    expect(await f.svc.preview()).toEqual({ databasesNeedingCatchUp: ['db_A', 'db_B'], refusal: null });
    nothingChanged(f);
    const g = build({ release: false });
    expect((await g.svc.preview()).refusal).toContain('No succeeded release row');
  });
});
