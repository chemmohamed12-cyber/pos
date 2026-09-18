import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * CTO directive ("مرحلة الشحن يجب أن تكون مبنية من البداية لدعم أكثر من
 * شركة شحن" — the shipping stage must support more than one shipping
 * company from the start). Deliberately minimal for V1 — the CTO's own
 * directive flags per-company policies/label templates/account types as
 * "لاحقًا نحتاج" (needed later); this is just enough to attach a real
 * company identity to a Shipment and to a Treasury account for
 * settlement, without inventing configuration screens nobody asked for
 * yet. Lives inside the Shipment domain (not a separate one), same
 * placement precedent as `TrackingEvent`/the waybill number — both
 * already live here rather than in a dedicated "Waybill" domain that was
 * never actually built (see DAII_DOMAIN_BOUNDARIES.md §9, disclosed as
 * aspirational-not-built).
 */
@Entity('shipping_companies')
export class ShippingCompany {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  code!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'varchar', length: 32, nullable: true })
  contactPhone!: string | null;

  /** CTO directive ("SHIPPING & CUSTODY MANAGEMENT" §1) — the base field list beyond code/name/contact/status. */
  @Column({ type: 'varchar', length: 500, nullable: true })
  address!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  responsiblePerson!: string | null;

  /**
   * Auto-created Operational Sub-location (CTO directive §4) — every
   * shipment routed through this company transfers stock here (via the
   * existing `WarehouseTransactionsService`, never a parallel ledger).
   */
  @Column({ type: 'uuid', nullable: true })
  warehouseId!: string | null;

  /**
   * Auto-created Custody Treasury account (CTO directive §6) — COD money
   * currently in this company's hands, not yet remitted. NOT a normal
   * cash account: `Collection` posts into it at collection time;
   * `DeliveryService.remitCollection` moves money OUT of it into
   * `treasuryAccountId` via `TreasuryService.transfer`, never a bare
   * cash-in. Distinct from `treasuryAccountId` below (the real
   * bank/cash account remitted money ultimately lands in).
   */
  @Column({ type: 'uuid', nullable: true })
  custodyAccountId!: string | null;

  /**
   * Which Treasury account this company's remitted COD cash lands in —
   * the concrete link the CTO's directive asks for ("Shipping Company
   * Settlement → Treasury/Financial Posting"). Nullable: a company can
   * exist before its treasury account is provisioned; remittance is
   * simply blocked until one is set (enforced in
   * `DeliveryService.remitCollection`).
   */
  @Column({ type: 'uuid', nullable: true })
  treasuryAccountId!: string | null;

  /** Never deleted once it has operational history (CTO directive §1: "لا يتم الحذف الفعلي لشركة لها عمليات سابقة؛ تستخدم Deactivate"). */
  @Column({ type: 'varchar', length: 16, default: 'active' })
  status!: 'active' | 'inactive';

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
