import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { TreasuryAccountStatus } from '../domain/treasury-account-status';

/**
 * A real, standalone Financial Core account — never a single implicit
 * "safe" bolted onto Sales Orders. Multiple accounts (cash drawers, bank
 * accounts) from day one; balance is never stored here — it is always
 * computed by summing `TreasuryTransaction` rows for this account (see
 * `TreasuryService.getAccountBalance`), the same "ledger, not a balance
 * field" discipline the Warehouse domain already uses for stock.
 */
@Entity('treasury_accounts')
export class TreasuryAccount {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  code!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  /** References TreasuryAccountType.id — the Account Type -> Accounts hierarchy (CTO directive: types must be addable without rebuilding Treasury Core, so this is data, not an enum). */
  @Index()
  @Column('uuid')
  accountTypeId!: string;

  @Column({ type: 'varchar', length: 16, default: 'active' })
  status!: TreasuryAccountStatus;

  /**
   * ADR-031 (Scope Derivation, closes AUDIT-SEC-03 for Treasury). Null =
   * no branch assigned = accessible to everyone — every existing
   * installation's current, unchanged behaviour. Only takes effect once a
   * customer actually builds a multi-branch org tree and assigns accounts
   * to units.
   */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  orgUnitId!: string | null;

  /**
   * F06 / F06-H1 (ADR-038 D7). The General Ledger account (`GLAccount.code`,
   * a `bank` control account) this Treasury account posts to. NULL =
   * unmapped = no `treasury.*` GL event is published for this account's
   * movements, and F06's Cash/Bank↔GL reconciliation reports it as
   * "not GL-mapped". Set/cleared via `POST /treasury/accounts/:id/gl-mapping`.
   */
  @Index()
  @Column({ type: 'varchar', length: 32, nullable: true })
  glAccountCode!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
