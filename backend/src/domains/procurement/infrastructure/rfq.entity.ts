import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** ADR-048 — Path B. No `status` column — Process Engine (`rfq_lifecycle`) is the single source of truth. */
@Entity('rfqs')
export class Rfq {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  rfqNumber!: string;

  @Index()
  @Column('uuid')
  purchaseRequestId!: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  notes!: string | null;

  @Column('uuid')
  createdByUserId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
