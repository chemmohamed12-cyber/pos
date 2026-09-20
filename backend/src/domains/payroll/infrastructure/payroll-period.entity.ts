import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * ADR-070 §4/§A — Monthly in Phase 1 (`ADR-067 §A`), designed so a future
 * frequency just adds a value to how periods are generated, not a schema
 * change. `status` is Payroll's own concept, independent of the Financial
 * Period (`ADR-070 §17`).
 */
@Entity('payroll_periods')
export class PayrollPeriod {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 32 })
  code!: string;

  @Column({ type: 'date' })
  startDate!: string;

  @Column({ type: 'date' })
  endDate!: string;

  @Column({ type: 'varchar', length: 16, default: 'open' })
  status!: 'open' | 'closed';

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
