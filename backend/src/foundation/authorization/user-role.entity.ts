import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Role membership — many-to-many, supporting the multi-role-per-user
 * requirement DAII_SECURITY_ARCHITECTURE.md §2 identifies as a gap in
 * every audited source (each assumed one role per token/session).
 */
@Entity('user_roles')
@Index(['userId', 'roleId'], { unique: true })
export class UserRole {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  userId!: string;

  @Index()
  @Column('uuid')
  roleId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  assignedAt!: Date;
}
