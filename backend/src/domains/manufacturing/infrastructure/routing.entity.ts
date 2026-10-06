import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type RoutingStatus = 'active' | 'inactive';

/**
 * ADR-061 Addendum 1 (A1) — one routing per finished product (mirrors BOM's one-per-product),
 * an ordered list of operations. Sequencing master data only; no costing effect.
 */
@Entity('routings')
export class Routing {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column('uuid')
  finishedProductId!: string;

  @Column({ type: 'varchar', length: 16, default: 'active' })
  status!: RoutingStatus;

  @Column({ type: 'uuid', nullable: true })
  createdByUserId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
