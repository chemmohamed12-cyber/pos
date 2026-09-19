import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * ADR-065 §6 — `fileHash` (SHA-256 of the uploaded buffer) is the
 * idempotency key: a byte-identical re-upload is rejected before any row
 * is touched, mirroring `IntegrationSyncLog`'s proven
 * `(connectorId, eventType, externalReference)` idempotency check
 * (`ADR-062 §0`) — same discipline, a different natural key.
 */
@Entity('attendance_import_batches')
export class AttendanceImportBatch {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  fileHash!: string;

  @Column({ type: 'varchar', length: 255 })
  fileName!: string;

  @Column({ type: 'int' })
  totalRows!: number;

  @Column({ type: 'int' })
  succeededCount!: number;

  @Column({ type: 'int' })
  rejectedCount!: number;

  @Column('uuid')
  importedByUserId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  importedAt!: Date;
}
