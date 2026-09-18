import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Account Type → Accounts/Sub-Accounts hierarchy (CTO directive — Treasury
 * Payment Types): types are data, not a hardcoded enum, so a new type
 * (e.g. a future e-wallet provider) is one row, never a Treasury Core
 * rebuild. Seeded with `bank`/`cash`/`wallet`; more can be added via
 * `POST /treasury/account-types`.
 */
@Entity('treasury_account_types')
export class TreasuryAccountType {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  code!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'varchar', length: 16, default: 'active' })
  status!: 'active' | 'inactive';

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
