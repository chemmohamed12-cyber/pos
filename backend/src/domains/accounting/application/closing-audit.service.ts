import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Between, DataSource, In, EntityManager } from 'typeorm';
import { ClosingAuditRun } from '../infrastructure/closing-audit-run.entity';
import { ClosingException } from '../infrastructure/closing-exception.entity';
import { ClosingExceptionFinding } from '../domain/closing-exception';
import { classifyReconciliationStatus, classifyRejectedFinancialEvent } from '../domain/closing-exception-classification';
import { FiscalPeriod } from '../infrastructure/fiscal-period.entity';
import { FiscalYear } from '../infrastructure/fiscal-year.entity';
import { FinancialEvent } from '../infrastructure/financial-event.entity';
import { AuditService } from '../../../foundation/audit/audit.service';
import { ArReconciliationService } from './ar-reconciliation.service';
import { ApReconciliationService } from './ap-reconciliation.service';
import { CashBankReconciliationService } from './cash-bank-reconciliation.service';
import { InventoryReconciliationService } from './inventory-reconciliation.service';
import { FixedAssetReconciliationService } from './fixed-asset-reconciliation.service';
import { GrniReconciliationService } from './grni-reconciliation.service';
import { WipReconciliationService } from './wip-reconciliation.service';

const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000'; // matches this codebase's existing convention (FiscalPeriodService et al.)

/**
 * ADR-050 (original) + ADR-051 §2/¡3 (Month-End Closing / Black Box, Phase 2
 * revision) — Period Closing Audit Engine. Orchestrates the five existing
 * reconciliation services plus in-period REJECTED financial events for one
 * `FiscalPeriod`, classifies every finding via the versioned policy in
 * `closing-exception-classification.ts` (replacing ADR-050's original
 * hardcoded per-domain rule), and persists each finding as a first-class
 * `ClosingException` row (replacing ADR-050's `ClosingAuditRun.exceptions`
 * JSONB array — Study §C.1). Introduces no new reconciliation arithmetic
 * of its own — every number here is read from an existing, already-tested
 * service.
 *
 * `resolved` (ADR-051 §2) is set HERE, and only here: a previously
 * `open`/`acknowledged` exception for this period whose finding signature
 * (module + source + document/account ref) is no longer reproduced by this
 * fresh run is proven resolved — never on a human's own say-so.
 */
