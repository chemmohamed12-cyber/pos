import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { ReturnType } from '../domain/return-type';
import { ReturnOrigin } from '../domain/return-origin';

/** No status column — Process Engine (definitionKey='return_request') is the single source of truth, same pattern as every other workflow-driven entity in this codebase. */
@Entity('return_requests')
export class ReturnRequest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'varchar', length: 255 })
  salesOrderId!: string;

  /**
   * Returns Engine (CTO directive) — precisely WHICH line this return
   * applies to, not just productId+salesOrderId (ambiguous when an order
   * has the same product on two lines). Needed to read that line's own
   * historical unitPrice/discountAmount for a Return Credit's amount, and
   * to enforce "returned qty <= sold qty - previously returned qty"
   * against the correct line. Nullable only for rows created before this
   * column existed (none in this V1 dev environment, but the pattern this
   * codebase always follows for an additive column on an existing table).
   */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  salesOrderLineId!: string | null;

  @Column('uuid')
  productId!: string;

  @Column({ type: 'int' })
  quantity!: number;

  @Column('uuid')
  warehouseId!: string;

  @Column({ type: 'varchar', length: 255 })
  reason!: string;

  @Column('uuid')
  requestedByUserId!: string;

  /** Returns Engine (CTO directive §2) — exchange / value-credit / product-return; drives disposition destination and whether a ReturnCredit is created. Nullable only for pre-existing rows (none today). */
  @Column({ type: 'varchar', length: 20, nullable: true })
  returnType!: ReturnType | null;

  /** Human-facing document number (RET-YYYY-NNNNNN via the Numbering Engine), same discipline as SalesOrder.orderNumber. Nullable only for pre-existing rows (Postgres allows multiple NULLs under a unique index). */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32, nullable: true })
  returnNumber!: string | null;

  /**
   * Returns Engine Phase B — which of the three Return Engine paths this
   * request is: `customer` (Phase A, unchanged) or a pre-delivery custody
   * reversal (`shipping_company_custody` | `vehicle_custody`). Defaults to
   * `customer` so every Phase A row (and the existing `createReturnRequest`
   * codepath, unchanged) needs no migration backfill.
   */
  @Index()
  @Column({ type: 'varchar', length: 32, default: 'customer' })
  origin!: ReturnOrigin;

  /** Set only for a custody-origin request — the Shipment this return reverses custody on. Nullable for `customer`-origin rows, which have no shipment at all at request time. */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  shipmentId!: string | null;

  /** Set only for a custody-origin request — mirrors `shipmentId`, kept alongside it so a custody return's own custodian is queryable without re-reading the Shipment. */
  @Column({ type: 'varchar', length: 16, nullable: true })
  custodianType!: 'company' | 'vehicle' | null;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  custodianId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
