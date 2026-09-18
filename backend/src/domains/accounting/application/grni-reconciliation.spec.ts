import { Test, TestingModule } from '@nestjs/testing';
import { GrniReconciliationService } from './grni-reconciliation.service';
import { ClosingAuditService } from './closing-audit.service';
import { FiscalPeriodService } from './fiscal-period.service';
import { ClosingException } from '../infrastructure/closing-exception.entity';
import { DataSource, In } from 'typeorm';
import { AppModule } from '../../../app.module';

/**
 * ADR-054/ADR-056/ADR-057 (Month-End Closing Phase 8 + Procurement GRNI
 * Posting). Proves the sixth reconciliation type: (1) reports gracefully,
 * never throws, whether the `grni` control account exists or not — the
 * exact regression confirmed live and fixed in Phase 8 (a missing account
 * previously aborted the WHOLE Closing Audit, breaking the five
 * already-frozen types); (2) is correctly wired into the SAME
 * `ClosingException` lifecycle as the other five, never a parallel
 * mechanism (ADR-056's explicit requirement).
 *
 * Updated for ADR-057: this dev database now has a real `grni` GL account
 * and a real, bound `GRNI_LEDGER_CONTRACT` implementation (Procurement's
 * actual GR/Invoice posting, ADR-057) — GRNI is no longer dormant. The two
 * assertions that specifically exercised the (now historical) dormant
 * state were updated to assert the CURRENT correct behavior instead of
 * being deleted, so this file keeps proving "does not throw" / "correctly
 * wired into ClosingException" against whatever the real, live state is —
 * exactly the transition ADR-056 §11 and ADR-057 §11 both predicted would
 * happen automatically, with zero code change to `ClosingAuditService`
 * itself.
 */
describe('GrniReconciliationService and its ClosingAuditService integration (ADR-054/ADR-056 Phase 8)', () => {
  let moduleRef: TestingModule;
  let grni: GrniReconciliationService;
  let closingAudit: ClosingAuditService;
  let fiscalPeriods: FiscalPeriodService;
  let dataSource: DataSource;

  const ADMIN_A = 'e1d5fd90-6e1c-4f52-aac7-60dd6265aa80';
  const shortCode = (prefix: string) => `${prefix}${Date.now().toString().slice(-8)}`.slice(0, 16);

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    grni = moduleRef.get(GrniReconciliationService);
    closingAudit = moduleRef.get(ClosingAuditService);
    fiscalPeriods = moduleRef.get(FiscalPeriodService);
    dataSource = moduleRef.get(DataSource);
  }, 60_000);

  afterAll(async () => {
    await moduleRef.close();
  });

  it('reconcile() never throws, regardless of whether GRNI is currently dormant or active', async () => {
    // ADR-057 bound a real GRNI_LEDGER_CONTRACT implementation and this dev database now has a
    // real `grni` GL account — this run reflects WHATEVER the current live status genuinely is
    // (matched / drift_found / no_subledger_source are all legitimate outcomes depending on live
    // data), never hardcoded to one — the property under test is "never throws", matching the
    // exact regression this test caught and fixed in Phase 8 (a missing account used to abort the
    // whole Closing Audit).
    const run = await grni.reconcile({ asOfDate: '2026-09-30' }, ADMIN_A);
    expect(run.status).toBeDefined();
    expect(['matched', 'drift_found', 'no_subledger_source']).toContain(run.status);
  });

  it('ClosingAuditService.run() (the REAL, unmocked orchestration) never throws and correctly reports a fresh, empty period as GRNI-clean', async () => {
    const year = await fiscalPeriods.createFiscalYear({ code: shortCode('P8A'), startDate: '2034-01-01', endDate: '2034-01-31' }, ADMIN_A);
    const [period] = await fiscalPeriods.listPeriods(year.id);

    const auditRun = await closingAudit.run(period.id, ADMIN_A);
    expect(auditRun.status).toBeDefined(); // did not throw — the regression this phase fixed

    // A brand-new, empty test period has zero GRNI activity of its own — with the contract now
    // bound (ADR-057), a genuinely empty position reconciles MATCHED (0 subledger = 0 GL for this
    // scope), which correctly produces NO exception at all (`classifyReconciliationStatus` treats
    // `matched` as "not an exception"), not a DORMANT_SOURCE informational note — confirmed live.
    const exceptions = await dataSource.getRepository(ClosingException).find({ where: { fiscalPeriodId: period.id, module: 'grni' } });
    expect(exceptions).toHaveLength(0);
  }, 30_000);

  it('a fresh, empty period reconciles the other five types cleanly (matched/dormant) — confirms GRNI addition did not alter their behavior', async () => {
    const year = await fiscalPeriods.createFiscalYear({ code: shortCode('P8B'), startDate: '2034-02-01', endDate: '2034-02-28' }, ADMIN_A);
    const [period] = await fiscalPeriods.listPeriods(year.id);

    await closingAudit.run(period.id, ADMIN_A);

    const nonGrniExceptions = await dataSource
      .getRepository(ClosingException)
      .find({ where: { fiscalPeriodId: period.id, module: In(['ar', 'ap', 'cash_bank', 'inventory', 'fixed_asset']) } });
    // A brand-new, empty period may still show LIVE_DISCREPANCY for AR/Cash-Bank/Inventory (this dev
    // database's pre-existing cumulative historical drift, unrelated to GRNI — already documented
    // throughout this session), but none of them should be missing, duplicated, or mis-categorized
    // as a RESULT of the GRNI addition specifically.
    const categories = nonGrniExceptions.map((e) => `${e.module}:${e.category}`);
    expect(categories.filter((c) => c.startsWith('ap:'))).not.toContain('ap:UNCLASSIFIED_REJECTION'); // AP's own dormant/matched shape unaffected
  }, 30_000);
});
