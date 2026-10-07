import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/** F3 role types (Blueprint §6): `system` = structural (`company_admin`), `template` = cloned from the catalog, `custom` = Company-created, `legacy` = pre-template flat keys and the pre-existing `admin` that business logic still checks by name. */
export type RoleKind = 'system' | 'template' | 'custom' | 'legacy';

/**
 * Authorization — Stage 2 build-order item 7.
 * Daii/architecture/DAII_PLATFORM_FOUNDATION_CONTRACT.md §3.
 *
 * Role is data, not a hardcoded enum in application code (blueprint §37:
 * canonical machine values, never business constants baked into logic).
 * Display labels belong to the Terminology Registry (item 16, not built
 * yet) — Role intentionally has no label/display field to avoid
 * pre-empting that ownership.
 */
@Entity('roles')
export class Role {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  key!: string;

  @Column({ type: 'varchar', length: 16, default: 'custom' })
  type!: RoleKind;

  @Column({ type: 'varchar', length: 64, nullable: true })
  templateKey!: string | null;

  /** The catalog version this role was cloned at / last upgraded to. */
  @Column({ type: 'int', nullable: true })
  templateVersion!: number | null;

  /** "Ignore this update" is remembered: the highest template version the Company declined. */
  @Column({ type: 'int', nullable: true })
  templateIgnoredVersion!: number | null;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  /** Template roles: do the grants diverge from the template? `null` = not evaluated yet (the role service evaluates on first read and keeps it current on every edit). */
  @Column({ type: 'boolean', nullable: true })
  customized!: boolean | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  nameAr!: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  nameEn!: string | null;

  @Column({ type: 'text', nullable: true })
  descriptionAr!: string | null;

  @Column({ type: 'text', nullable: true })
  descriptionEn!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ type: 'uuid', nullable: true })
  createdBy!: string | null;
}
