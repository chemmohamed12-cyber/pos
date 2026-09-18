import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { DispositionType } from '../domain/disposition-type';

@Entity('return_dispositions')
export class ReturnDisposition {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column('uuid')
  returnRequestId!: string;

  @Column({ type: 'varchar', length: 16 })
  disposition!: DispositionType;

  @Column({ type: 'varchar', length: 500, nullable: true })
  notes!: string | null;

  @Column('uuid')
  inspectedByUserId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  occurredAt!: Date;
}
