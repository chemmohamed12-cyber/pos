import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** Append-only transition history — every state change is a new row, never an edit (blueprint §18). */
@Entity('process_transition_records')
export class ProcessTransitionRecord {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  processInstanceId!: string;

  @Column({ type: 'varchar', length: 64 })
  fromState!: string;

  @Column({ type: 'varchar', length: 64 })
  toState!: string;

  @Column({ type: 'varchar', length: 64 })
  action!: string;

  @Column({ type: 'uuid', nullable: true })
  actorUserId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  occurredAt!: Date;
}
