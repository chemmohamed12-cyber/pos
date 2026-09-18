import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type TaxCodeType = 'standard' | 'zero_rated' | 'exempt';
export const TAX_CODE_TYPES: readonly TaxCodeType[] = ['standard', 'zero_rated', 'exempt'];

/**
 * F01 scaffold, extended by F10 (ADR-043 D2). The Tax Engine's actual
 * calculation/inclusive-exclusive/exemption runtime behavior is
 * `TaxEngineService` (`tax-engine.service.ts`) — this entity stays a pure
 * data record. No `delete` — a tax code is deactivated (`isActive =
 * false`), never removed, once anything could reference it.
 *
 * F10 additions (all additive/nullable or safely defaulted — no existing
 * row's meaning changes): `type` is jurisdiction-neutral (never named
 * after an Egyptian category, per the Core/Localization boundary);
 * `jurisdictionCode` is nullable so a single-jurisdiction install pays no
 * cost; `effectiveFrom`/`effectiveTo` let a rate change over time without
 * losing history on already-posted invoices (F10 never re-derives a
 * historical tax amount from a "current" rate — Blueprint §3 D3).
 */
@Entity('accounting_tax_codes')
export class TaxCode {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  code!: string;

  @Column({ type: 'varchar', length: 128 })
  name!: string;

  @Column({ type: 'numeric', precision: 6, scale: 3 })
  rate!: string;

  @Column({ type: 'boolean', default: false })
  isInclusive!: boolean;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  /** Forward-reference placeholder for F02's Chart-of-Accounts posting account — not a real FK yet, F02 doesn't exist. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  accountMappingRef!: string | null;

  /** F10 (ADR-043 D2). Jurisdiction-neutral category — never named after any single country's VAT terminology. */
  @Column({ type: 'varchar', length: 16, default: 'standard' })
  type!: TaxCodeType;

  /** F10 (ADR-043 D2). E.g. 'EG' — nullable; a single-jurisdiction install need not populate it. */
  @Column({ type: 'varchar', length: 8, nullable: true })
  jurisdictionCode!: string | null;

  /** F10 (ADR-043 D2). Nullable effective-date window for a rate change over time; unset = always effective. */
  @Column({ type: 'date', nullable: true })
  effectiveFrom!: string | null;

  @Column({ type: 'date', nullable: true })
  effectiveTo!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
