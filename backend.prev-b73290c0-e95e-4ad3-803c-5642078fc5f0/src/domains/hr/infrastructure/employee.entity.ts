import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { EmployeeStatus } from '../domain/employee-status';

/**
 * ERP Foundation — P9 (ADR-029). Owned by `hr` only. `departmentId` is a
 * plain nullable uuid column, not a TypeORM `@ManyToOne` relation into a
 * cross-domain entity class — same convention as every other domain here
 * (e.g. `Customer.priceListId`) — but it is `hr`'s OWN `Department` table,
 * not a foreign module's, so this stays a zero-dependency module either way.
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

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
