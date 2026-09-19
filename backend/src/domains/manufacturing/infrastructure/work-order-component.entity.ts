import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * ADR-061 §2/§3 — the BOM snapshot taken at `release` time. From that
 * point on, THIS row (not a live re-read of `BillOfMaterial`/
 * `BomComponent`) is authoritative for the Work Order's material
 * requirement and consumption, even if the BOM is edited afterward.
 */
@Entity('work_order_components')
@Index(['workOrderId', 'componentProductId'], { unique: true })
export class WorkOrderComponent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  workOrderId!: string;

  @Column('uuid')
  componentProductId!: string;

  /** `BOM.quantityPerUnit × quantityPlanned` at release time — frozen. */
  @Column({ type: 'int' })
  quantityRequired!: number;

  /** Running total, net of returns (an issue increases it, a return decreases it — §5). */
  @Column({ type: 'int', default: 0 })
  quantityIssued!: number;

  /**
   * Informational snapshot only (§3) — the real warehouse's current
   * moving-average cost for this component at release time. Never read
   * by any posting or reconciliation code path (D3 — no variance).
   */
  @Column({ type: 'numeric', precision: 20, scale: 4, nullable: true })
  unitCostAtRelease!: string | null;
}
