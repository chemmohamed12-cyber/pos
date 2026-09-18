import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

export type AuditResult = 'success' | 'failure' | 'denied';

/**
 * Append-only by convention here; DB-role-level REVOKE UPDATE/DELETE is
 * an infrastructure/ops concern for Stage 2's deployment work, not this
 * entity definition (DAII_DATA_ARCHITECTURE.md §5).
 */
@Entity('audit_records')
export class AuditRecord {
  @PrimaryGeneratedColumn()
  seq!: number;

  @Column({ type: 'timestamptz' })
  timestamp!: Date;

  @Column({ type: 'uuid', nullable: true })
  actorUserId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  organizationId!: string | null;

  @Column({ type: 'varchar', length: 128 })
  action!: string;

  @Column({ type: 'varchar', length: 128 })
  resource!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  resourceId!: string | null;

  @Column({ type: 'varchar', length: 16 })
  result!: AuditResult;

  @Column({ type: 'varchar', length: 64, nullable: true })
  correlationId!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  before!: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  after!: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 64 })
  prevHash!: string;

  @Column({ type: 'varchar', length: 64 })
  hash!: string;
}
