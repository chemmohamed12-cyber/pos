import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { EmployeeStatus } from '../domain/employee-status';

/**
 * ADR-059 (HR Phase 1). One row per `Employee.status` transition —
 * closes the Phase 0 study's "HrService never audits" gap with a
 * queryable, employee-scoped history (in addition to, not instead of, the
 * platform-wide `AuditService.record` call every transition also makes).
 */
@Entity('hr_employee_status_history')
export class EmployeeStatusHistory {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'uuid' })
  employeeId!: string;

  @Column({ type: 'varchar', length: 16 })
  fromStatus!: EmployeeStatus;

  @Column({ type: 'varchar', length: 16 })
  toStatus!: EmployeeStatus;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  @Column({ type: 'uuid' })
  changedByUserId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  changedAt!: Date;
}
