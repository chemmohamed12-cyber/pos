import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * F12 — Fixed Assets (ADR-045 D2/D10/D13). One disposal (sale/scrap/write-off), FA-01-gated. Submitted
 * by a maker (`approvalRequestId` references the FA-01 `ApprovalRequest`); only on approval does this
 * post through `JournalEntryService`, recording `journalEntryId`. `proceedsAccountId` and the resolved
 * gain/loss account are both validated at submission AND revalidated, authoritatively, at posting time
 * (ADR-045 D10, Mandatory Correction #2) — nothing here is trusted across the approval gap.
 */
@Entity('accounting_fixed_asset_disposals')
export class FixedAssetDisposal {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'uuid' })
  fixedAssetId!: string;

  @Column({ type: 'date' })
  disposalDate!: string;

  @Column({ type: 'numeric', precision: 20, scale: 4, default: 0 })
  proceeds!: string;

  /** Required iff `proceeds > 0` (ADR-045 D10) — the maker's chosen settlement destination (cash/bank/AR/other). */
  @Column({ type: 'uuid', nullable: true })
  proceedsAccountId!: string | null;

  /** Signed: positive = gain, negative = loss. Computed at posting time from cost/accumulated-depreciation/proceeds. */
  @Column({ type: 'numeric', precision: 20, scale: 4, nullable: true })
  gainLossAmount!: string | null;

  /** Nullable transiently — the FA-01 request must exist before its own id is known (created after
   * this row, whose own id the request's payload needs). Backfilled immediately after submission,
   * in the same call. Postgres allows multiple NULLs under a UNIQUE index (standard SQL semantics). */
  @Index({ unique: true })
  @Column({ type: 'uuid', nullable: true })
  approvalRequestId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  journalEntryId!: string | null;

  @Column({ type: 'uuid' })
  createdBy!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
