import { evaluateCompanyGate, evaluatePostMigrationGate } from './company-migration-gate';
import { CompanyFanoutMode, CompanyFanoutPlan, PlannedCompany, SkippedCompany } from './company-fanout.service';
import { CompanySchemaCheckResult } from './company-schema-check';

/**
 * The Company migration gate rules (CTO 2026-10-21). Pure logic, exhaustively tabulated: the CTO's four situations (missing migration, schema drift,
 * incompatible/unevaluable, Company outside the plan) x the three modes. The engine integration (ordering, no swap) is pinned in release-execution-company-fanout.spec.ts.
 */
const clean: CompanySchemaCheckResult = { ran: true, checkedTables: 100, findings: { missingTables: [], missingColumns: {} } };
const drift: CompanySchemaCheckResult = { ran: true, checkedTables: 100, findings: { missingTables: ['cash_sessions'], missingColumns: { products: ['itemType'] } } };
const unrunnable: CompanySchemaCheckResult = { ran: false, checkedTables: 0, findings: { missingTables: [], missingColumns: {} }, error: 'connect ECONNREFUSED' };

const company = (name: string, pending: string[], schema: CompanySchemaCheckResult | null = clean): PlannedCompany => ({
  companyId: `id-${name}`,
  companyName: name,
  databaseName: `db_${name}`,
  tags: ['core'],
  pending,
  ...(schema ? { schema } : {}),
});
const skipped = (name: string, status: string): SkippedCompany => ({
  companyId: `id-${name}`,
  companyName: name,
  reason: `Company status is ${status}, not READY`,
  status,
  scope: status === 'DECOMMISSIONED' ? 'out_of_scope' : 'stale',
});
const plan = (planned: PlannedCompany[], over: Partial<CompanyFanoutPlan> = {}): CompanyFanoutPlan => ({ mode: 'on', scope: ['core'], planned, skipped: [], blockers: [], ...over });
const gate = (mode: CompanyFanoutMode, p: CompanyFanoutPlan, over: { skippedPolicy?: 'block' | 'allow'; schemaCheck?: 'enforce' | 'report' } = {}) =>
  evaluateCompanyGate({ mode, plan: p, skippedPolicy: over.skippedPolicy ?? 'block', schemaCheck: over.schemaCheck ?? 'enforce' });

