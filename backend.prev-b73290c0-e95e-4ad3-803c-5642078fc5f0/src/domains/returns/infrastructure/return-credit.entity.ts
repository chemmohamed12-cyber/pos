import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { ReturnCreditStatus } from '../domain/return-credit-status';

/**
 * Returns Engine (CTO directive §7 — Customer Account / ERP Readiness).
 * A lightweight ledger row, NOT a Treasury account — there is no
 * per-customer Treasury account concept in this codebase (confirmed by
 * exploration before building this), so a Return Credit lives in its own
 * table here rather than being shoehorned into Treasury (company cash/bank
 * only). `originalAmount`/`usedAmount`/`remainingAmount` mirror the
 * directive's own explicit field list; `CustomerAccountsService`
 * (reports domain) is the designed future integration point for a real
 * AR ledger, composing this table's data the same way it already composes
 * Sales Orders/Deposits/Collections — never a second parallel ledger.
 */
@Entity('return_credits')
export class ReturnCredit {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  returnRequestId!: string;

  @Index()
  @Column('uuid')
  customerId!: string;

  @Index()
  @Column({ type: 'varchar', length: 255 })
  originalSalesOrderId!: string;

  @Column({ type: 'numeric', precision: 14, scale: 2 })
  originalAmount!: string;

  @Column({ type: 'numeric', precision: 14, scale: 2, default: 0 })
  usedAmount!: string;

  @Column({ type: 'numeric', precision: 14, scale: 2 })
  remainingAmount!: string;

  @Column({ type: 'varchar', length: 16, default: 'active' })
  status!: ReturnCreditStatus;

  /** Set once the credit has been applied to a (draft) Sales Order — a credit is applied to exactly one order in this phase (disclosed scoping decision, see plan). */
  @Index()
  @Column({ type: 'varchar', length: 255, nullable: true })
  appliedToSalesOrderId!: string | null;

  /** Customer Financial Account / AR (CTO directive §7) — the parallel path: applied to an existing POSTED Invoice's AR instead of a draft order. Mutually informative with `appliedToSalesOrderId` (a credit is applied via exactly one of the two paths in this phase), never both. */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  appliedToInvoiceId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
