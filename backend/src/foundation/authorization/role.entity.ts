import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Authorization — Stage 2 build-order item 7.
 * Daii/architecture/DAII_PLATFORM_FOUNDATION_CONTRACT.md §3.
 *
 * Role is data, not a hardcoded enum in application code (blueprint §37:
 * canonical machine values, never business constants baked into logic).
 * Display labels belong to the Terminology Registry (item 16, not built
 * yet) — Role intentionally has no label/display field to avoid
 * pre-empting that ownership.
 */
@Entity('roles')
export class Role {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  key!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
