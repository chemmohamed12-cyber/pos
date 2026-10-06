import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Sales/Shipment/Returns workflow review (CTO directive, 2026-09-16).
 * Per-product return quantity for a `ShipmentReturn` — real FK to the
 * frozen `ShipmentLine` snapshot (never the live/re-derived reservation
 * content), which is what makes "returnQty <= shipped qty" an enforceable
 * DB-backed check instead of the ordered-quantity proxy `ReturnRequest`
 * uses today. `returnPrice` is independently entered/approved per the
 * CTO's ratified pricing decision — never copied from the shipment
 * line's `unitPrice` automatically.
 */
@Entity('shipment_return_lines')
export class ShipmentReturnLine {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  shipmentReturnId!: string;

  @Index()
  @Column('uuid')
  shipmentLineId!: string;

  @Column('uuid')
  productId!: string;

  @Column({ type: 'int' })
  returnQuantity!: number;

  /** Authoritative for any future financial credit — the return's OWN approved price, independent of the shipment line's historical `unitPrice` (CTO ratification, 2026-09-16). */
  @Column({ type: 'numeric', precision: 12, scale: 2 })
  returnPrice!: string;

  @Column({ type: 'numeric', precision: 14, scale: 2 })
  lineTotal!: string;
  /** D4 — the ORIGINAL unit cost the returned stock re-entered at (null before D4 / when no financial effect). */
  @Column({ type: 'numeric', precision: 18, scale: 4, nullable: true })
  unitCostBase!: string | null;

  @Column({ type: 'numeric', precision: 18, scale: 4, nullable: true })
  costTotalBase!: string | null;

  /** D4 — Revenue part credited, derived from the ORIGINAL invoice value (never from `returnPrice`). */
  @Column({ type: 'numeric', precision: 14, scale: 2, nullable: true })
  creditNetBase!: string | null;

  /** D4 — tax part reversed, pro-rata to the original invoice tax. */
  @Column({ type: 'numeric', precision: 14, scale: 2, nullable: true })
  creditTaxBase!: string | null;

  /** D4 — the original posted invoice this line's Revenue/AR/tax reverses (null ⇒ the sale created no Revenue/AR). */
  @Column({ type: 'uuid', nullable: true })
  creditInvoiceId!: string | null;
}
