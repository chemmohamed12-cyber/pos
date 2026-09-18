import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { DepreciationMethod } from '../domain/fixed-asset';

/**
 * F12 — Fixed Assets (ADR-045). The register. No `status`/`isActive` column — lifecycle is always read
 * live via `ProcessEngineService` (`FIXED_ASSET_PROCESS`), matching `FiscalYear`/`FiscalPeriod`'s own
 * convention, NOT `GLAccount`'s flat `isActive` (ADR-045 §Read-Before-Write: a fixed asset's lifecycle
 * is genuinely stateful, not a binary toggle).
 *
 * `costAccountId`/`accumulatedDepreciationAccountId`/`depreciationExpenseAccountId` are always the
 * AUTHORITATIVE, explicit account mapping for this asset (ADR-045 D3) — never re-derived from
 * `categoryDimensionValueId` or from `controlFunction` membership at posting time.
 *
 * `depreciableBase` is computed once at creation (`cost - salvageValue`) and frozen — never recomputed
 * from possibly-later-changed fields (ADR-045 D9/D14). `cost`/`salvageValue`/`usefulLifeMonths`/
 * `depreciationMethod` and the three account-mapping fields LOCK once the asset's first
 * `DepreciationRunLine` exists (ADR-045 D12, enforced at the service layer — this entity itself has no
 * lock flag, the service checks for an existing posted line).
 */
@Entity('accounting_fixed_assets')
@Index('UQ_accounting_fixed_assets_acquisition_journal', ['acquisitionJournalEntryId'], {
  unique: true,
  where: '"acquisitionJournalEntryId" IS NOT NULL',
})
export class FixedAsset {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  code!: string;

  @Column({ type: 'varchar', length: 160 })
  name!: string;

  /** F11 `FinancialDimensionValue` (type `asset_category`) — classification only, ADR-045 D8/D9. Never consulted at posting time. */
  @Column({ type: 'uuid', nullable: true })
  categoryDimensionValueId!: string | null;

  @Column({ type: 'date' })
  acquisitionDate!: string;

  @Column({ type: 'numeric', precision: 20, scale: 4 })
  cost!: string;

  @Column({ type: 'numeric', precision: 20, scale: 4, default: 0 })
  salvageValue!: string;

  @Column({ type: 'int' })
  usefulLifeMonths!: number;

  @Column({ type: 'varchar', length: 24 })
  depreciationMethod!: DepreciationMethod;

  /** `cost - salvageValue`, computed once at creation, frozen (ADR-045 D9/D14). */
  @Column({ type: 'numeric', precision: 20, scale: 4 })
  depreciableBase!: string;

  @Index()
  @Column({ type: 'uuid' })
  costAccountId!: string;

  @Index()
  @Column({ type: 'uuid' })
  accumulatedDepreciationAccountId!: string;

  @Index()
  @Column({ type: 'uuid' })
  depreciationExpenseAccountId!: string;

  @Column({ type: 'uuid', nullable: true })
  orgUnitId!: string | null;

  /**
   * ADR-045 D7 — nullable-`UNIQUE` (see the class-level partial index above): the same real
   * `JournalEntry` may never fund more than one asset (Mandatory Correction #3). `null` while
   * `pending_acquisition`.
   */
  @Column({ type: 'uuid', nullable: true })
  acquisitionJournalEntryId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
