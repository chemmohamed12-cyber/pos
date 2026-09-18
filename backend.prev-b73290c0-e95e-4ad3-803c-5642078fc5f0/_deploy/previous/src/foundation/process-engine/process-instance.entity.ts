import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('process_instances')
@Index(['definitionKey', 'entityType', 'entityId'], { unique: true })
export class ProcessInstance {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 128 })
  definitionKey!: string;

  @Column({ type: 'varchar', length: 64 })
  entityType!: string;

  @Index()
  @Column({ type: 'varchar', length: 255 })
  entityId!: string;

  @Column({ type: 'varchar', length: 64 })
  currentState!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
