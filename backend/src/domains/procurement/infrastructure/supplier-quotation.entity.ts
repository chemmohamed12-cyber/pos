import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** ADR-048 — Path B. A supplier's response to an RFQ, recorded by an internal user (suppliers have no system login in this app — same convention as `Supplier` itself being an internal master record, not a portal account). */
@Entity('supplier_quotations')
export class SupplierQuotation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  quotationNumber!: string;

  @Index()
  @Column('uuid')
  rfqId!: string;

  @Index()
  @Column('uuid')
  supplierId!: string;

  @Column({ type: 'numeric', precision: 14, scale: 2 })
  totalAmount!: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  notes!: string | null;

  @Column('uuid')
  recordedByUserId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
