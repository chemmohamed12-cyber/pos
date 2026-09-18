import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ClosingException } from '../infrastructure/closing-exception.entity';
import { AuditService } from '../../../foundation/audit/audit.service';

/**
 * ADR-051 §2/§3 (Month-End Closing / Black Box, Phase 2). Owns the
 * `ClosingException` lifecycle's two human-settable transitions:
 *
 * - `acknowledge` (`open → acknowledged`) — bookkeeping only, no
 *   severity change. Gated by `accounting.closing_exception.resolve` (the
 *   node name reflects the overall workflow this permission grants access
 *   to, not this one specific step — frozen in ADR-051 §15).
 * - `annotateTestArtifact` — the ONLY way `HISTORICAL_TEST_ARTIFACT` is
 *   ever reached (ADR-051 §3: never inferred by any pattern rule).
 *   Reclassifies category + severity directly and permanently records who,
 *   when, why. Gated by its own dedicated node,
 *   `accounting.closing_exception.annotate_test_artifact`.
 *
 * `resolved` is deliberately UNREACHABLE from this service —
 * `ClosingAuditService.run()` is the only code path that ever sets it,
 * and only when a fresh run no longer reproduces the finding (ADR-051 §2).
 * `waived` is unreachable everywhere in V1 (Study §5 Decision 1).
 */
@Injectable()
export class ClosingExceptionService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  async list(fiscalPeriodId: string): Promise<ClosingException[]> {
    return this.dataSource.getRepository(ClosingException).find({ where: { fiscalPeriodId }, order: { createdAt: 'DESC' } });
  }

  async get(id: string): Promise<ClosingException> {
    const found = await this.dataSource.getRepository(ClosingException).findOne({ where: { id } });
    if (!found) throw new NotFoundException(`Closing exception "${id}" not found.`);
    return found;
  }

  async acknowledge(id: string, actorUserId: string, note: string): Promise<ClosingException> {
    const exception = await this.get(id);
    if (exception.status !== 'open') {
      throw new ConflictException(`Closing exception "${id}" is "${exception.status}" — only an "open" exception can be acknowledged.`);
    }
    exception.status = 'acknowledged';
    exception.resolutionNote = note;
    const saved = await this.dataSource.getRepository(ClosingException).save(exception);
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'accounting.closing_exception.acknowledged',
      resource: 'closing_exception',
      resourceId: id,
      result: 'success',
      correlationId: null,
      after: { note },
    });
    return saved;
  }

  /**
   * ADR-051 §3 — the one and only path to `HISTORICAL_TEST_ARTIFACT`.
   * Only meaningful on a `financial_events`-sourced exception (a
   * reconciliation drift has no "test artifact" interpretation — a live
   * subledger/GL mismatch is always either real or a bug, never test
   * noise). Recommended (Study §2.3) to be restricted outside Production
   * by deployment policy — not enforced in code here, since that
   * environment gate is an operational decision outside this service's
   * own scope.
   */
  async annotateTestArtifact(id: string, actorUserId: string, reason: string): Promise<ClosingException> {
    const exception = await this.get(id);
    if (exception.module !== 'financial_events') {
      throw new ConflictException(
        `Closing exception "${id}" is a "${exception.module}" reconciliation finding — HISTORICAL_TEST_ARTIFACT only applies to a rejected-financial-event finding.`,
      );
    }
    if (exception.category === 'HISTORICAL_TEST_ARTIFACT') {
      throw new ConflictException(`Closing exception "${id}" is already annotated as HISTORICAL_TEST_ARTIFACT.`);
    }
    exception.category = 'HISTORICAL_TEST_ARTIFACT';
    exception.severity = 'informational';
    exception.annotation = { byUserId: actorUserId, at: new Date().toISOString(), reason };
    const saved = await this.dataSource.getRepository(ClosingException).save(exception);
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'accounting.closing_exception.annotated_test_artifact',
      resource: 'closing_exception',
      resourceId: id,
      result: 'success',
      correlationId: null,
      after: { reason },
    });
    return saved;
  }
}
