import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type OrgUnitType = 'company' | 'branch' | 'department' | 'team' | 'warehouse';

/**
 * Organization — Stage 2 build-order item 10.
 * Daii/architecture/DAII_PLATFORM_FOUNDATION_CONTRACT.md §7.
 * Adapted from baseline/server/engines/organization-engine.js (Class B,
 * Daii/_source-audits/baseline/) — the source's hardcoded single-company
 * assumption (ENG-026) is deliberately NOT carried over: a single
 * self-referential tree (type + parentId) supports any number of
 * companies/branches/depth, rather than 4 fixed hardcoded tables.
 */
@Entity('org_units')
export class OrgUnit {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 16 })
  type!: OrgUnitType;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  /** ADR-059 D4 (HR Phase 1) — nullable; only `type = 'department'` units created via HR are currently code-issued (`NumberingService`, document type `hr_department`). Other unit types leave this null. */
  @Index({ unique: true, where: '"code" IS NOT NULL' })
  @Column({ type: 'varchar', length: 32, nullable: true })
  code!: string | null;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  parentId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
