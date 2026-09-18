import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { CustomerStatus } from '../domain/customer-status';
import { OrderWorkflowPolicy } from '../domain/order-workflow-policy';

/**
 * Owned by CRM only (DAII_DOMAIN_BOUNDARIES.md §2's Cross-Domain Rule) —
 * no other domain writes this table directly. `code` is issued by the
 * Numbering Engine (item 17), never generated ad hoc here.
 */
@Entity('customers')
export class Customer {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  code!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'varchar', length: 32, nullable: true })
  phone!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status!: CustomerStatus;

  @Column({ type: 'varchar', length: 64, nullable: true })
  classification!: string | null;

  /**
   * Per-customer Sales Order workflow switch (Gap G-1, CTO handover
   * directive §6) — 'standard' preserves the existing mandatory
   * supervisor+manager+deposit chain; 'open_account' is the trusted-
   * customer fast path. Defaults to 'standard' so no existing customer's
   * behavior changes until explicitly opted in.
   */
  @Column({ type: 'varchar', length: 16, default: 'standard' })
  orderWorkflowPolicy!: OrderWorkflowPolicy;

  /**
   * Gap G-3 (planning/excel-mapping/EXCEL_BUSINESS_MAPPING_PACKAGE.md) —
   * which Commerce `PriceList` this customer's Sales Order lines resolve
   * prices against. Null (the default) means "no override — use each
   * product's own base `unitPrice`", so every existing customer's pricing
   * is unchanged until explicitly assigned one. Per-customer only, not
   * per-customer-group: Daii has no structured customer-group entity yet
   * (`classification` is free text), and building one is out of this
   * gap's scope (CTO handover directive §14: don't over-engineer future
   * pricing scenarios).
   */
  @Column({ type: 'uuid', nullable: true })
  priceListId!: string | null;

  /**
   * Gap G-5 (planning/excel-mapping/EXCEL_BUSINESS_MAPPING_PACKAGE.md §4) —
   * the real CRM master sheet's own fields (`احمد/شيت تحليل العملاء
   * الرئيسي الجديد.xlsx`, sheet `بيانات العملاء`), adopted directly as
   * Daii's Customer import/export format per the CTO's explicit
   * instruction, rather than a generic/invented field set. All nullable —
   * every existing customer is unaffected until re-imported/edited.
   */
  @Column({ type: 'varchar', length: 255, nullable: true })
  managerName!: string | null; // اسم المدير

  @Column({ type: 'varchar', length: 500, nullable: true })
  address!: string | null; // العنوان

  @Column({ type: 'varchar', length: 128, nullable: true })
  governorate!: string | null; // المحافظه

  @Column({ type: 'varchar', length: 32, nullable: true })
  whatsappPhone!: string | null; // رقم التليفون الواتس

  @Column({ type: 'varchar', length: 128, nullable: true })
  contactMethod!: string | null; // طريقه التواصل

  @Column({ type: 'varchar', length: 255, nullable: true })
  responsivenessLevel!: string | null; // مدي استجابه العميل للرد علينا

  @Column({ type: 'text', nullable: true })
  disinterestNotes!: string | null; // ملاحظات ع اسباب غير مهتم

  @Column({ type: 'varchar', length: 255, nullable: true })
  priceSatisfactionLevel!: string | null; // مدي رضا العميل عن الاسعار

  @Column({ type: 'varchar', length: 255, nullable: true })
  topBrand!: string | null; // البراند اكثر طلبا

  @Column({ type: 'varchar', length: 255, nullable: true })
  midBrand!: string | null; // البراند متوسط طلبا

  @Column({ type: 'varchar', length: 255, nullable: true })
  lowBrand!: string | null; // البراند اقل طلبا

  @Column({ type: 'varchar', length: 128, nullable: true })
  shippingMethodPreference!: string | null; // طريقه الشحن

  @Column({ type: 'varchar', length: 500, nullable: true })
  locationUrl!: string | null; // اللوكيشن

  /**
   * Customer Financial Account / AR (CTO directive §10 — Credit Control).
   * Null means "no limit set" — `CustomerLedgerService.getCreditSummary`
   * degrades `availableCredit` to null in that case, never a silent 0.
   * Expose-only in this phase (disclosed scoping decision, see plan) —
   * not yet enforced as a hard gate on order creation.
   */
  @Column({ type: 'numeric', precision: 14, scale: 2, nullable: true })
  creditLimit!: string | null;

  /** Drives `SalesInvoice.dueDate` at draft-creation time (`InvoiceService.createDraftInvoice`) — null means no due date is set for this customer's invoices. */
  @Column({ type: 'int', nullable: true })
  paymentTermsDays!: number | null;

  @Column({ type: 'varchar', length: 16, default: 'credit' })
  accountType!: 'cash' | 'credit';

  @Column({ type: 'varchar', length: 16, default: 'active' })
  financialStatus!: 'active' | 'on_hold' | 'suspended';

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
