import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Procurement invoicing redesign, phase B (2026-10-20): how a supplier payment is spread over supplier invoices. One payment may settle several invoices (one row each); one invoice may be settled
 * by several payments. For every payment, the allocations add up to the payment amount; `supplier_payments.supplierInvoiceId` stays as the primary invoice for history and old screens.
 */
@Entity('supplier_payment_allocations')
@Index('UQ_supplier_payment_allocations_pair', ['supplierPaymentId', 'supplierInvoiceId'], { unique: true })
export class SupplierPaymentAllocation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  supplierPaymentId!: string;

  @Index()
  @Column('uuid')
  supplierInvoiceId!: string;

  @Column({ type: 'numeric', precision: 14, scale: 2 })
  amount!: string;

  /** Org engine WP-A (decision D-A, option B) — the branch of the invoice this allocation settles, stamped when the payment is recorded; `null` = unassigned / recorded before the decision. The payment reversal mirrors THIS value. */
  @Column({ type: 'uuid', nullable: true })
  orgUnitId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
