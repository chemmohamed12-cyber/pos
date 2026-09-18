import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * Terminology Registry — Stage 2 build-order item 16.
 * Daii/architecture/DAII_I18N_TERMINOLOGY_ARCHITECTURE.md, ADR-011.
 *
 * Confirmed gap in every Stage 0 source, including the most mature one
 * (xnexus-website's i18n admits raw status enums are deliberately left
 * untranslated rather than registry-mapped — Daii/_source-audits/xnexus-website/
 * §6) — full build, no code to extract. `code` is the immutable canonical
 * value (blueprint §37); `ar`/`en` may be revised without changing `code`.
 */
@Entity('terminology_entries')
export class TerminologyEntry {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 128 })
  code!: string;

  @Column({ type: 'varchar', length: 64 })
  category!: string;

  @Column({ type: 'varchar', length: 255 })
  ar!: string;

  @Column({ type: 'varchar', length: 255 })
  en!: string;

  @Column({ type: 'int', default: 1 })
  version!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
