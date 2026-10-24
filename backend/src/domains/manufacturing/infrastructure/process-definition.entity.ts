import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';

export type OperationKind = 'transform' | 'assembly' | 'packing' | 'quality' | 'disassembly' | 'rework' | 'other';
export type ProcessVersionStatus = 'draft' | 'active' | 'retired';
export type OutputRole = 'good' | 'co_product' | 'by_product';

/** Manufacturing Engine S3 — configurable operation-type catalogue (industries add their own; the engine only reasons about `kind`). */
@Entity('mfg_operation_types')
export class OperationType {
  @PrimaryColumn({ type: 'varchar', length: 32 })
  code!: string;

  @Column({ type: 'varchar', length: 120 })
  nameAr!: string;

  @Column({ type: 'varchar', length: 120 })
  nameEn!: string;

  @Column({ type: 'varchar', length: 16 })
  kind!: OperationKind;

  @Column({ type: 'boolean', default: true })
  active!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}

/** One numbered version of the process that makes `productId`; at most one is active per product. */
@Entity('mfg_process_versions')
@Index(['productId', 'versionNo'], { unique: true })
export class ProcessVersion {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid')
  productId!: string;

  @Column({ type: 'int' })
  versionNo!: number;

  @Column({ type: 'varchar', length: 12, default: 'draft' })
  status!: ProcessVersionStatus;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  note!: string | null;

  @Column({ type: 'uuid', nullable: true })
  createdByUserId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  activatedAt!: Date | null;
}

@Entity('mfg_process_operations')
@Index(['versionId', 'code'], { unique: true })
export class ProcessOperation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid')
  versionId!: string;

  @Column({ type: 'varchar', length: 32 })
  code!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'varchar', length: 32 })
  operationTypeCode!: string;

  @Column({ type: 'uuid', nullable: true })
  workCenterId!: string | null;

  @Column({ type: 'int', default: 0 })
  sequenceNo!: number;

  /** An optional operation never blocks its successors and may be skipped. */
  @Column({ type: 'boolean', default: false })
  optional!: boolean;

  /** > 1 makes the operation repeatable (e.g. re-inspection) up to this many runs per order. */
  @Column({ type: 'int', default: 1 })
  maxRuns!: number;
}

@Entity('mfg_process_edges')
@Index(['versionId', 'fromOperationId', 'toOperationId'], { unique: true })
export class ProcessEdge {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid')
  versionId!: string;

  @Column('uuid')
  fromOperationId!: string;

  @Column('uuid')
  toOperationId!: string;
}

@Entity('mfg_process_inputs')
export class ProcessInput {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  versionId!: string;

  @Column('uuid')
  operationId!: string;

  @Column('uuid')
  componentProductId!: string;

  @Column({ type: 'int' })
  quantityPerUnit!: number;

  /** Inputs of one operation sharing a group are alternates — exactly one is chosen when the operation runs. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  alternateGroup!: string | null;
}

@Entity('mfg_process_outputs')
export class ProcessOutput {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  versionId!: string;

  @Column('uuid')
  operationId!: string;

  @Column('uuid')
  productId!: string;

  @Column({ type: 'int' })
  quantityPerUnit!: number;

  @Column({ type: 'varchar', length: 12 })
  role!: OutputRole;

  /** True when the output is consumed by a later operation inside the same order instead of being received into stock. */
  @Column({ type: 'boolean', default: false })
  intermediate!: boolean;

  /** Share of the pooled order cost this output takes at final receipt (0 = carries no value). */
  @Column({ type: 'int', default: 1 })
  allocationWeight!: number;
}
