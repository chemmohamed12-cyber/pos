import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * ADR-065 §3 — `(connectorId, deviceUserRef)` uniqueness is enforced only
 * where `effectiveTo IS NULL` (a partial index, applied in the owning
 * migration — TypeORM's decorator-level `@Index` cannot express the
 * `WHERE` clause, so the DB-level constraint is the actual source of
 * truth for this rule, not this decorator). Closing a mapping
 * (`effectiveTo`) and opening a new one preserves every raw record's
 * original resolution history — a mapping row is never mutated to
 * silently reattribute old punches to a different employee.
 */
@Entity('attendance_employee_mappings')
@Index(['connectorId', 'employeeId'])
export class AttendanceEmployeeMapping {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  connectorId!: string;

  @Index()
  @Column('uuid')
  employeeId!: string;

  @Column({ type: 'varchar', length: 128 })
  deviceUserRef!: string;

  @Column({ type: 'timestamptz' })
  effectiveFrom!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  effectiveTo!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
