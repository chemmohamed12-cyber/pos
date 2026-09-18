import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { DataRepairKind, DataRepairRunStatus } from './data-repair-status';
import { RepairMappingEntry, UuidAuditResult, UuidIntegrityResult } from '../../database/uuid-repair.core';

/**
 * Release Center — Controlled Data Repair. One repair operation, from the
 * read-only audit through to the post-repair integrity verification, with
 * every intermediate artifact frozen on the row so the whole thing is
 * self-documenting evidence: `auditResult` (what was wrong), `mapping`
 * (exactly which id became which — the CTO's "old ID → new RFC UUID"
 * requirement), `integrityResult` (proof nothing broke). The pre-repair
 * backup is linked via `backupRunId` and re-checked as still `verified`
 * before the repair is allowed to run — the same "No Verified Backup → No
 * Deployment" gate the Release Center already enforces for deploys.
 *
 * CTO directive: keep the pre-repair backup + this row (mapping + results)
 * as Release Evidence — do not delete on success.
 */
@Entity('data_repair_runs')
export class DataRepairRun {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 32 })
  kind!: DataRepairKind;

  @Column({ type: 'varchar', length: 16 })
  status!: DataRepairRunStatus;

  /** The mandatory pre-repair verified backup. Null until `linkVerifiedBackup` succeeds; the repair cannot run while null. */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  backupRunId!: string | null;

  /** Frozen read-only audit — per-table non-compliant counts + sample ids, captured at creation. */
  @Column({ type: 'jsonb', nullable: true })
  auditResult!: UuidAuditResult | null;

  /** The reviewable old→new id map. Populated by `plan()`, then applied verbatim by `execute()` so evidence and change are provably identical. */
  @Column({ type: 'jsonb', nullable: true })
  mapping!: RepairMappingEntry[] | null;

  /** Row count actually rewritten by the repair transaction. */
  @Column({ type: 'int', nullable: true })
  rowsRepaired!: number | null;

  /** Frozen post-repair integrity verification — FK-orphan sweep, auth/role integrity, zero-remaining-non-compliant re-audit. */
  @Column({ type: 'jsonb', nullable: true })
  integrityResult!: UuidIntegrityResult | null;

  @Column({ type: 'uuid', nullable: true })
  initiatedByUserId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  startedAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  @Column({ type: 'text', nullable: true })
  errorMessage!: string | null;
}
