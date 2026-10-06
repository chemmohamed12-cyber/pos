import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { CompanyStatus } from './company-status';

/**
 * Company — Multi-Company Phase 3 V7, Area 1 (Installation ↔ Company
 * Model). The Control-Plane child record of the one Installation row
 * (ADR-023's singleton; the Multi-Company ADR set's Installation →
 * Companies (N) direction). Purely additive at creation — no code read
 * this table before Area 2. `status` is typed as `CompanyStatus` per Area
 * 2 (Company Registry); this entity itself still has no transition logic
 * — that lives in `company-status.ts` and `CompanyRegistryService`.
 */
@Entity('companies')
export class Company {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** FK to `installation.id` — enforced at the DB level by this entity's migration. */
  @Index()
  @Column({ type: 'varchar', length: 32 })
  installationId!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'varchar', length: 16 })
  status!: CompanyStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
