import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * Sales — Stage 2 build-order item 23. Daii/architecture/DAII_DOMAIN_BOUNDARIES.md §3.
 * Thin by design: Identity (item 5) already owns the user record,
 * Organization (item 10) already owns team/hierarchy membership,
 * Authorization (item 7) already owns the 'sales_rep' role. This table
 * only adds the sales-specific facts: a Sales Code and a territory
 * (free text for now — Geography Engine, a future Foundation capability
 * not yet built, would replace this with a real reference later without
 * changing this contract's shape, per ADR-016).
 */
@Entity('sales_rep_profiles')
export class SalesRepProfile {
  @PrimaryColumn('uuid')
  userId!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  salesCode!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  territory!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'active' })
  status!: 'active' | 'inactive';

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
