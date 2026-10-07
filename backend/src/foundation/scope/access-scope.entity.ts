import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Authorization Foundation F6 (Blueprint §9.2) — an explicit ACCESS-SCOPE grant: "this user may work with the data of this organization unit".
 *
 * Distinct from the two things it sits next to:
 *  - `org_memberships` = where the user BELONGS (kept as a scope source for compatibility: ADR-031 treasury scoping has always read it);
 *  - `scope_assignments` = record-level ownership/assignment (rep <-> customer / sales order), unchanged.
 * The unit may be a branch, a warehouse, a department or the Company root (the root grant is the explicit "All company" grant). `includeDescendants` extends the
 * grant to the whole subtree (the default). One row per (user, unit); lives in the COMPANY database, so a scope can never cross Companies.
 */
@Entity('access_scopes')
@Index(['userId', 'orgUnitId'], { unique: true })
export class AccessScope {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  userId!: string;

  @Index()
  @Column('uuid')
  orgUnitId!: string;

  @Column({ type: 'boolean', default: true })
  includeDescendants!: boolean;

  @Column({ type: 'uuid', nullable: true })
  createdBy!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