describe('evaluateCompanyGate', () => {
  describe('1. missing migrations', () => {
    it('on: pending Companies are fine (they are migrated next) -> PASS', () => {
      const d = gate('on', plan([company('A', ['M1']), company('B', ['M1', 'M2'])].map((c) => ({ ...c, schema: drift }))));
      expect(d.decision).toBe('PASS');
      expect(d.counts).toMatchObject({ evaluated: 2, needingMigration: 2 });
    });
    it('off: a Company that still needs migrations => BLOCKED (COMPANY_MIGRATIONS_REQUIRED_BUT_DISABLED), naming each Company and its count', () => {
      const d = gate('off', plan([company('A', ['M1']), company('B', [])]));
      expect(d.decision).toBe('BLOCKED');
      expect(d.blockers.join(' ')).toContain('COMPANY_MIGRATIONS_REQUIRED_BUT_DISABLED');
      expect(d.blockers.join(' ')).toContain('A (1)');
      expect(d.blockers.join(' ')).not.toContain('B (');
    });
    it('off: every Company current and clean => PASS (a platform-only deploy is legitimate only when it provably leaves nobody behind)', () => {
      expect(gate('off', plan([company('A', []), company('B', [])])).decision).toBe('PASS');
    });
    it('a single Company one migration behind is enough to block in off mode (315 vs 320 is not a success)', () => {
      expect(gate('off', plan([company('A', []), company('B', ['OneMigration'])])).decision).toBe('BLOCKED');
    });
  });

  describe('2. schema drift', () => {
    it('nothing pending but the schema differs => BLOCKED in every non-plan mode (no migration will repair it)', () => {
      for (const mode of ['on', 'off'] as const) {
        const d = gate(mode, plan([company('A', [], drift)]));
        expect(d.decision).toBe('BLOCKED');
        expect(d.blockers.join(' ')).toContain('schema drift');
        expect(d.blockers.join(' ')).toContain('A:');
      }
    });
    it('pending AND different is expected before the migration step (re-checked after it) => not a drift block', () => {
      expect(gate('on', plan([company('A', ['M1'], drift)])).decision).toBe('PASS');
    });
    it('report mode records the drift as a warning and does not block', () => {
      const d = gate('on', plan([company('A', [], drift)]), { schemaCheck: 'report' });
      expect(d.decision).toBe('PASS');
      expect(d.warnings.join(' ')).toContain('schema drift');
    });
    it('a schema check that could not run is NEVER treated as clean: blocked (enforce) / warned (report); a missing result counts as not run', () => {
      expect(gate('on', plan([company('A', [], unrunnable)])).decision).toBe('BLOCKED');
      expect(gate('on', plan([company('A', [], null)])).decision).toBe('BLOCKED');
      const report = gate('on', plan([company('A', [], unrunnable)]), { schemaCheck: 'report' });
      expect(report.decision).toBe('PASS');
      expect(report.warnings.join(' ')).toContain('could not run');
    });
  });

  describe('3. a Company that cannot be evaluated / incompatible history', () => {
    it('plan blockers are carried through unchanged and block', () => {
      const d = gate('on', plan([company('A', [])], { blockers: ['Company "C" (id-C) could not be evaluated: connect ECONNREFUSED'] }));
      expect(d.decision).toBe('BLOCKED');
      expect(d.blockers).toContain('Company "C" (id-C) could not be evaluated: connect ECONNREFUSED');
    });
  });

  describe('4. Companies outside the plan', () => {
    it('SUSPENDED / DEGRADED / FAILED / MIGRATING / PROVISIONING are STALE and BLOCK by default', () => {
      for (const status of ['SUSPENDED', 'DEGRADED', 'FAILED', 'MIGRATING', 'PROVISIONING']) {
        const d = gate('on', plan([company('A', [])], { skipped: [skipped('S', status)] }));
        expect(d.decision).toBe('BLOCKED');
        expect(d.blockers.join(' ')).toContain(status);
        expect(d.staleCompanies).toHaveLength(1);
      }
    });
    it('a registry row without a Company counts as stale (it cannot be looked at)', () => {
      const d = gate('on', plan([company('A', [])], { skipped: [{ companyId: 'x', companyName: null, reason: 'registry row without a Company', status: null, scope: 'stale' }] }));
      expect(d.decision).toBe('BLOCKED');
    });
    it('DECOMMISSIONED is out of scope: counted, never blocks', () => {
      const d = gate('on', plan([company('A', [])], { skipped: [skipped('D', 'DECOMMISSIONED')] }));
      expect(d.decision).toBe('PASS');
      expect(d.counts.outOfScope).toBe(1);
      expect(d.staleCompanies).toHaveLength(0);
    });
    it('policy allow: proceeds with a warning and the stale Company listed', () => {
      const d = gate('on', plan([company('A', [])], { skipped: [skipped('S', 'SUSPENDED')] }), { skippedPolicy: 'allow' });
      expect(d.decision).toBe('PASS');
      expect(d.staleCompanies.map((c) => c.companyName)).toEqual(['S']);
      expect(d.warnings.join(' ')).toContain('STALE');
    });
  });

  describe('dry-run', () => {
    it('is always PLAN_ONLY, and still reports what would block a real deploy', () => {
      const d = gate('dry-run', plan([company('A', [], drift)], { skipped: [skipped('S', 'SUSPENDED')] }));
      expect(d.decision).toBe('PLAN_ONLY');
      expect(d.blockers.length).toBeGreaterThan(0);
    });
    it('PLAN_ONLY with nothing to report has no blockers', () => {
      const d = gate('dry-run', plan([company('A', [])]));
      expect(d.decision).toBe('PLAN_ONLY');
      expect(d.blockers).toEqual([]);
    });
  });

  it('counts are consistent', () => {
    const d = gate('on', plan([company('A', ['M']), company('B', [], drift), company('C', [])], { skipped: [skipped('S', 'SUSPENDED'), skipped('D', 'DECOMMISSIONED')] }), { skippedPolicy: 'allow', schemaCheck: 'report' });
    expect(d.counts).toEqual({ evaluated: 3, needingMigration: 1, withSchemaFindings: 1, staleSkipped: 1, outOfScope: 1 });
  });
});

describe('evaluatePostMigrationGate', () => {
  it('clean => no blockers', () => {
    expect(evaluatePostMigrationGate({}, { A: clean, B: clean }, 'enforce')).toEqual({ blockers: [], warnings: [] });
  });
  it('a Company still pending after the migration step blocks (independent of the migration step\'s own success report)', () => {
    const r = evaluatePostMigrationGate({ B: ['SalesNew2'] }, { A: clean, B: clean }, 'enforce');
    expect(r.blockers.join(' ')).toContain('SalesNew2');
  });
  it('a Company still not matching the new schema blocks (enforce) / warns (report)', () => {
    expect(evaluatePostMigrationGate({}, { A: drift }, 'enforce').blockers.join(' ')).toContain('still do not match');
    const report = evaluatePostMigrationGate({}, { A: drift }, 'report');
    expect(report.blockers).toEqual([]);
    expect(report.warnings.join(' ')).toContain('still do not match');
  });
  it('an unrunnable post-migration schema check is never clean', () => {
    expect(evaluatePostMigrationGate({}, { A: unrunnable }, 'enforce').blockers.join(' ')).toContain('could not run');
  });
});
