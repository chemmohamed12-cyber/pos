import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** Customer profile (gap matrix §5.3, migration 1790016100000) — contact persons. One primary per customer (partial unique index). */
@Entity('customer_contacts')
export class CustomerContact {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  customerId!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'varchar', length: 128, nullable: true })
  title!: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  phone!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  email!: string | null;

  @Column({ type: 'boolean', default: false })
  isPrimary!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
