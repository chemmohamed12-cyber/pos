import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type WorkCenterStatus = 'active' | 'inactive';

/**
 * ADR-061 Addendum 1 (A1) — Work Center: a named place/resource where a routing operation is
 * performed. Assignment master data ONLY — no capacity, labor/machine hours, rates or overhead
 * (ADR-060 D2/D3).
 */
@Entity('work_centers')
export class WorkCenter {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  code!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  description!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'active' })
  status!: WorkCenterStatus;

  @Column({ type: 'uuid', nullable: true })
  createdByUserId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
