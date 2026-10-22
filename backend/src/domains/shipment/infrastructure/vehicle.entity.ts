import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * CTO directive ("SHIPPING & CUSTODY MANAGEMENT" §2/§3) — a Company
 * Vehicle is an Operational Custodian in its own right, same as a
 * Shipping Company: it may hold goods (in its auto-created Warehouse
 * sub-location, `warehouseId`) and money (its auto-created Custody
 * Treasury account, `custodyAccountId`) without ever owning either —
 * ownership stays with the company until actual Customer Delivery.
 * Lives inside the Shipment domain (not a separate one), same placement
 * precedent as `ShippingCompany`.
 */
@Entity('vehicles')
export class Vehicle {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  code!: string;

  @Column({ type: 'varchar', length: 32 })
  plateNumber!: string;

  @Column({ type: 'uuid', nullable: true })
  driverUserId!: string | null;

  /** A vehicle MAY belong to a third-party shipping company, or be purely in-house (null). */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  shippingCompanyId!: string | null;

  /** LEGACY free text (V1). Kept for compatibility and audited migration (org engine D-8): when `orgUnitId` is set this mirrors the branch NAME at the time of assignment; it is no longer the source of truth. */
  @Column({ type: 'varchar', length: 128, nullable: true })
  branch!: string | null;

  /** Org engine Stage 2 — the validated owning branch (`org_units`, type `branch`). `null` = unassigned legacy vehicle or a Company without branches. */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  orgUnitId!: string | null;

  /** Auto-created Operational Sub-location (CTO directive §4) — this vehicle's own goods-in-transit location. */
  @Column({ type: 'uuid', nullable: true })
  warehouseId!: string | null;

  /** Auto-created Custody Treasury account (CTO directive §6) — COD money currently in this vehicle/driver's hands, not yet remitted. */
  @Column({ type: 'uuid', nullable: true })
  custodyAccountId!: string | null;

  /** Where remitted money ultimately lands for this vehicle specifically — falls back to the owning company's settlement account when null (see `DeliveryService.remitCollection`). */
  @Column({ type: 'uuid', nullable: true })
  settlementAccountId!: string | null;

  /** Never deleted once it has operational history (CTO directive §2: "لا يتم حذف سيارة لها تاريخ عمليات؛ تستخدم Retired/Inactive"). */
  @Column({ type: 'varchar', length: 16, default: 'active' })
  status!: 'active' | 'retired';

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
