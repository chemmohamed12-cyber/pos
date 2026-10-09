import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Database Registry — Multi-Company Phase 3 V7, Area 3. Literal V7 shape:
 * `companyId → {host, port, database name, status}`. Deliberately NO
 * credential column here — passwords/credentials live in the separate
 * `DatabaseCredential` table (never inline on this row, per V7's explicit
 * requirement). `status`'s allowed values are NOT defined here — same
 * deferral pattern as Area 1's own `status` column, most likely Area 4
 * (Database Provisioning)'s concern since that Area is what actually
 * drives a registered database through its lifecycle.
 */
@Entity('database_registries')
export class DatabaseRegistry {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** FK to `companies.id`. One registry row per Company — V7's `companyId → {...}` notation reads as a functional (1:1) mapping. */
  @Index({ unique: true })
  @Column({ type: 'uuid' })
  companyId!: string;

  @Column({ type: 'varchar', length: 255 })
  host!: string;

  @Column({ type: 'int' })
  port!: number;

  /** One physical database per Company — enforced by the unique index `UQ_database_registries_databaseName` (migration 1790011000000). */
  @Index('UQ_database_registries_databaseName', { unique: true })
  @Column({ type: 'varchar', length: 63 })
  databaseName!: string;

  @Column({ type: 'varchar', length: 16 })
  status!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
