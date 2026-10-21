import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Phase D-1 - one returned quantity of one goods-receipt line. `receiptUnitCostBase` is the receipt's own cost (a snapshot, the audit reference); `exitValueBase` is the book value that actually
 * left the inventory (moving average at posting time, E3) and `differenceBase` = receipt value - exit value, both filled in only when the return is posted.
 */
@Entity('purchase_return_lines')
export class PurchaseReturnLine {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  purchaseReturnId!: string;

  @Index()
  @Column('uuid')
  goodsReceiptLineId!: string;

  @Column('uuid')
  purchaseOrderLineId!: string;

  @Column('uuid')
  productId!: string;

  @Column({ type: 'numeric', precision: 18, scale: 3 })
  quantity!: string;

  @Column({ type: 'numeric', precision: 18, scale: 4 })
  receiptUnitCostBase!: string;

  @Column({ type: 'numeric', precision: 20, scale: 4, nullable: true })
  exitValueBase!: string | null;

  @Column({ type: 'numeric', precision: 20, scale: 4, nullable: true })
  differenceBase!: string | null;

  /**
   * Phase D-3 (policy 2026-10-21): set when the line physically returns INVOICED goods - the invoice line they were billed on. The return parks the book value (`exitValueBase`) in the
   * clearing account and never touches Accounts payable; `settledByCreditNoteId` is the credit note that later settled it (NULL = still pending the supplier's credit).
   */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  supplierInvoiceLineId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  settledByCreditNoteId!: string | null;
}
