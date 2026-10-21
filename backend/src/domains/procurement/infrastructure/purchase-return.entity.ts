import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * Phase D-1 (D7) - a formal purchase return: goods leaving a warehouse back to the supplier, linked line by line to the goods-receipt lines they came from. Lifecycle (Process Engine
 * `purchase_return_lifecycle`): draft -> submitted -> approved -> posted, with rejected / void. A POSTED return is never edited or voided; a correction is a new document.
 */
@Entity('purchase_returns')
export class PurchaseReturn {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  returnNumber!: string;

  @Index()
  @Column('uuid')
  supplierId!: string;

  @Column('uuid')
  warehouseId!: string;

  @Column({ type: 'varchar', length: 255 })
  reason!: string;

  @Column('uuid')
  createdByUserId!: string;

  @Column({ type: 'uuid', nullable: true })
  submittedByUserId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  approvedByUserId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  approvedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  postedByUserId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  postedAt!: Date | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  rejectedReason!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  voidedReason!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
