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
}
