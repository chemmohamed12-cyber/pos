import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type ItemRequestStatus = 'pending' | 'approved' | 'rejected';

/**
 * D7 (2026-10-05, CTO) — the request record behind a "New Item Request". The requested item IS a `draft` Product (so `productId` stays
 * NOT NULL through PR → RFQ → PO → GR, no relinking); this row keeps who asked, why, and the approval outcome. `draft → active`
 * happens only through the Approval Engine (one approver holding `sales.catalog.edit`, maker ≠ checker).
 */
@Entity('product_item_requests')
export class ProductItemRequest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column('uuid')
  productId!: string;

  @Column('uuid')
  requestedByUserId!: string;

  @Column({ type: 'varchar', length: 500 })
  reason!: string;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status!: ItemRequestStatus;

  @Column({ type: 'uuid', nullable: true })
  approvalRequestId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  decidedByUserId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  decidedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
