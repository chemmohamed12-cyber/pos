import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { SupplierStatus } from '../domain/supplier-status';

export type SupplierType = 'company' | 'individual';

/**
 * ADR-048 — the Procurement domain's aggregate root. A real supplier
 * master, not a free-text `supplierRef` (the pre-existing manual
 * `ap-adjustment.service.ts` flow keeps using free text for corrections —
 * this entity is what a real Purchase Order/Goods Receipt/Supplier
 * Invoice now reference by id).
 *
 * Foundation-gate audit (2026-09-17): no Legal Entity concept exists
 * (single-tenant by ADR-023 §1) and every operational subledger this
 * supplier eventually posts against (AP mirrors AR/Treasury) hardcodes
 * `'EGP'` — so this entity carries no currency/legal-entity column by
 * design, not by omission. `orgUnitId` follows the proven
 * `TreasuryAccount`/`JournalEntry` convention (ADR-031): nullable, `null`
 * = unscoped = visible to everyone, today's behaviour for every existing
 * installation, so multi-branch supplier scoping is a later additive
 * step, never a schema migration.
 */
@Entity('suppliers')
export class Supplier {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  code!: string;

  @Column({ type: 'varchar', length: 255 })
  legalName!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  tradingName!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'company' })
  supplierType!: SupplierType;

  @Column({ type: 'varchar', length: 64, nullable: true })
  taxRegistrationNumber!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  vatRegistrationNumber!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  commercialRegistrationNumber!: string | null;

  /** Supplier profile (gap matrix §5.3, migration 1790016300000) — nullable descriptive fields, never read by any ledger or document contract. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  email!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  website!: string | null;

  @Column({ type: 'varchar', length: 8, nullable: true })
  language!: 'ar' | 'en' | null;

  @Column({ type: 'text', nullable: true })
  internalNotes!: string | null;

  /** Days of credit before a Supplier Invoice is due (0 = due on receipt/cash terms). */
  @Column({ type: 'int', default: 0 })
  paymentTermsDays!: number;

  /** NUMERIC, base currency (EGP) — see class doc comment. NULL = no credit limit enforced. */
  @Column({ type: 'numeric', precision: 18, scale: 2, nullable: true })
  creditLimitBase!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'active' })
  status!: SupplierStatus;

  /** ADR-031 scope-derivation convention — see class doc comment. */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  orgUnitId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  createdByUserId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
