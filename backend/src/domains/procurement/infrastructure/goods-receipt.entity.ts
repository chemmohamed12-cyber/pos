import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * ADR-048 — the ONE controlled bridge from Procurement into Inventory:
 * `GoodsReceiptService.post` is the only Procurement code path that calls
 * `InventoryService.recordMovement` (never a raw warehouse-table write,
 * per the CTO directive's explicit rule). Posting is a single atomic
 * transaction: `receipt` movements for every line + `PurchaseOrderLine
 * .quantityReceived` increments + the Purchase Order's derived
 * partially_received/received transition, or none of it. No draft state —
 * a Goods Receipt is created already-posted (matching how a Warehouse
 * Receipt transaction commits its movements immediately); the
 * traceability the CTO asked for comes from `referenceType`/`referenceId`
 * on each `StockMovement`, not from a separate approval step here.
 */
@Entity('goods_receipts')
export class GoodsReceipt {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  grNumber!: string;

  @Index()
  @Column('uuid')
  purchaseOrderId!: string;

  @Index()
  @Column('uuid')
  supplierId!: string;

  @Index()
  @Column('uuid')
  warehouseId!: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  notes!: string | null;

  @Column({ type: 'uuid', nullable: true })
  receivedByUserId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
