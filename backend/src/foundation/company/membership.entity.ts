import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Multi-Company Phase 3 V7, Area 6 (Authorization Boundary). Control-Plane
 * table `user_company_memberships`, also depended on by Area 5 (Company
 * Context in Authentication) — V7's own text there names "the Membership
 * model (Area 6)" as its dependency, so this entity is built here, once,
 * and reused. `(userId, companyId) → roleKey` per V7's literal notation —
 * one membership per user per company, hence the unique pair index.
 * `roleKey` is a plain string reference to a `Role.key` living inside
 * THAT Company's own database — there is no FK across databases (there
 * cannot be one; they are physically separate). The invariant that a
 * membership must resolve to a role that genuinely exists is enforced by
 * sequencing (provisioning seeds the role catalog before any membership
 * can be created), not by a database constraint.
 */
@Entity('user_company_memberships')
@Index(['userId', 'companyId'], { unique: true })
export class Membership {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'uuid' })
  companyId!: string;

  @Column({ type: 'varchar', length: 64 })
  roleKey!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
