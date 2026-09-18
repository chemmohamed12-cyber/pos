import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Sales/Shipment/Returns workflow review (CTO directive, 2026-09-16).
 * A NEW, additive aggregate — deliberately separate from `ReturnRequest`
 * (which stays untouched for pre-delivery custody reversal). Represents
 * a return of a SHIPMENT that already went out (post-delivery or
 * in-transit), always bound to exactly one existing `Shipment` — never
 * created standalone (CTO directive §3). No status column — Process
 * Engine (`shipment_return`) is the single source of truth, same
 * discipline as every other document in this codebase.
 */
@Entity('shipment_returns')
export class ShipmentReturn {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  returnNumber!: string;

  @Index()
  @Column('uuid')
  shipmentId!: string;

  /** Denormalized for cheap list-screen reads (customer name is a required list-screen field, CTO directive §2) — resolved via `shipmentId` → order → customer at creation time, re-verified (never trusted) on every write. Not a source of truth: `shipmentId` is. */
  @Index()
  @Column('uuid')
  customerId!: string;

  @Index()
  @Column('uuid')
  salesOrderId!: string;

  /** User's explicit intent, validated server-side: 'full' requires every line's returnQuantity to equal its full remaining-returnable shipped quantity; 'partial' just enforces the normal per-line cap. Never inferred silently. */
  @Column({ type: 'varchar', length: 8 })
  returnMode!: 'full' | 'partial';

  @Column({ type: 'varchar', length: 255, nullable: true })
  reason!: string | null;

  @Column('uuid')
  requestedByUserId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
