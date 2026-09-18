import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * History-tracked, per blueprint §10 — "Customer assignment must NOT be
 * permanently hard-coded as a single sales_rep_id." Ending an assignment
 * sets endDate/status; the row is never deleted or overwritten (blueprint
 * §18 immutable operational history, applied here to assignment history).
 */
export type AssignmentStatus = 'active' | 'ended';

@Entity('customer_assignments')
export class CustomerAssignment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  customerId!: string;

  @Index()
  @Column('uuid')
  salesRepUserId!: string;

  @Column({ type: 'varchar', length: 16, default: 'primary' })
  assignmentType!: 'primary' | 'secondary';

  @Column({ type: 'varchar', length: 16, default: 'active' })
  status!: AssignmentStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  startDate!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  endDate!: Date | null;
}
