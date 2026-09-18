import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import {
  ClosingExceptionCategory,
  ClosingExceptionModule,
  ClosingExceptionSeverity,
  ClosingExceptionStatus,
} from '../domain/closing-exception';

/**
 * ADR-051 §1/§2 (Month-End Closing / Black Box, Phase 2). One row per
 * finding — replaces ADR-050's `ClosingAuditRun.exceptions` JSONB array
 * (Study §C.1). `status` lifecycle: `open → acknowledged → resolved`.
 * `waived` is a defined value for forward schema compatibility only — no
 * V1 code path sets it (Study §5 Decision 1: no override/waiver in V1).
 *
 * `resolved` is NEVER set by a direct human action — only by a
 * subsequent `ClosingAuditService.run()` no longer reproducing this exact
 * finding (ADR-051 §2: "an exception is never hand-marked resolved on its
 * own say-so"). The only human-settable transitions are `open →
 * acknowledged` (`accounting.closing_exception.resolve` permission — named
 * for the overall workflow, not this one step) and the
 * `HISTORICAL_TEST_ARTIFACT` reclassification (`accounting.
 * closing_exception.annotate_test_artifact`).
 */
@Entity('accounting_closing_exceptions')
export class ClosingException {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'uuid' })
  closingAuditRunId!: string;

  @Index()
  @Column({ type: 'uuid' })
  fiscalPeriodId!: string;

  @Column({ type: 'varchar', length: 24 })
  module!: ClosingExceptionModule;

  @Column({ type: 'varchar', length: 64, nullable: true })
  documentType!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  documentId!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  transactionRef!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  accountOrSubledgerRef!: string | null;

  @Column({ type: 'numeric', precision: 20, scale: 4, nullable: true })
  amount!: string | null;

  @Column({ type: 'varchar', length: 64 })
  source!: string;

  @Column({ type: 'varchar', length: 32 })
  category!: ClosingExceptionCategory;

  @Index()
  @Column({ type: 'varchar', length: 16 })
  severity!: ClosingExceptionSeverity;

  @Column({ type: 'text' })
  problem!: string;

  @Column({ type: 'text' })
  requiredAction!: string;

  @Index()
  @Column({ type: 'varchar', length: 16, default: 'open' })
  status!: ClosingExceptionStatus;

  @Column({ type: 'uuid', nullable: true })
  resolvedByUserId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  resolvedAt!: Date | null;

  @Column({ type: 'text', nullable: true })
  resolutionNote!: string | null;

  /** Only ever set together with a reclassification to HISTORICAL_TEST_ARTIFACT (ADR-051 §3) — who, when, why. Permanent, never cleared. */
  @Column({ type: 'jsonb', nullable: true })
  annotation!: { byUserId: string; at: string; reason: string } | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
