import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { EmployeeStatus } from '../domain/employee-status';
import { EmploymentType } from '../domain/employment-type';

/**
 * ERP Foundation — P9 (ADR-029), expanded under ADR-059 (HR Phase 1).
 * `departmentId` is a plain nullable uuid column, not a TypeORM
 * `@ManyToOne` relation — same convention as every other domain here (e.g.
 * `Customer.priceListId`). Since ADR-059 D1, it resolves into
 * `org_units` (`type = 'department'`), not a `hr`-owned table —
 * `hr_departments` was retired and its rows migrated in with their ids
 * preserved, so this column's stored values needed no change.
 *
 * `userId` (D2) is nullable and manually admin-linked only — never
 * auto-provisioned. `managerId` is self-referential (also a plain uuid
 * column, not a relation, for the same cross-row-in-same-table reason
 * every self-referential FK in this codebase — e.g. `OrgUnit.parentId` —
 * is modeled this way).
 */
@Entity('hr_employees')
export class Employee {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  code!: string;

  @Column({ type: 'varchar', length: 255 })
  fullName!: string;

  @Column({ type: 'uuid', nullable: true })
  departmentId!: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  position!: string | null;

  @Column({ type: 'date', nullable: true })
  hireDate!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'active' })
  status!: EmployeeStatus;

  /** ADR-059 D2 — manual admin linkage only. Unique when set: one employee per user account. */
  @Index({ unique: true, where: '"userId" IS NOT NULL' })
  @Column({ type: 'uuid', nullable: true })
  userId!: string | null;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  managerId!: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  employmentType!: EmploymentType | null;

  /** ADR-059 D3 — termination is a direct action (no FA-01), so its evidence is captured directly on the aggregate rather than in an approval request's payload. */
  @Column({ type: 'date', nullable: true })
  terminationDate!: string | null;

  @Column({ type: 'text', nullable: true })
  terminationReason!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
