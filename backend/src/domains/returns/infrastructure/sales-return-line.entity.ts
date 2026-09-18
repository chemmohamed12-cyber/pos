import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Sales/Shipment/Returns workflow review (CTO directive, 2026-09-16).
 * Per-line provenance for a `SalesReturn` — `sourceSalesOrderId` +
 * `sourceSalesOrderLineId` are NOT NULL and independent of the header's
 * `salesOrderId` (which may be null in "All Orders" mode): this is what
 * lets one `SalesReturn` legitimately span multiple different source
 * Orders (CTO directive §10) while every line still traces back to the
 * real sale it came from — never lost, never assumed to be "the" order.
 * `returnPrice` is the return's own approved price (CTO ratification:
 * authoritative for any GL credit, independent of the original sale's
 * historical `originalUnitPrice`, which is kept here only for display/
 * audit comparison, never as the calculation input).
 */
@Entity('sales_return_lines')
export class SalesReturnLine {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  salesReturnId!: string;

  @Index()
  @Column('uuid')
  sourceSalesOrderId!: string;

  @Index()
  @Column('uuid')
  sourceSalesOrderLineId!: string;

  @Column('uuid')
  productId!: string;

  @Column({ type: 'int' })
  returnQuantity!: number;

  /** The original sale's historical unit price, kept for audit/display comparison only — never the GL calculation input (CTO ratification, 2026-09-16). */
  @Column({ type: 'numeric', precision: 12, scale: 2 })
  originalUnitPrice!: string;

  /** Independently entered/approved return price — authoritative for any financial credit. */
  @Column({ type: 'numeric', precision: 12, scale: 2 })
  returnPrice!: string;

  @Column({ type: 'numeric', precision: 14, scale: 2 })
  lineTotal!: string;
}