@Injectable()
export class ClosingAuditService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly arReconciliation: ArReconciliationService,
    private readonly apReconciliation: ApReconciliationService,
    private readonly cashBankReconciliation: CashBankReconciliationService,
    private readonly inventoryReconciliation: InventoryReconciliationService,
    private readonly fixedAssetReconciliation: FixedAssetReconciliationService,
    private readonly grniReconciliation: GrniReconciliationService,
    private readonly wipReconciliation: WipReconciliationService,
  ) {}

  private em(manager?: EntityManager): EntityManager {
    return manager ?? this.dataSource.manager;
  }

  async listRuns(fiscalPeriodId: string, manager?: EntityManager): Promise<ClosingAuditRun[]> {
    return this.em(manager)
      .getRepository(ClosingAuditRun)
      .find({ where: { fiscalPeriodId }, order: { createdAt: 'DESC' } });
  }

  async run(fiscalPeriodId: string, actorUserId: string, manager?: EntityManager): Promise<ClosingAuditRun> {
    const period = await this.em(manager).getRepository(FiscalPeriod).findOne({ where: { id: fiscalPeriodId } });
    if (!period) throw new NotFoundException(`Fiscal period "${fiscalPeriodId}" not found.`);
    const year = await this.em(manager).getRepository(FiscalYear).findOne({ where: { id: period.fiscalYearId } });
    const orgUnitId = year?.orgUnitId ?? null;
    const asOfDate = period.endDate;

    const findings: ClosingExceptionFinding[] = [];

    const ar = await this.arReconciliation.reconcile({ fiscalPeriodId, asOfDate, orgUnitId }, actorUserId, manager);
    const arClass = classifyReconciliationStatus(ar.status);
    if (arClass) {
      findings.push({
        module: 'ar',
        documentType: null,
        documentId: null,
        transactionRef: null,
        accountOrSubledgerRef: null,
        amount: ar.driftBase,
        source: 'ar_reconciliation',
        category: arClass.category,
        severity: arClass.severity,
        problem: `AR subledger and GL differ by ${ar.driftBase} as of ${asOfDate}.`,
        requiredAction: arClass.requiredAction,
      });
    }

    const ap = await this.apReconciliation.reconcile({ fiscalPeriodId, asOfDate, orgUnitId }, actorUserId, manager);
    const apClass = classifyReconciliationStatus(ap.status);
    if (apClass) {
      findings.push({
        module: 'ap',
        documentType: null,
        documentId: null,
        transactionRef: null,
        accountOrSubledgerRef: null,
        amount: ap.driftBase,
        source: 'ap_reconciliation',
        category: apClass.category,
        severity: apClass.severity,
        problem:
          ap.status === 'drift_found'
            ? `AP subledger and GL differ by ${ap.driftBase} as of ${asOfDate}.`
            : 'No operational supplier-ledger source is registered — AP reconciliation could not confirm a match.',
        requiredAction: apClass.requiredAction,
      });
    }

    const cashBankRuns = await this.cashBankReconciliation.reconcile({ fiscalPeriodId, asOfDate, orgUnitId }, actorUserId, manager);
    for (const cbRun of cashBankRuns) {
      const cbClass = classifyReconciliationStatus(cbRun.status);
      if (cbClass) {
        findings.push({
          module: 'cash_bank',
          documentType: null,
          documentId: null,
          transactionRef: null,
          accountOrSubledgerRef: cbRun.treasuryAccountId,
          amount: cbRun.driftBase,
          source: 'cash_bank_reconciliation',
          category: cbClass.category,
          severity: cbClass.severity,
          problem: `Cash/Bank treasury account ${cbRun.treasuryAccountId} and GL differ by ${cbRun.driftBase} as of ${asOfDate}.`,
          requiredAction: cbClass.requiredAction,
        });
      }
    }

    const inventory = await this.inventoryReconciliation.reconcile({ fiscalPeriodId, asOfDate, orgUnitId }, actorUserId, manager);
    const invClass = classifyReconciliationStatus(inventory.status);
    if (invClass) {
      findings.push({
        module: 'inventory',
        documentType: null,
        documentId: null,
        transactionRef: null,
        accountOrSubledgerRef: null,
        amount: inventory.driftBase,
        source: 'inventory_reconciliation',
        category: invClass.category,
        severity: invClass.severity,
        problem:
          inventory.status === 'drift_found'
            ? `Inventory valuation and GL differ by ${inventory.driftBase} as of ${asOfDate}.`
            : 'No inventory valuation source is registered — inventory reconciliation could not confirm a match.',
        requiredAction: invClass.requiredAction,
      });
    }

    const { pairs } = await this.fixedAssetReconciliation.reconcile(asOfDate, orgUnitId ?? undefined, manager);
    for (const pair of pairs) {
      if (!pair.costMatched || !pair.accumulatedDepreciationMatched || !pair.netBookValueMatched) {
        findings.push({
          module: 'fixed_asset',
          documentType: null,
          documentId: null,
          transactionRef: null,
          accountOrSubledgerRef: pair.costAccountId,
          amount: null,
          source: 'fixed_asset_reconciliation',
          category: 'LIVE_DISCREPANCY',
          severity: 'blocking',
          problem: `Fixed asset register and GL differ for cost account ${pair.costAccountId} as of ${asOfDate}.`,
          requiredAction: "Investigate the drift, post an approved correcting entry via the domain's own adjustment service, then re-run the Closing Audit.",
        });
      }
    }

    // ADR-054/ADR-056 (Phase 8) — the sixth reconciliation type Month-End Closing must verify.
    // Structurally IDENTICAL to the AP block above (same dormant/@Optional() contract shape) —
    // reports 'no_subledger_source' until Procurement's GRNI posting logic (ADR-054) exists and
    // binds GRNI_LEDGER_CONTRACT. Confirmed by direct search: no such binding exists in this
    // codebase yet — this is a real, honest "structurally ready but not yet lit up" state, not a
    // mock (ADR-056's explicit instruction).
    const grni = await this.grniReconciliation.reconcile({ fiscalPeriodId, asOfDate, orgUnitId }, actorUserId, manager);
    const grniClass = classifyReconciliationStatus(grni.status);
    if (grniClass) {
      findings.push({
        module: 'grni',
        documentType: null,
        documentId: null,
        transactionRef: null,
        accountOrSubledgerRef: null,
        amount: grni.driftBase,
        source: 'grni_reconciliation',
        category: grniClass.category,
        severity: grniClass.severity,
        problem:
          grni.status === 'drift_found'
            ? `Outstanding GRNI balances and GL differ by ${grni.driftBase} as of ${asOfDate}.`
            : 'No operational GRNI ledger source is registered — GRNI reconciliation could not confirm a match.',
        requiredAction: grniClass.requiredAction,
      });
    }

    // ADR-061 (Manufacturing) Month-End dependency, resolved per the independent review's Phase 1
    // finding — the seventh reconciliation type. Structurally IDENTICAL to the GRNI block above
    // (same dormant/@Optional() contract shape): reports 'no_subledger_source' until the
    // `manufacturing` module is installed and binds MANUFACTURING_WIP_CONTRACT.
    const wip = await this.wipReconciliation.reconcile({ fiscalPeriodId, asOfDate, orgUnitId }, actorUserId, manager);
    const wipClass = classifyReconciliationStatus(wip.status);
    if (wipClass) {
      findings.push({
        module: 'wip',
        documentType: null,
        documentId: null,
        transactionRef: null,
        accountOrSubledgerRef: null,
        amount: wip.driftBase,
        source: 'wip_reconciliation',
        category: wipClass.category,
        severity: wipClass.severity,
        problem:
          wip.status === 'drift_found'
            ? `Manufacturing WIP balances and GL differ by ${wip.driftBase} as of ${asOfDate}.`
            : 'No operational Manufacturing WIP source is registered — WIP reconciliation could not confirm a match.',
        requiredAction: wipClass.requiredAction,
      });
    }

    const rejectedEvents = await this.em(manager).getRepository(FinancialEvent).find({
      where: { status: 'REJECTED', businessDate: Between(period.startDate, period.endDate) },
    });
    for (const event of rejectedEvents) {
      if (orgUnitId !== null && event.orgUnitId !== null && event.orgUnitId !== orgUnitId) continue;
      const feClass = classifyRejectedFinancialEvent(event.rejectionReason);
      findings.push({
        module: 'financial_events',
        documentType: event.sourceEntityType,
        documentId: event.sourceEntityId,
        transactionRef: event.id,
        accountOrSubledgerRef: null,
        amount: null,
        source: event.eventType,
        category: feClass.category,
        severity: feClass.severity,
        problem: `${event.eventType} event rejected: ${event.rejectionReason ?? 'no reason recorded'}.`,
        requiredAction: feClass.requiredAction,
      });
    }

    const status: ClosingAuditRun['status'] = findings.some((f) => f.severity === 'blocking') ? 'exceptions_found' : 'clean';

    const savedRun = await this.em(manager).getRepository(ClosingAuditRun).save(
      this.em(manager).getRepository(ClosingAuditRun).create({
        fiscalPeriodId,
        asOfDate,
        orgUnitId,
        status,
        exceptions: [], // ADR-051 §1/§C.1 — superseded by first-class ClosingException rows below
        runByUserId: actorUserId,
      }),
    );

    await this.reconcileExceptionRows(fiscalPeriodId, savedRun.id, asOfDate, findings, manager);

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'accounting.closing_audit.run',
      resource: 'closing_audit_run',
      resourceId: savedRun.id,
      result: 'success',
      correlationId: null,
      after: { fiscalPeriodId, status, findingCount: findings.length },
    }, manager);

    return savedRun;
  }

  /**
   * ADR-051 §2 — diffs this run's fresh findings against the period's
   * currently open/acknowledged exceptions by a stable signature
   * (module + source + document/account ref):
   *
   * - No longer reproduced at all → proven `resolved` HERE (never by a
   *   direct human call).
   * - Genuinely new signature → inserted.
   * - Signature still reproduces, but its underlying classification
   *   CHANGED (e.g. a redrive attempt surfaces a different rejection
   *   reason than the one originally recorded — observed live during
   *   Phase 2 verification: a stale `negative_on_hand` supersedes an
   *   earlier `CONFIGURATION_EXCEPTION` for the exact same event) → the
   *   existing row's `category`/`severity`/`problem`/`requiredAction` are
   *   refreshed to the fresh finding, WITHOUT touching its `status`/
   *   `resolvedBy*`/`id`/`createdAt`. The one exception: a row already
   *   manually annotated `HISTORICAL_TEST_ARTIFACT` (ADR-051 §3) is never
   *   refreshed by the classifier — that annotation is "permanent, never
   *   cleared" by design, and silently overwriting it here would defeat
   *   the entire point of requiring an explicit human annotation.
   */
  private async reconcileExceptionRows(
    fiscalPeriodId: string,
    closingAuditRunId: string,
    asOfDate: string,
    findings: ClosingExceptionFinding[], manager?: EntityManager): Promise<void> {
    const repo = this.em(manager).getRepository(ClosingException);
    const signatureOf = (f: { module: string; source: string; documentId: string | null; accountOrSubledgerRef: string | null }) =>
      `${f.module}::${f.source}::${f.documentId ?? ''}::${f.accountOrSubledgerRef ?? ''}`;

    const existingOpen = await repo.find({ where: { fiscalPeriodId, status: In(['open', 'acknowledged']) } });
    const findingBySignature = new Map(findings.map((f) => [signatureOf(f), f]));
    const existingSignatures = new Set(existingOpen.map(signatureOf));

    for (const existing of existingOpen) {
      const sig = signatureOf(existing);
      const stillReproduced = findingBySignature.get(sig);

      if (!stillReproduced) {
        existing.status = 'resolved';
        existing.resolvedByUserId = SYSTEM_ACTOR_ID;
        existing.resolvedAt = new Date();
        existing.resolutionNote = `No longer reproduced by Closing Audit run ${closingAuditRunId} on ${asOfDate}.`;
        await repo.save(existing);
        continue;
      }

      if (existing.category === 'HISTORICAL_TEST_ARTIFACT') continue; // sticky — never refreshed by the classifier (ADR-051 §3)

      const classificationChanged =
        existing.category !== stillReproduced.category || existing.severity !== stillReproduced.severity || existing.problem !== stillReproduced.problem;
      if (classificationChanged) {
        existing.category = stillReproduced.category;
        existing.severity = stillReproduced.severity;
        existing.problem = stillReproduced.problem;
        existing.requiredAction = stillReproduced.requiredAction;
        await repo.save(existing);
      }
    }

    for (const finding of findings) {
      if (existingSignatures.has(signatureOf(finding))) continue; // already tracked — refreshed above, never duplicated
      await repo.save(repo.create({ closingAuditRunId, fiscalPeriodId, ...finding }));
    }
  }

  /**
   * ADR-051 §7 — ALWAYS a fresh run, never a cached prior result. Throws
   * listing every currently `blocking` open/acknowledged exception for this
   * period when the period is not clean to close. Returns the fresh
   * `ClosingAuditRun` (Phase 3's `ClosingWorkflowRun.finalReconciliationRunId`
   * references it) when the period IS clean.
   */
  async assertCleanForClose(fiscalPeriodId: string, actorUserId: string, manager?: EntityManager): Promise<ClosingAuditRun> {
    const freshRun = await this.run(fiscalPeriodId, actorUserId, manager);
    const blocking = await this.em(manager)
      .getRepository(ClosingException)
      .find({ where: { fiscalPeriodId, severity: 'blocking', status: In(['open', 'acknowledged']) } });
    if (blocking.length > 0) {
      throw new ConflictException(
        `Cannot submit this fiscal period for closing — ${blocking.length} unresolved discrepanc${blocking.length === 1 ? 'y' : 'ies'}: ` +
          blocking.map((e) => e.problem).join(' | '),
      );
    }
    return freshRun;
  }
}
