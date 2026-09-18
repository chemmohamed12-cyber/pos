import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { readFile, writeFile } from 'fs/promises';
import { AppModule } from '../../../app.module';
import { FiscalPeriodService } from './fiscal-period.service';
import { ClosingAuditService } from './closing-audit.service';
import { ClosingSnapshotService } from './closing-snapshot.service';
import { ApprovalEngineService } from '../../../foundation/approval-engine/approval-engine.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { FISCAL_PERIOD_ENTITY_TYPE, FISCAL_PERIOD_PROCESS } from '../domain/process-definitions';
import { FISCAL_CLOSING_REQUEST_TYPES } from '../domain/fiscal-closing';

/**
 * ADR-051 §1/§3 (Month-End Closing / Black Box, Phase 3). Proves the
 * UNIFIED close/reclose orchestration end to end against the real dev
 * database's real Process Engine / Approval Engine / audit trail — the one
 * collaborator overridden is `ClosingAuditService`, so this test exercises
 * REAL orchestration logic, not fabricated data. This override is the
 * standard, narrow-scope technique for isolating orchestration from a
 * collaborator whose own correctness is separately, already proven (ADR-050
 * + this session's own live E2E verification of the classification engine)
 * — it is not a substitute for, or a weakening of, that proof.
 *
 * Why this override is necessary rather than a nicety: every one of the
 * five reconciliation services compares CURRENT cumulative subledger state
 * against a GL balance as-of a date. This dev database carries months of
 * accumulated historical drift (already root-caused and explicitly left
 * unfixed per CTO instruction — "do not clean historical test data merely
 * to make Closing Audit = PASS"). No fiscal period, past or newly created,
 * can therefore reconcile clean today without repairing that historical
 * drift, which is separately-scoped, out-of-bounds work. This test proves
 * the orchestration's "allows closing once conditions are met" behavior
 * (ADR-051 §1) the same way any orchestration layer is correctly tested:
 * with its collaborator held constant.
 */
