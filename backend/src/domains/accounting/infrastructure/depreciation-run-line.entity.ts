import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * F12 — Fixed Assets (ADR-045 D2/D14). One posted (or about-to-be-posted, within the same transaction)
 * depreciation charge for one asset, one period.
 *
 * `UNIQUE (fixedAssetId, depreciationPeriod)` is the BINDING architecture invariant (ADR-045 D2, not
 * merely a test case): a successfully posted charge for a given asset/period pair can never be posted
 * twice — not via a retried run, not via a second run covering the same period, not under concurrent
 * execution. `depreciationPeriod` is denormalized from the owning `DepreciationRun` specifically so this
 * constraint can be declared directly on this table.
 *
 * `openingNetBookValue`/`depreciableBase`/`resultingAccumulatedDepreciation`/`resultingNetBookValue`
 * are an IMMUTABLE calculation snapshot (ADR-045 D14) — not merely `calculatedAmount` — so a past
 * posted line's own explanation never depends on the asset's current master-data state.
 */
@Entity('accounting_depreciation_run_lines')
@Index('UQ_accounting_depreciation_run_lines_asset_period', ['fixedAssetId', 'depreciationPeriod'], { unique: true })
export class DepreciationRunLine {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'uuid' })
  depreciationRunId!: string;

  @Column({ type: 'uuid' })
  fixedAssetId!: string;

  /** Denormalized from the owning `DepreciationRun` — see the class doc comment for why. */
  @Column({ type: 'varchar', length: 7 })
  depreciationPeriod!: string;

  @Column({ type: 'numeric', precision: 20, scale: 4 })
  openingNetBookValue!: string;

  @Column({ type: 'numeric', precision: 20, scale: 4 })
  depreciableBase!: string;

  @Column({ type: 'numeric', precision: 20, scale: 4 })
  calculatedAmount!: string;

  @Column({ type: 'numeric', precision: 20, scale: 4 })
  resultingAccumulatedDepreciation!: string;

  @Column({ type: 'numeric', precision: 20, scale: 4 })
  resultingNetBookValue!: string;

  @Column({ type: 'uuid', nullable: true })
  journalEntryId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
