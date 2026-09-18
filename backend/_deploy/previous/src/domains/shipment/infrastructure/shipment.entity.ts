import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** No status column, same as SalesOrder and the Fulfillment tasks — Process Engine is the single source of truth. */
@Entity('shipments')
export class Shipment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'varchar', length: 255 })
  fulfillmentOrderId!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  waybillNumber!: string;

  @Column({ type: 'uuid', nullable: true })
  driverUserId!: string | null;

  /**
   * CTO directive — third-party shipping company handling this shipment,
   * independent of `driverUserId` (an in-house driver delivery has no
   * shipping company; a third-party one may still have no
   * `driverUserId` since the company's own courier isn't a Daii user).
   * Nullable: not every shipment goes through a company.
   */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  shippingCompanyId!: string | null;

  /** CTO directive ("SHIPPING & CUSTODY MANAGEMENT" §2) — the specific Company Vehicle carrying this shipment, if any. Independent of `shippingCompanyId` (an in-house vehicle has no company); custody transfer at pickup prefers the vehicle's sub-location over the company's when both are set. */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  vehicleId!: string | null;

  /**
   * CTO directive — expected Cash-On-Delivery amount to collect from the
   * customer, if any. Distinct from `Collection.amount` (Delivery
   * domain) which records what was ACTUALLY collected — comparing the
   * two is how a shortfall/overage gets caught, not by assuming they
   * always match.
   */
  @Column({ type: 'numeric', precision: 14, scale: 2, nullable: true })
  codAmount!: string | null;

  /**
   * RSH Shipping Order number (CTO directive §3) — `RSH-YYYY-NNNNNN`,
   * generated via the Numbering Engine at creation, distinct from
   * `waybillNumber` above (the carrier's own tracking number, a different
   * document series). Nullable: existing pre-directive shipments degrade
   * to null/—, same precedent as every other additive column here.
   */
  @Column({ type: 'varchar', length: 32, nullable: true })
  rshNumber!: string | null;

  /**
   * Direct link to the Sales Order (CTO directive §3: "مرتبط مباشرة
   * بالـSales Order") — resolved once at creation via the Fulfillment
   * Order chain, stored here so a Shipment's own Sales Order never
   * requires a join through `fulfillmentOrderId` to answer.
   */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  salesOrderId!: string | null;

  /** Snapshotted at creation (immutable once assigned) — avoids a live cross-domain read on every list/detail fetch. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  salesOrderNumber!: string | null;

  /**
   * The Sales Order's responsible sales rep, snapshotted at creation
   * (same "avoid a live cross-domain read" rationale as `salesOrderNumber`
   * above) — closes a gap where a shipment carried no traceable link back
   * to the rep who owns the underlying sale, once it left the Sales Order
   * screen. Nullable: existing pre-existing shipments degrade to null/—,
   * same precedent as every other additive column here.
   */
  @Column({ type: 'uuid', nullable: true })
  salesRepUserId!: string | null;

  /**
   * CTO directive ("Shipping Company waybill-required flow") — the
   * SHIPPING COMPANY's own physical waybill/AWB number, printed on the
   * document THEY hand over when they physically receive the package.
   * Distinct from `waybillNumber` above (Daii's own internal
   * `WB-YYYY-NNNNNN` reference, issued at shipment creation, before any
   * physical handover has happened) and from `rshNumber` (the Shipping
   * Order's own identity). Required, together with
   * `waybillImageMediaAssetId` below, before `ShipmentService.
   * transitionShipment` allows `pickup` on a shipment routed through a
   * `shippingCompanyId` — enforced there, never just a client-side hint.
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  carrierWaybillNumber!: string | null;

  /**
   * A photo/scan of the physical waybill document, via the existing
   * generic Media foundation (`MediaService.upload` /
   * `POST /media/upload`, the same one Deposit's receipt-evidence upload
   * already uses) — never a bespoke upload path or file storage of its
   * own.
   */
  @Column({ type: 'uuid', nullable: true })
  waybillImageMediaAssetId!: string | null;

  /**
   * Shipping Screen Redesign directive §6 — the phone number of the
   * shipping company's OWN representative who physically received this
   * shipment (distinct from the company's general contact info on
   * `ShippingCompany` itself — this is per-handover, "who exactly took
   * it this time"). Captured alongside `carrierWaybillNumber`/
   * `waybillImageMediaAssetId` but, per the directive's own explicit
   * blocking list (§6: "لا يسمح النظام... بدون: Waybill Number, Waybill
   * Image" — only those two), NOT part of the `pickup` gate itself.
   */
  @Column({ type: 'varchar', length: 32, nullable: true })
  carrierContactPhone!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
