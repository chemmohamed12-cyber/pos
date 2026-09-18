import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('org_memberships')
@Index(['userId', 'orgUnitId'], { unique: true })
export class OrgMembership {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  userId!: string;

  @Index()
  @Column('uuid')
  orgUnitId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  assignedAt!: Date;
}
