import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { GLAccountType, NormalBalance } from '../domain/gl-account-type';
import { AccountCurrencyMode, ControlFunction } from '../domain/control-function';

/**
 * F02 — Chart of Accounts (Blueprint §3.1, ADR-034). One General Ledger
 * account. Surrogate `id` (not `code`) is the identity so an account can
 * be re-coded without breaking F03's journal-line FKs (ADR-034 D2).
 *
 * `normalBalance` is stored but SERVICE-OWNED — always recomputed from
 * `accountType` + `isContra` by `GLAccountService`, never accepted from a
 * client (ADR-034 D3).
 *
 * No `ProcessDefinition` lifecycle — an account is `isActive: true|false`,
 * the same flat toggle `Currency` and `TaxCode` use (Blueprint §2). No
 * `status` column, no state machine.
 */
@Entity('accounting_gl_accounts')
export class GLAccount {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  code!: string;

  @Column({ type: 'varchar', length: 160 })
  name!: string;

  /**
   * Global UX Audit directive (2026-09-12) — the app defaults to Arabic,
   * but `name` alone can't carry a second language, so every
   * IFRS-SME-imported and manually-created account rendered in English
   * regardless of the active language. Nullable: an account with no
   * Arabic name falls back to `name` at render time (same Arabic-first
   * fallback convention `TerminologyService.resolve` already uses),
   * never a blank/raw-code display.
   */
  @Column({ type: 'varchar', length: 160, nullable: true })
  nameAr!: string | null;

  @Column({ type: 'varchar', length: 16 })
  accountType!: GLAccountType;

  /** Derived from `accountType` + `isContra` (ADR-034 D3). Denormalised for F03/F14 query performance. */
  @Column({ type: 'varchar', length: 6 })
  normalBalance!: NormalBalance;

  @Column({ type: 'boolean', default: false })
  isContra!: boolean;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  parentAccountId!: string | null;

  /** `true` = a leaf account F03 may post journal lines to. `false` = a header/summary node. An account with children is forced `false`. */
  @Column({ type: 'boolean', default: true })
  isPostable!: boolean;

  /** `null` = ordinary account. Non-null = a subledger-managed control account (Blueprint §3.1). */
  @Column({ type: 'varchar', length: 24, nullable: true })
  controlFunction!: ControlFunction | null;

  @Column({ type: 'varchar', length: 16, default: 'functional_only' })
  currencyMode!: AccountCurrencyMode;

  /** Required iff `currencyMode = 'single_foreign'`; null otherwise. FK → `accounting_currencies.code`. */
  @Column({ type: 'varchar', length: 3, nullable: true })
  restrictCurrencyCode!: string | null;

  /** `false` = only system-generated postings (F03+) may touch it. Forced `false` when `controlFunction` is set. */
  @Column({ type: 'boolean', default: true })
  allowManualJournal!: boolean;

  /** Scope (ADR-031). `null` = whole-installation account. */
  @Column({ type: 'uuid', nullable: true })
  orgUnitId!: string | null;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ type: 'varchar', length: 512, nullable: true })
  description!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
