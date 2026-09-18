import { Column, Entity, Index, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Entitlement Engine — ERP Foundation P3. The Edition catalog. In the
 * private-installation model only the resolved `installation` row is strictly
 * needed in the customer DB; the catalog is kept for the admin UI + to
 * validate an applied manifest against a known edition. P3_BLUEPRINT.md §1.2.
 *
 * P3 seeds exactly ONE edition — DAII_STANDARD (all 5 modules, all
 * default:true features, no limit overrides). Further editions are added by
 * the issuing tool / a later migration — NOT built in P3.
 */
export type EditionStatus = 'draft' | 'published' | 'retired';

@Entity('editions')
export class Edition {
  @PrimaryColumn({ type: 'varchar', length: 32 })
  code!: string;

  @Column({ type: 'varchar', length: 128 })
  name!: string;

  @Column({ type: 'varchar', length: 32, default: '1.0.0' })
  latestVersion!: string;

  @Column({ type: 'varchar', length: 16, default: 'published' })
  status!: EditionStatus;
}

@Entity('edition_modules')
@Index('UQ_edition_modules', ['editionCode', 'moduleCode'], { unique: true })
export class EditionModule {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 32 })
  editionCode!: string;

  @Column({ type: 'varchar', length: 32 })
  moduleCode!: string;
}

@Entity('edition_features')
@Index('UQ_edition_features', ['editionCode', 'featureCode'], { unique: true })
export class EditionFeature {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 32 })
  editionCode!: string;

  @Column({ type: 'varchar', length: 96 })
  featureCode!: string;
}

@Entity('edition_limits')
@Index('UQ_edition_limits', ['editionCode', 'limitKey'], { unique: true })
export class EditionLimit {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 32 })
  editionCode!: string;

  @Column({ type: 'varchar', length: 96 })
  limitKey!: string;

  /** null = unlimited. */
  @Column({ type: 'bigint', nullable: true })
  value!: string | null;
}
