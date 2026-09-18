import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { WarehouseStatus } from '../domain/warehouse-status';

/** Warehouse ERP V1 / Phase 1 Integration (CTO directive §3) — Warehouse Master. */
@Entity('warehouses')
export class Warehouse {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  code!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  location!: string | null;

  /** The user accountable for this warehouse's operations — free-standing reference, not a scope grant (Scope for warehouse_worker/supervisor stays role-based, unchanged). */
  @Column({ type: 'uuid', nullable: true })
  responsibleUserId!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'active' })
  status!: WarehouseStatus;

  /**
   * CTO directive ("SHIPPING & CUSTODY MANAGEMENT" §4) — every Shipping
   * Company / Company Vehicle gets an auto-created Operational
   * Sub-location nested under a real warehouse, so custody transfers are
   * ordinary `WarehouseTransactionsService` transfers between two real
   * `Warehouse` rows — never a parallel stock system. `null` for every
   * top-level warehouse (unchanged, existing rows all stay `null`).
   */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  parentWarehouseId!: string | null;

  /**
   * 'main' = a real physical warehouse, created through the normal
   * Warehouses screen. 'operational' = an auto-created custody
   * sub-location (a Shipping Company or Company Vehicle) — never created
   * directly by a user, only via `ShipmentService.createShippingCompany`/
   * `createVehicle`. Purely a display/provenance discriminator; every
   * ledger operation (`recordMovement`, `getAvailable`, transfers) treats
   * every warehouse row identically regardless of `kind`.
   */
  @Column({ type: 'varchar', length: 16, default: 'main' })
  kind!: 'main' | 'operational';

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
