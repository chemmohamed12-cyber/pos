import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Scope Engine — Stage 2 build-order item 9.
 * Daii/architecture/DAII_PLATFORM_FOUNDATION_CONTRACT.md §5, ADR-005.
 *
 * No source contributed anything here (confirmed gap across all three
 * Stage 0 audits) — this is a full build. Generic on purpose:
 * "which resourceType/resourceId this user may act on," independent of
 * what the resource actually is. Domains (CRM's customer_assignments,
 * item 22; Warehouse's worker-zone assignment, item 27) feed this
 * generic table rather than each domain inventing its own scope check —
 * the richer reassignment-history semantics blueprint §10 wants for
 * Customer Assignment specifically belong to CRM's own domain table,
 * not here; Scope Engine only answers "currently assigned or not."
 */
@Entity('scope_assignments')
@Index(['userId', 'resourceType', 'resourceId'], { unique: true })
export class ScopeAssignment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  userId!: string;

  @Column({ type: 'varchar', length: 64 })
  resourceType!: string;

  @Index()
  @Column({ type: 'varchar', length: 255 })
  resourceId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  assignedAt!: Date;
}
