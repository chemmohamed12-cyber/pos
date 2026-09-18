import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * Identity — Stage 2 build-order item 5.
 * Daii/architecture/DAII_PLATFORM_FOUNDATION_CONTRACT.md §1.
 *
 * Owns only the canonical actor record. Credentials (password hash,
 * sessions, refresh tokens) belong to Authentication (item 6), not here —
 * this separation is deliberate (Foundation Contract §1 vs §2) so
 * Identity never needs to know how an actor proves who they are.
 *
 * No organization/role linkage yet — Organization (item 10) and
 * Authorization (item 7) don't exist yet. Adding `user_org_memberships`
 * later is additive (ADR-016: L3 contract, L2 coverage now).
 */
export type UserStatus = 'pending' | 'active' | 'disabled' | 'suspended';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 255 })
  fullName!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 255 })
  email!: string;

  @Column({ type: 'varchar', length: 32, nullable: true })
  mobile!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status!: UserStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