describe('FiscalPeriodService unified closing workflow (ADR-051 Phase 3)', () => {
  let moduleRef: TestingModule;
  let fiscalPeriods: FiscalPeriodService;
  let approvals: ApprovalEngineService;
  let processEngine: ProcessEngineService;
  let closingSnapshots: ClosingSnapshotService;
  let dataSource: DataSource;

  const ADMIN_A = 'e1d5fd90-6e1c-4f52-aac7-60dd6265aa80'; // admin@daii.example
  const ADMIN_B = '04531f67-b087-4459-93de-55c61da9d66b'; // wh-admin@daii.example — different user, segregation of duties

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ClosingAuditService)
      .useValue({
        assertCleanForClose: jest.fn().mockResolvedValue({ id: '00000000-0000-0000-0000-00000000f00d', status: 'clean' }),
        run: jest.fn(),
        listRuns: jest.fn().mockResolvedValue([]),
      })
      .compile();

    await moduleRef.init(); // runs onModuleInit — registers the reclose request type + matrix rule (ADR-051 §1.3)

    fiscalPeriods = moduleRef.get(FiscalPeriodService);
    approvals = moduleRef.get(ApprovalEngineService);
    processEngine = moduleRef.get(ProcessEngineService);
    closingSnapshots = moduleRef.get(ClosingSnapshotService);
    dataSource = moduleRef.get(DataSource);
  }, 60_000);

  afterAll(async () => {
    await moduleRef.close();
  });

  const shortCode = (prefix: string) => `${prefix}${Date.now().toString().slice(-8)}`.slice(0, 16);

  it('registers the periodReclose request type on module init', async () => {
    const row = await dataSource.query(`SELECT "requestTypeCode" FROM approval_request_types WHERE "requestTypeCode" = $1`, [
      FISCAL_CLOSING_REQUEST_TYPES.periodReclose,
    ]);
    expect(row).toHaveLength(1);
  });

  it('closes a fresh period from soft_close through the unified submitPeriodClose, reaching period_locked', async () => {
    const year = await fiscalPeriods.createFiscalYear(
      { code: shortCode('P3A'), startDate: '2031-01-01', endDate: '2031-01-31' },
      ADMIN_A,
    );
    const [period] = await fiscalPeriods.listPeriods(year.id);
    await fiscalPeriods.transitionPeriod(period.id, 'soft_close', ADMIN_A);

    const request = await fiscalPeriods.submitPeriodClose(period.id, ADMIN_A);
    expect(request.requestTypeCode).toBe(FISCAL_CLOSING_REQUEST_TYPES.periodClose);
    expect(request.requestedAction).toBe('close');

    await approvals.decide(request.id, ADMIN_B, 'approved', 'Phase 3 E2E — first close');

    const status = await processEngine.getState(FISCAL_PERIOD_PROCESS, FISCAL_PERIOD_ENTITY_TYPE, period.id);
    expect(status).toBe('closed');

    const workflowRuns = await fiscalPeriods.listClosingWorkflowRuns(period.id);
    expect(workflowRuns).toHaveLength(1);
    expect(workflowRuns[0].entryState).toBe('soft_close');
    expect(workflowRuns[0].status).toBe('period_locked');
    expect(workflowRuns[0].approvalRequestId).toBe(request.id);

    // ADR-051 §5/§12 — the Black Box: a 'pending' row was written in the SAME transaction as the
    // lock, then assembled/hashed/signed/stored immediately after — proven 'complete' here, not
    // merely "no error was thrown".
    const snapshots = await closingSnapshots.listRuns(period.id);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].status).toBe('complete');
    expect(snapshots[0].closeSequence).toBe(1);
    expect(snapshots[0].supersedesSnapshotId).toBeNull();
    expect(snapshots[0].contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(snapshots[0].manifestHash).toMatch(/^[0-9a-f]{64}$/);

    const verifyResult = await closingSnapshots.verify(snapshots[0].id);
    expect(verifyResult).toEqual({ ok: true, contentHashMatches: true, signatureValid: true, chainValid: null });
  }, 30_000);

  it('recloses the same period after a reopen, via the SAME submitPeriodClose entry point, using the reclose request type and close_after_reopen action', async () => {
    const year = await fiscalPeriods.createFiscalYear(
      { code: shortCode('P3B'), startDate: '2031-02-01', endDate: '2031-02-28' },
      ADMIN_A,
    );
    const [period] = await fiscalPeriods.listPeriods(year.id);
    await fiscalPeriods.transitionPeriod(period.id, 'soft_close', ADMIN_A);
    const closeRequest = await fiscalPeriods.submitPeriodClose(period.id, ADMIN_A);
    await approvals.decide(closeRequest.id, ADMIN_B, 'approved', 'setup');
    expect(await processEngine.getState(FISCAL_PERIOD_PROCESS, FISCAL_PERIOD_ENTITY_TYPE, period.id)).toBe('closed');

    // The gap ADR-051 §1.2 closes: close_after_reopen is no longer reachable through the routine,
    // ungated transitionPeriod endpoint — proven directly, not just by omission.
    const reopenRequest = await fiscalPeriods.submitPeriodReopen(period.id, ADMIN_A);
    await approvals.decide(reopenRequest.id, ADMIN_B, 'approved', 'reopen for adjustment');
    expect(await processEngine.getState(FISCAL_PERIOD_PROCESS, FISCAL_PERIOD_ENTITY_TYPE, period.id)).toBe('reopened');

    await expect(fiscalPeriods.transitionPeriod(period.id, 'close_after_reopen', ADMIN_A)).rejects.toThrow(
      /must go through the FA-01 approval flow/,
    );

    const recloseRequest = await fiscalPeriods.submitPeriodClose(period.id, ADMIN_A);
    expect(recloseRequest.requestTypeCode).toBe(FISCAL_CLOSING_REQUEST_TYPES.periodReclose);
    expect(recloseRequest.requestedAction).toBe('close_after_reopen');

    await approvals.decide(recloseRequest.id, ADMIN_B, 'approved', 'Phase 3 E2E — reclose');

    const finalStatus = await processEngine.getState(FISCAL_PERIOD_PROCESS, FISCAL_PERIOD_ENTITY_TYPE, period.id);
    expect(finalStatus).toBe('closed');

    const workflowRuns = await fiscalPeriods.listClosingWorkflowRuns(period.id);
    expect(workflowRuns).toHaveLength(2); // the first close + the reclose, both tracked
    const reclose = workflowRuns.find((r) => r.approvalRequestId === recloseRequest.id)!;
    expect(reclose.entryState).toBe('reopened');
    expect(reclose.status).toBe('period_locked');

    // ADR-051 §4/§11 — Black Box chaining: two snapshots for the same period, the second
    // (`closeSequence: 2`) linked to the first via supersedesSnapshotId/previousManifestHash. The
    // FIRST snapshot's file and hash are untouched — the review's explicit requirement.
    const snapshots = await closingSnapshots.listRuns(period.id);
    expect(snapshots).toHaveLength(2);
    const [firstSnapshot, secondSnapshot] = snapshots;
    expect(firstSnapshot.closeSequence).toBe(1);
    expect(secondSnapshot.closeSequence).toBe(2);
    expect(secondSnapshot.supersedesSnapshotId).toBe(firstSnapshot.id);

    const firstVerify = await closingSnapshots.verify(firstSnapshot.id);
    expect(firstVerify).toEqual({ ok: true, contentHashMatches: true, signatureValid: true, chainValid: null });
    const secondVerify = await closingSnapshots.verify(secondSnapshot.id);
    expect(secondVerify).toEqual({ ok: true, contentHashMatches: true, signatureValid: true, chainValid: true });

    // Tamper detection: mutate the FIRST snapshot's stored bytes, confirm verify now fails on
    // content hash — proving the check actually detects tampering, not just reports "ok" blindly.
    const raw = JSON.parse(await readFile(firstSnapshot.manifestPath!, 'utf8'));
    raw.body.periodCode = 'TAMPERED';
    await writeFile(firstSnapshot.manifestPath!, JSON.stringify(raw));
    const tamperedVerify = await closingSnapshots.verify(firstSnapshot.id);
    expect(tamperedVerify.ok).toBe(false);
    expect(tamperedVerify.contentHashMatches).toBe(false);
  }, 30_000);

  it('blocks submitPeriodClose before creating any FA-01 request when the Closing Audit is not clean', async () => {
    const stub = moduleRef.get(ClosingAuditService) as unknown as { assertCleanForClose: jest.Mock };
    stub.assertCleanForClose.mockRejectedValueOnce(new Error('1 blocking exception: simulated for this test'));

    const year = await fiscalPeriods.createFiscalYear(
      { code: shortCode('P3C'), startDate: '2031-03-01', endDate: '2031-03-31' },
      ADMIN_A,
    );
    const [period] = await fiscalPeriods.listPeriods(year.id);
    await fiscalPeriods.transitionPeriod(period.id, 'soft_close', ADMIN_A);

    await expect(fiscalPeriods.submitPeriodClose(period.id, ADMIN_A)).rejects.toThrow(/simulated for this test/);

    // No FA-01 request was created — confirmed structurally, not just by the thrown error.
    const status = await processEngine.getState(FISCAL_PERIOD_PROCESS, FISCAL_PERIOD_ENTITY_TYPE, period.id);
    expect(status).toBe('soft_close'); // unchanged — nothing was submitted or applied

    const workflowRuns = await fiscalPeriods.listClosingWorkflowRuns(period.id);
    expect(workflowRuns).toHaveLength(1);
    expect(workflowRuns[0].status).toBe('exceptions_open');
    expect(workflowRuns[0].approvalRequestId).toBeNull();
  }, 30_000);
});
