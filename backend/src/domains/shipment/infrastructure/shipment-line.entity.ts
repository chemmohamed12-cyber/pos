import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Sales/Shipment/Returns workflow review (CTO directive, 2026-09-16).
 * A FROZEN snapshot of what was actually being shipped, taken once at
 * `ShipmentService.createShipment` time — closes the RBW finding that
 * shipment "contents" used to be re-derived live from `StockReservation`
 * rows at every read, which (a) has no price/lineTotal fields at all and
 * (b) can silently change after the shipment already left the warehouse
 * if the order's reservations are later adjusted. `quantity`/`unitPrice`
 * here are the source of truth for "what did this shipment actually
 * carry" from this point on — never re-derived from the order or from
 * inventory after creation. `salesOrderLineId` preserves provenance back
 * to the exact order line (never re-matched by product name), which is
 * what `ShipmentReturnLine` validates its return-quantity cap against.
 */
@Entity('shipment_lines')
export class ShipmentLine {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  shipmentId!: string;

  @Index()
  @Column('uuid')
  salesOrderLineId!: string;

  @Index()
  @Column('uuid')
  productId!: string;

  /** The quantity actually being shipped in THIS shipment — not the order line's ordered quantity (which may exceed this if back-ordered/split). */
  @Column({ type: 'int' })
  quantity!: number;

  /** Snapshotted from the order line's own historical `unitPrice` at shipment-creation time — never re-read live product/price-list prices (same discipline as `SalesOrderLine`/`SalesInvoiceLine`). */
  @Column({ type: 'numeric', precision: 12, scale: 2 })
  unitPrice!: string;

  @Column({ type: 'numeric', precision: 14, scale: 2 })
  lineTotal!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
