import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('user_locale_preferences')
export class UserLocalePreference {
  @PrimaryColumn('uuid')
  userId!: string;

  @Column({ type: 'varchar', length: 2 })
  language!: 'ar' | 'en';

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
