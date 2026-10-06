import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type PlanStatus = 'active' | 'archived';

/**
 * Company Plans / Packages. A Plan (Package) is a named, platform-level set of
 * commercial modules a Company may be given. It is an authoring catalog only:
 * what a Company can actually use is `package ∩ installation licence`
 * (`CompanyEntitlementService`), so a Plan can never grant more than the
 * installation's own signed entitlement allows.
 */
@Entity('plans')
export class Plan {
  /** Stable slug, e.g. `commerce-core`. Never reused. */
  @PrimaryColumn({ type: 'varchar', length: 64 })
  code!: string;

  @Column({ type: 'varchar', length: 128 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  /** `archived` plans cannot be assigned to new Companies; existing assignments keep working. */
  @Column({ type: 'varchar', length: 16, default: 'active' })
  status!: PlanStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}

/** One module granted by a Plan. The dependency closure is stored expanded, so reads never recompute it. */
@Entity('plan_modules')
@Index('UQ_plan_modules_plan_module', ['planCode', 'moduleCode'], { unique: true })
export class PlanModule {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 64 })
  planCode!: string;

  @Column({ type: 'varchar', length: 64 })
  moduleCode!: string;
}

/** The Plan currently assigned to a Company — at most one row per Company (history lives in the audit chain). */
@Entity('company_plan_assignments')
export class CompanyPlanAssignment {
  @PrimaryColumn({ type: 'uuid' })
  companyId!: string;

  @Index()
  @Column({ type: 'varchar', length: 64 })
  planCode!: string;

  @Column({ type: 'uuid', nullable: true })
  assignedByUserId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  assignedAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
