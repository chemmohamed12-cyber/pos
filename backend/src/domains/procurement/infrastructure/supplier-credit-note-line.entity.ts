import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** Phase D-2 - the net value credited against ONE line of the original supplier invoice (unique per note + invoice line). */
@Entity('supplier_credit_note_lines')
@Index(['supplierCreditNoteId', 'supplierInvoiceLineId'], { unique: true })
export class SupplierCreditNoteLine {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid')
  supplierCreditNoteId!: string;

  @Index()
  @Column('uuid')
  supplierInvoiceLineId!: string;

  @Column({ type: 'numeric', precision: 14, scale: 2 })
  amount!: string;
}
