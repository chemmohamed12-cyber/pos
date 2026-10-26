import { readFileSync } from 'fs';
import { join } from 'path';
import { handleCollectionRemitted } from './finance-handlers';
import { handlePayrollRunPosted } from './payroll-run-posted.handler';

/**
 * Org engine — REGRESSION GUARDS for decisions that keep today's behaviour (approved by the project owner, 2026-10-26):
 *   D-B  Collections: option D — collection / remittance postings stay at COMPANY level (no branch attribution in this release).
 *   D-D  Payroll runs: option B — payroll postings stay at COMPANY level (no branch attribution in this release).
 * These tests are not a rule of their own: they fail the day someone attributes these postings to a unit WITHOUT a new, signed decision, forcing the decision register
 * (ORG-STRUCTURE-ENGINE-ATTRIBUTION-DECISION-REGISTER) to be updated first. D-E (department-only scope: no resolver / visibility change) is guarded by the negative cases of
 * foundation/scope/org-context.real-pg.spec ("a department-only scope does not reach the branch").
 */
describe('org decisions D-B and D-D — company level is the documented behaviour', () => {
  const ctx = { findAccountByCode: async (c: string) => `acct-${c}`, resolveControlAccount: async (f: string) => `ctl-${f}` } as never;
  const base = { businessDate: '2026-01-01', transactionCurrencyCode: 'EGP', orgUnitId: null, sourceEntityId: 'src-1' };

  it('collection.remitted without an org unit posts at company level: entry unit null and no line carries a unit', async () => {
    const r = await handleCollectionRemitted({ ...base, payload: { amount: '100.00', glAccountCode: '1102', collectionId: 'c-1' } } as never, ctx);
    expect(r.kind).toBe('draft');
    if (r.kind === 'draft') {
      expect(r.draft.orgUnitId).toBeNull();
      expect(r.draft.lines.every((l) => l.orgUnitId === undefined || l.orgUnitId === null)).toBe(true);
    }
  });

  it('payroll.run.posted without an org unit posts at company level: entry unit null and no line carries a unit', async () => {
    const r = await handlePayrollRunPosted({ ...base, payload: { payrollRunId: 'run-1', totalGross: '1000.00' } } as never, ctx);
    expect(r.kind).toBe('draft');
    if (r.kind === 'draft') {
      expect(r.draft.orgUnitId).toBeNull();
      expect(r.draft.lines.every((l) => l.orgUnitId === undefined || l.orgUnitId === null)).toBe(true);
    }
  });

  const publishedBlock = (file: string, topic: string): string => {
    const src = readFileSync(join(__dirname, '..', '..', '..', file), 'utf8');
    const start = src.indexOf(`'${topic}'`);
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('});', start);
    return src.slice(start, end);
  };

  it('the PUBLISHERS of collection.remitted and payroll.run.posted do not attribute an org unit (a change here requires a signed decision first)', () => {
    expect(publishedBlock('delivery/application/delivery.service.ts', 'collection.remitted')).not.toMatch(/orgUnitId:\s*(?!null)/);
    expect(publishedBlock('payroll/application/payroll.service.ts', 'payroll.run.posted')).not.toMatch(/orgUnitId:\s*(?!null)/);
  });
});
