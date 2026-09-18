import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Authentication — Stage 2 build-order item 6.
 * Daii/architecture/DAII_SECURITY_ARCHITECTURE.md §2, ADR-004.
 *
 * Deliberately separate from `users` (Identity, item 5) — Identity owns
 * who an actor is, Authentication owns how they prove it. One row per
 * user; passwordHash only, never plaintext, never logged.
 */
@Entity('credentials')
export class Credential {
  @PrimaryColumn('uuid')
  userId!: string;

  @Column({ type: 'varchar', length: 255 })
  passwordHash!: string;

  @Index()
  @Column({ type: 'timestamptz' })
  passwordChangedAt!: Date;

  /**
   * Security review (master continuation directive) — per-account
   * lockout, closing the second half of the brute-force gap rate
   * limiting alone doesn't cover (an attacker rotating IPs, or simply
   * staying under the per-IP threshold, could still grind through
   * guesses against one specific account indefinitely). Reset to 0 on
   * any successful login or password change; incremented on each failed
   * attempt in `AuthService.login`.
   */
  @Column({ type: 'int', default: 0 })
  failedLoginAttempts!: number;

  /** Set once `failedLoginAttempts` crosses the threshold; null means not locked. Cleared on success. */
  @Column({ type: 'timestamptz', nullable: true })
  lockedUntil!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
