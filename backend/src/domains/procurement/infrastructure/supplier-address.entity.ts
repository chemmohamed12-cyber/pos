import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('supplier_addresses')
export class SupplierAddress {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  supplierId!: string;

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

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
