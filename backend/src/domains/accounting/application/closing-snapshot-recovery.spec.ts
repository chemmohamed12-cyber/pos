import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { AppModule } from '../../../app.module';
import { FiscalPeriodService } from './fiscal-period.service';
import { ClosingAuditService } from './closing-audit.service';
import { ClosingSnapshotService } from './closing-snapshot.service';
import { ClosingSnapshotRun } from '../infrastructure/closing-snapshot-run.entity';
import { ApprovalEngineService } from '../../../foundation/approval-engine/approval-engine.service';

/**
 * ADR-051 §12/§14 (Month-End Closing / Black Box, Phase 6). Reliability /
 * Outbox / Recovery. Same `ClosingAuditService` override rationale as the
 * Phase 3/5 test (this dev database's historical drift is deliberately
 * left unrepaired; these tests prove recovery mechanics, not reconciliation
 * arithmetic, which is separately proven).
 */
describe('ClosingSnapshotService reliability (ADR-051 Phase 6)', () => {
  let moduleRef: TestingModule;
  let fiscalPeriods: FiscalPeriodService;
  let closingSnapshots: ClosingSnapshotService;
  let approvals: ApprovalEngineService;
  let dataSource: DataSource;

  const ADMIN_A = 'e1d5fd90-6e1c-4f52-aac7-60dd6265aa80';
  const ADMIN_B = '04531f67-b087-4459-93de-55c61da9d66b';
  const shortCode = (prefix: string) => `${prefix}${Date.now().toString().slice(-8)}`.slice(0, 16);

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ClosingAuditService)
      .useValue({
        assertCleanForClose: jest.fn().mockResolvedValue({ id: '00000000-0000-0000-0000-00000000f00d', status: 'clean' }),
        run: jest.fn(),
        listRuns: jest.fn().mockResolvedValue([]),
      })
      .compile();
    await moduleRef.init();

    fiscalPeriods = moduleRef.get(FiscalPeriodService);
    closingSnapshots = moduleRef.get(ClosingSnapshotService);
    approvals = moduleRef.get(ApprovalEngineService);
    dataSource = moduleRef.get(DataSource);
  }, 60_000);

  afterAll(async () => {
    await moduleRef.close();
  });

  it('beginPending is idempotent under a duplicate delivery of the same approvalRequestId', async () => {
    const year = await fiscalPeriods.createFiscalYear({ code: shortCode('P6A'), startDate: '2032-01-01', endDate: '2032-01-31' }, ADMIN_A);
    const [period] = await fiscalPeriods.listPeriods(year.id);
    await fiscalPeriods.transitionPeriod(period.id, 'soft_close', ADMIN_A);
    const request = await fiscalPeriods.submitPeriodClose(period.id, ADMIN_A);
    await approvals.decide(request.id, ADMIN_B, 'approved', 'Phase 6 setup');

    await dataSource.transaction(async (manager) => {
      const first = await closingSnapshots.beginPending(manager, period.id, request.id, ADMIN_A);
      const second = await closingSnapshots.beginPending(manager, period.id, request.id, ADMIN_A);
      expect(second.id).toBe(first.id); // same row, not a duplicate
    });

    const runs = await closingSnapshots.listRuns(period.id);
    expect(runs).toHaveLength(1); // the real one created by the actual approval flow above, not a duplicate from this test's own calls
  }, 30_000);

  it('retryPending recovers a run left pending by a simulated crash (beginPending happened, assembleAndFinalize never ran)', async () => {
    const year = await fiscalPeriods.createFiscalYear({ code: shortCode('P6B'), startDate: '2032-02-01', endDate: '2032-02-28' }, ADMIN_A);
    const [period] = await fiscalPeriods.listPeriods(year.id);

    // Simulate the crash: a 'pending' row exists (as beginPending would leave one, mid-transaction-
    // commit) but assembleAndFinalize never ran — a fabricated approvalRequestId is fine here since
    // this test targets recovery mechanics, not the approval flow itself.
    const repo = dataSource.getRepository(ClosingSnapshotRun);
    const orphaned = await repo.save(
      repo.create({
        fiscalPeriodId: period.id,
        closeSequence: 1,
        supersedesSnapshotId: null,
        approvalRequestId: randomUUID(),
        status: 'pending',
        generatedByUserId: ADMIN_A,
      }),
    );

    await closingSnapshots.retryPending();

    const recovered = await closingSnapshots.getRun(orphaned.id);
    expect(recovered.status).toBe('complete');
    expect(recovered.manifestPath).toBeTruthy();
    const verifyResult = await closingSnapshots.verify(orphaned.id);
    expect(verifyResult.ok).toBe(true);
  }, 30_000);

  it('detectOverdue flags a stale pending/failed run past the grace period and records an audit entry, never silently', async () => {
    const year = await fiscalPeriods.createFiscalYear({ code: shortCode('P6C'), startDate: '2032-03-01', endDate: '2032-03-31' }, ADMIN_A);
    const [period] = await fiscalPeriods.listPeriods(year.id);

    const repo = dataSource.getRepository(ClosingSnapshotRun);
    const stale = await repo.save(
      repo.create({
        fiscalPeriodId: period.id,
        closeSequence: 1,
        supersedesSnapshotId: null,
        approvalRequestId: randomUUID(),
        status: 'failed',
        generatedByUserId: ADMIN_A,
      }),
    );
    // Backdate createdAt directly — this row must look old enough to be "overdue".
    await dataSource.query(`UPDATE accounting_closing_snapshot_runs SET "createdAt" = now() - interval '1 hour' WHERE id = $1`, [stale.id]);

    const overdue = await closingSnapshots.detectOverdue(10);
    expect(overdue.map((r) => r.id)).toContain(stale.id);

    const auditRows = await dataSource.query(
      `SELECT * FROM audit_records WHERE action = 'accounting.closing_snapshot.generation_overdue' AND "resourceId" = $1`,
      [stale.id],
    );
    expect(auditRows.length).toBeGreaterThan(0);
  }, 30_000);

  it('never overwrites an already-complete snapshot file (content-addressed, exclusive create)', async () => {
    const year = await fiscalPeriods.createFiscalYear({ code: shortCode('P6D'), startDate: '2032-04-01', endDate: '2032-04-30' }, ADMIN_A);
    const [period] = await fiscalPeriods.listPeriods(year.id);
    await fiscalPeriods.transitionPeriod(period.id, 'soft_close', ADMIN_A);
    const request = await fiscalPeriods.submitPeriodClose(period.id, ADMIN_A);
    await approvals.decide(request.id, ADMIN_B, 'approved', 'Phase 6 no-overwrite test');

    const [run] = await closingSnapshots.listRuns(period.id);
    expect(run.status).toBe('complete');

    // assembleAndFinalize on an already-complete run must be a safe no-op, never re-derive or
    // re-write the file (ADR-051 §13 — no application code path opens an existing snapshot file
    // for writing again).
    const before = { ...run };
    const result = await closingSnapshots.assembleAndFinalize(run.id);
    expect(result.manifestHash).toBe(before.manifestHash);
    expect(result.contentHash).toBe(before.contentHash);
  }, 30_000);
});
