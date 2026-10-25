import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Company-level Payroll settings (currently only `sod_profile`: `standard` | `strict`). */
@Entity('payroll_settings')
export class PayrollSetting {
  @PrimaryColumn({ type: 'varchar', length: 48 })
  key!: string;

  @Column({ type: 'varchar', length: 255 })
  value!: string;

  @Column('uuid', { nullable: true })
  updatedByUserId!: string | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;
}
