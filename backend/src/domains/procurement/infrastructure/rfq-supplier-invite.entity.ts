import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('rfq_supplier_invites')
export class RfqSupplierInvite {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  rfqId!: string;

  @Index()
  @Column('uuid')
  supplierId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  invitedAt!: Date;
}
