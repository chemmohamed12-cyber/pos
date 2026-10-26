import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * Customer Financial Account / Invoice / AR (CTO directive) — no status
 * column, same "single owner of state" discipline as `SalesOrder`/
 * `ReturnRequest`/`Shipment`: the Process Engine (`sales_invoice_lifecycle`)
 * is the single source of truth. Part of the Sales Order → Delivery →
 * Invoice → AR → Payment → Treasury chain, not a separate silo —
 * `salesOrderId` links back, lines snapshot the order's own historical
 * prices (never re-read live product prices), same discipline Returns
 * Phase A already established for `ReturnCredit`.
 */
@Entity('sales_invoices')
export class SalesInvoice {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  invoiceNumber!: string;

  @Index()
  @Column('uuid')
  customerId!: string;

  @Index()
  @Column('uuid')
  salesOrderId!: string;

  @Column({ type: 'uuid', nullable: true })
  shipmentId!: string | null;

  @Column({ type: 'numeric', precision: 14, scale: 2 })
  subtotal!: string;

  @Column({ type: 'numeric', precision: 14, scale: 2, default: 0 })
  discountAmount!: string;

  @Column({ type: 'numeric', precision: 14, scale: 2, default: 0 })
  taxAmount!: string;

  /**
   * F10-H3 (ADR-043 D1/D3, Blueprint §0 amendment). Invoice-level (V1) tax
   * code — resolved and frozen at `createDraftInvoice` time (explicit, or
   * `accounting.default_tax_code` config, or null = no tax), never
   * re-resolved at post/void time except to look up the CURRENT
   * `accountMappingRef` for GL posting (Blueprint §3 D5 — an account-code
   * lookup, not a tax-amount recalculation). No FK — cross-domain plain
   * uuid, same convention as `customerId`/`salesOrderId` above.
   * `sales_invoice_lines` carries no tax reference (DEFERRED).
   */
  @Column({ type: 'uuid', nullable: true })
  taxCodeId!: string | null;

  /**
   * `totalAmount` keeps its pre-existing meaning UNCHANGED by F10 (CTO
   * ruling, 2026-09-11): net of discount, tax-EXCLUSIVE — the same value
   * it held before any real tax existed. F10 does not add `taxAmount`
   * into it. This is an explicit, disclosed `customer-finance` dependency
   * (Blueprint §8) for a future phase to resolve, not something F10
   * changes unilaterally.
   */
  @Column({ type: 'numeric', precision: 14, scale: 2 })
  totalAmount!: string;

  /** Resolved from `Customer.paymentTermsDays` at draft-creation time — null if the customer has no payment terms set. */
  @Column({ type: 'timestamptz', nullable: true })
  dueDate!: Date | null;

  @Column('uuid')
  createdByUserId!: string;

  @Column({ type: 'uuid', nullable: true })
  postedByUserId!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  voidedReason!: string | null;

  /**
   * F04 / handoff F04-H1 (ADR-036 D4, E-02). Generic external-document
   * reference — an e-invoice / e-receipt / imported-doc identity. **Not**
   * ETA-named: an Egypt ETA adapter maps `{ etaUuid, etaLongId,
   * documentType, submissionStatus }` onto these fields; a different
   * external system needs no migration. The GL never carries these — the
   * chain is `JournalEntry → FinancialEvent → SalesInvoice → externalDocument*`.
   */
  @Column({ type: 'varchar', length: 32, nullable: true })
  externalDocumentType!: string | null;

  @Index()
  @Column({ type: 'varchar', length: 128, nullable: true })
  externalDocumentId!: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  externalDocumentStatus!: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  externalDocumentSecondaryId!: string | null;

  /** Org engine Stage 5 — the branch this document belongs to, stamped by the server at creation (from the owning warehouse / the parent document). `null` = legacy / unassigned. Never rewritten afterwards. */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  branchOrgUnitId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
