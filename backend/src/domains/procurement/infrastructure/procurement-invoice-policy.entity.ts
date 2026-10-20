import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Phase C-1 (D2 / D5): the Company's supplier-invoice matching policy - ONE row per Company database (unique on the constant `singleton`). No row means the legacy behaviour:
 * the invoice posts straight from draft and a price variance is informational. With `approvalRequired` the invoice must go Draft -> Submitted -> Approved -> Posted and a price
 * variance beyond the limits holds it for an explicit, audited exception. Defaults are zero tolerance: `priceTolerancePct` 0 and no amount limit; when BOTH limits are set both must pass.
 */
@Entity('procurement_invoice_policies')
export class ProcurementInvoicePolicy {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'boolean', default: true })
  singleton!: boolean;

  @Column({ type: 'boolean', default: false })
  approvalRequired!: boolean;

  @Column({ type: 'numeric', precision: 7, scale: 4, default: 0 })
  priceTolerancePct!: string;

  @Column({ type: 'numeric', precision: 18, scale: 2, nullable: true })
  priceToleranceAmount!: string | null;

  /** 'both': a price difference in either direction counts; 'over_only': only an invoice price ABOVE the order price can exceed the limit. */
  @Column({ type: 'varchar', length: 12, default: 'both' })
  toleranceDirection!: 'both' | 'over_only';

  @Column({ type: 'uuid', nullable: true })
  updatedByUserId!: string | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;
}
