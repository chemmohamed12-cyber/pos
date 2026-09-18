import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Numbering Engine — Stage 2 build-order item 17.
 * Daii/architecture/decisions/ADR-007-inventory-ledger.md is unrelated;
 * see ADR-003 §5 and the Baseline audit's TD-29 finding
 * (Daii/_source-audits/baseline/): `baseline`'s numbering counter had no
 * cross-check against real entity data and silently desynced after a
 * backup restore. This is closed structurally here by living in the
 * same transactional Postgres database as the entities it numbers
 * (ADR-020's backup strategy covers both together, not separately) —
 * plus an explicit reconciliation method for the one case that alone
 * doesn't cover: a bulk data import/migration that creates entities
 * without going through this service.
 */
@Entity('numbering_sequences')
export class NumberingSequence {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  documentType!: string;

  @Column({ type: 'varchar', length: 16 })
  prefix!: string;

  @Column({ type: 'boolean', default: true })
  includeYear!: boolean;

  @Column({ type: 'int', default: 0 })
  lastNumber!: number;

  @Column({ type: 'int', nullable: true })
  lastYear!: number | null;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
