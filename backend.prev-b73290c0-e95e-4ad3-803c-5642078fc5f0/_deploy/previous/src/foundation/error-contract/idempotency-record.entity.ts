import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Idempotency — Stage 2 build-order item 14.
 * Daii/architecture/DAII_FOUNDATION_CROSSCUTTING_SPEC.md §5.
 *
 * `scope` disambiguates the same client-supplied key across different
 * operations (e.g. "POST /sales-orders" vs "POST /deposits") so a key
 * collision in one operation can never replay a cached result from an
 * unrelated one.
 */
@Entity('idempotency_records')
@Index(['scope', 'key'], { unique: true })
export class IdempotencyRecord {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 255 })
  scope!: string;

  @Column({ type: 'varchar', length: 255 })
  key!: string;

  @Column({ type: 'int' })
  statusCode!: number;

  @Column({ type: 'jsonb' })
  responseBody!: unknown;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
