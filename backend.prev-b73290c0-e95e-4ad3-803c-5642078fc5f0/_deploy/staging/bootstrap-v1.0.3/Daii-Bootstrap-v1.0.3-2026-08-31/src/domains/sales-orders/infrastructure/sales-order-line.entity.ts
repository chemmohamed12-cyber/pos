import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** Price snapshot at order time — never a live join back to Product's current price (standard practice: prices can change after an order is placed). */
@Entity('sales_order_lines')
export class SalesOrderLine {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  salesOrderId!: string;

  @Column('uuid')
  productId!: string;

  @Column({ type: 'int' })
  quantity!: number;

  /** The EFFECTIVE price actually charged — the product's base price, or a Price List override when one applies (Gap G-3). Never trusted from the client. */
  @Column({ type: 'numeric', precision: 12, scale: 2 })
  unitPrice!: string;

  /**
   * Gap G-3 (planning/excel-mapping/EXCEL_BUSINESS_MAPPING_PACKAGE.md §4,
   * `انحراف السعر` — price deviation). The product's own base price
   * (`Product.unitPrice`) at order time, independent of any Price List
   * override — always present, so `unitPrice - listPrice` is a plain
   * subtraction the UI can compute directly, never a stored/denormalized
   * variance column (single-owner-of-state discipline, same as why
   * `SalesOrder` itself has no status column).
   */
  @Column({ type: 'numeric', precision: 12, scale: 2 })
  listPrice!: string;

  /** Which Price List (if any) supplied `unitPrice`'s override — null means unitPrice IS listPrice (no override applied). Audit/traceability only; never re-resolved after order creation. */
  @Column({ type: 'uuid', nullable: true })
  priceListId!: string | null;

  /**
   * REAL BUG FOUND LIVE (CTO directive, "PRIORITY 3 — CRITICAL PRICING
   * BUG"): a price-list override was silently invisible on screen — only
   * `listPrice` (the product's raw base price) and `priceListId` (just a
   * code) were ever shown, so a manager reviewing an order had no way to
   * see that an assigned Price List had quietly resolved a line to,
   * e.g., 8.00 against a 150.00 base price. Not a precedence bug —
   * `unitPrice`'s resolution (managerPrice > repPrice > this column) was
   * already correct — but the number this column represents was never
   * persisted or displayed on its own, so nobody could trace WHERE the
   * final price came from. Always populated (equals `listPrice` when no
   * Price List override applies), the exact value `SalesOrdersService.
   * createOrder` starts its rep/manager override chain from.
   */
  @Column({ type: 'numeric', precision: 12, scale: 2, nullable: true })
  priceListPrice!: string | null;

  /**
   * CTO instruction: three-tier line pricing — `listPrice` (above) is
   * the baseline; a rep may override it with `repPrice`; a sales
   * manager may override BOTH with `managerPrice`. Both stored (not
   * just whichever won) purely as a record of what was actually
   * entered — `unitPrice` above is always the one number that actually
   * governed the invoice, resolved server-side with precedence
   * managerPrice > repPrice > listPrice (see `SalesOrdersService.createOrder`).
   * `managerPrice` is honored only when the ACTUAL creating user holds
   * the sales_manager/admin role — never trusted from the client alone.
   */
  @Column({ type: 'numeric', precision: 12, scale: 2, nullable: true })
  repPrice!: string | null;

  @Column({ type: 'numeric', precision: 12, scale: 2, nullable: true })
  managerPrice!: string | null;

  /**
   * Gap G-4 (planning/excel-mapping/EXCEL_BUSINESS_MAPPING_PACKAGE.md §4,
   * `قيمه الخصم` — flat discount amount off the line's gross total, the
   * form evidenced in the company's real invoice ledger). Always
   * server-validated against the line's own gross total (never negative,
   * never more than 100% of it) — see `sales-orders.service.ts`.
   */
  @Column({ type: 'numeric', precision: 12, scale: 2, default: 0 })
  discountAmount!: string;

  /** Server-computed net total: (unitPrice × quantity) − discountAmount — never trusted from the client. */
  @Column({ type: 'numeric', precision: 14, scale: 2 })
  lineTotal!: string;
}
