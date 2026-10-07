import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

/**
 * Authorization Foundation F2 — a Company's invitation for an e-mail address to join it with a set of roles. Control-plane table.
 *
 * Deliberately NOT a user and NOT a membership: until the invitation is accepted no identity is created and no membership exists, so an
 * invitation can neither reveal nor create an identity for an unknown e-mail (Blueprint §3: no identity enumeration). Only the SHA-256 of the
 * one-time token is stored; the raw token exists once, in the response to the inviter (`deliveryMode: 'manual'` — there is no mail system yet).
 */
@Entity('company_invitations')
@Index(['companyId', 'status'])
export class CompanyInvitation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  companyId!: string;

  /** Lower-cased, trimmed. */
  @Column({ type: 'varchar', length: 255 })
  email!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  fullName!: string | null;

  @Column({ type: 'jsonb', default: () => `'[]'` })
  roleKeys!: string[];

  @Index({ unique: true })
  @Column({ type: 'char', length: 64 })
  tokenHash!: string;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status!: InvitationStatus;

  @Column({ type: 'uuid' })
  invitedBy!: string;

  @Column({ type: 'varchar', length: 16, default: 'manual' })
  deliveryMode!: 'manual';

  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  acceptedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  acceptedUserId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;
}
