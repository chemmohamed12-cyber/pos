import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { MovementType } from '../domain/movement-type';

/**
 * Append-only ledger (blueprint §18: corrections are new reversing
 * movements, never edits) — no UPDATE/DELETE ever issued against this
 * table in application code.
 */
@Entity('stock_movements')
export class StockMovement {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  warehouseId!: string;

  @Index()
  @Column('uuid')
  productId!: string;

  /** Signed: positive = stock in, negative = stock out. */
  @Column({ type: 'int' })
  quantity!: number;

  /** Widened from 16 to 32 for Gap G-2's 'assembly_consumption' (21 chars) — see AddAssemblyMovementTypeColumnWidth migration. */
  @Column({ type: 'varchar', length: 32 })
  movementType!: MovementType;

  @Column({ type: 'varchar', length: 64, nullable: true })
  referenceType!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  referenceId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  createdByUserId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
