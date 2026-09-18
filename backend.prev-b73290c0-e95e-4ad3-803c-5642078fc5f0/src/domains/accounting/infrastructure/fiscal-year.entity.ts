import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * F01 — Financial Foundation (Blueprint §3.3). No `status` column —
 * lifecycle state is always read live via `ProcessEngineService`, same
 * convention as `SalesOrder` (never denormalized). `orgUnitId` nullable:
 * `null` = company-wide/global; set = scoped to one `OrgUnit` (ADR-031).
 * Exactly one `FiscalYear` may be `'active'` per `orgUnitId` scope —
 * enforced at the service layer (`FiscalPeriodService.activateFiscalYear`).
 */
@Entity('accounting_fiscal_years')
export class FiscalYear {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 16 })
  code!: string;

  @Column({ type: 'date' })
  startDate!: string;

  @Column({ type: 'date' })
  endDate!: string;

  @Column({ type: 'uuid', nullable: true })
  orgUnitId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
