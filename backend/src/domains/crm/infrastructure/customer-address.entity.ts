import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** Customer profile (gap matrix §5.3, migration 1790016100000) — a customer's address book. One default per customer (partial unique index). */
@Entity('customer_addresses')
export class CustomerAddress {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  customerId!: string;

  @Column({ type: 'varchar', length: 128, nullable: true })
  label!: string | null;

  @Column({ type: 'varchar', length: 500 })
  addressLine!: string;

  @Column({ type: 'varchar', length: 128, nullable: true })
  city!: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  governorate!: string | null;

  @Column({ type: 'boolean', default: false })
  isDefault!: boolean;

  @Column({ type: 'boolean', default: false })
  isBilling!: boolean;

  @Column({ type: 'boolean', default: false })
  isShipping!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
