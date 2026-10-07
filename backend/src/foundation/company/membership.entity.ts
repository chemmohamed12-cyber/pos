import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** F2 membership lifecycle. `invited` / `removed` are reserved by the Blueprint: an invitation lives in `company_invitations` (no identity/membership exists until acceptance) and removal deletes the row (audited), so only `active` | `suspended` occur today. */
export type MembershipStatus = 'invited' | 'active' | 'suspended' | 'removed';

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

  /**
   * Read-only COMPATIBILITY MIRROR of the user's role set (F2, Blueprint §4.1). The authority is the Company database's `user_roles`; this
   * is the primary role (`admin` first, else the previous primary if still held, else alphabetical) kept so the pre-F2 consumers
   * (`/memberships/mine`, platform screens, the installation controller) keep working. Never read for an authorization decision.
   */
  @Column({ type: 'varchar', length: 64 })
  roleKey!: string;

  @Column({ type: 'varchar', length: 16, default: 'active' })
  status!: MembershipStatus;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  joinedAt!: Date;

  @Column({ type: 'uuid', nullable: true })
  invitedBy!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastAccessAt!: Date | null;

  /** F4: `member` = a person who belongs to the Company; `support` = a platform user's explicit, reason-required, TIME-BOXED entry with a limited role (never a standing back door). */
  @Column({ type: 'varchar', length: 16, default: 'member' })
  kind!: 'member' | 'support';

  /** Support access ends here; the access guards treat an expired row exactly like a missing one. `null` for ordinary members. */
  @Column({ type: 'timestamptz', nullable: true })
  expiresAt!: Date | null;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  @Column({ type: 'uuid', nullable: true })
  grantedBy!: string | null;

  /** Bumped on every change to the member's roles / status (the cache-invalidation counter the Blueprint's authzVersion becomes). */
  @Column({ type: 'int', default: 1 })
  authzVersion!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
