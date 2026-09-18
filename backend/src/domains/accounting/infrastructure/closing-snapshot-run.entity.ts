import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * ADR-051 §1/§4/§12 (Month-End Closing / Black Box, Phase 5). One row per
 * Immutable Monthly Accounting Snapshot. `status: 'pending'` is written in
 * the SAME transaction that applies the approved close/reclose transition
 * (`FiscalPeriodService.applyApprovedPeriodTransition`) — the file does
 * not exist yet at that point. The actual assembly/canonicalize/hash/sign/
 * write happens immediately after, outside that transaction (file I/O
 * cannot safely share a DB transaction), updating this row to `'complete'`
 * only once the file is fully written and verified against its own
 * recorded hash. A recovery sweep (ADR-051 §12, mirrors
 * `EventBusService.dispatchPending()`) retries any row still `'pending'`
 * after its period is already `'closed'`.
 *
 * Never updated once `'complete'` — no application code path opens an
 * existing snapshot file for writing again (filesystem immutability,
 * ADR-051 §13, independent of the cryptographic tamper-evidence the
 * `contentHash`/`signature` themselves provide).
 */
@Entity('accounting_closing_snapshot_runs')
export class ClosingSnapshotRun {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'uuid' })
  fiscalPeriodId!: string;

  @Column({ type: 'int' })
  closeSequence!: number;

  @Column({ type: 'uuid', nullable: true })
  supersedesSnapshotId!: string | null;

  @Index()
  @Column({ type: 'uuid' })
  approvalRequestId!: string;

  @Column({ type: 'varchar', length: 16 })
  status!: 'pending' | 'complete' | 'failed';

  @Column({ type: 'varchar', length: 128, nullable: true })
  contentHash!: string | null;

  /** The FULL signed manifest's own hash (also the content-addressed filename) — stored directly so chaining a future reclose's `previousManifestHash` never needs to re-read a file (ADR-051 §11). */
  @Column({ type: 'varchar', length: 128, nullable: true })
  manifestHash!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  signingKeyId!: string | null;

  @Column({ type: 'text', nullable: true })
  signature!: string | null;

  @Column({ type: 'text', nullable: true })
  manifestPath!: string | null;

  @Column({ type: 'uuid' })
  generatedByUserId!: string;

  @Column({ type: 'timestamptz', nullable: true })
  generatedAt!: Date | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  appVersion!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  migrationHead!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
